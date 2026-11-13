import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardArt } from "./CardArt";
import { LOCATION, POSITION, TYPE, type CardRef, type CardText, type CardView, type Choice, type DuelView, type PlayerView } from "./engine/protocol";

interface Props {
  view: DuelView;
  texts: Map<number, CardText>;
  requestText: (code: number) => void;
  answer: (picks: number[] | null) => void;
  restart: () => void;
  leave: () => void;
}

type Pile = "grave" | "banished" | "extra";
type Sheet = { kind: "card"; card: CardView } | { kind: "pile"; controller: number; pile: Pile } | null;
// the card whose actions float over it, with where it sits on screen
type Focus = { card: CardView; rect: DOMRect } | null;

const HOLD_MS = 450;
const START_LP = 8000;

const same = (a: CardRef, b: CardRef) => a.controller === b.controller && a.location === b.location && a.sequence === b.sequence;
// only cards on the field are ever "set"; the hand and the piles just report a face-down position
const faceDown = (card: CardView) =>
  (card.location === LOCATION.MZONE || card.location === LOCATION.SZONE) && (card.position & (POSITION.FACEDOWN_ATTACK | POSITION.FACEDOWN_DEFENSE)) !== 0;
const sideways = (card: CardView) => card.location === LOCATION.MZONE && (card.position & (POSITION.FACEUP_DEFENSE | POSITION.FACEDOWN_DEFENSE)) !== 0;

function frame(card: CardView): string {
  if (!card.code) return "back";
  if (card.type & TYPE.SPELL) return "spell";
  if (card.type & TYPE.TRAP) return "trap";
  if (card.type & TYPE.LINK) return "link";
  if (card.type & TYPE.XYZ) return "xyz";
  if (card.type & TYPE.SYNCHRO) return "synchro";
  if (card.type & TYPE.FUSION) return "fusion";
  return "monster";
}

// Tap and tap-and-hold on the same element. A hold never also counts as a tap.
function useHold(onTap: (el: HTMLElement) => void, onHold?: () => void) {
  const timer = useRef<number>(0);
  const held = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const clear = () => window.clearTimeout(timer.current);
  return {
    onPointerDown: (event: React.PointerEvent) => {
      held.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      if (!onHold) return;
      clear();
      timer.current = window.setTimeout(() => {
        held.current = true;
        onHold();
      }, HOLD_MS);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (held.current) {
        held.current = false;
        return;
      }
      onTap(event.currentTarget);
    },
  };
}

interface TileProps {
  card: CardView;
  glow?: boolean;
  picked?: boolean;
  focused?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onTap?: (el: HTMLElement) => void;
  onHold?: () => void;
}

function CardTile({ card, glow, picked, focused, className, style, onTap, onHold }: TileProps) {
  const hidden = !card.code;
  // the name stays as the tile's content until its picture has arrived
  const [art, setArt] = useState(0);
  const pictured = art === card.code;
  const handlers = useHold((el) => onTap?.(el), onHold);
  const classes = [
    "tile",
    pictured ? "pictured" : "",
    hidden ? "back" : frame(card),
    sideways(card) ? "sideways" : "",
    glow ? "glow" : "",
    picked ? "picked" : "",
    focused ? "focused" : "",
    faceDown(card) && !hidden ? "set" : "",
    className ?? "",
  ];
  return (
    <button className={classes.join(" ")} style={style} {...handlers} aria-label={hidden ? "Face-down card" : card.name}>
      {!hidden && <CardArt key={card.code} code={card.code} onLoad={() => setArt(card.code)} />}
      {!hidden && !pictured && <span className="tile-name">{card.name}</span>}
      {!hidden && (card.type & TYPE.MONSTER) !== 0 && card.location === LOCATION.MZONE && (
        <span className="tile-stats">
          {card.attack}
          {(card.type & TYPE.LINK) === 0 && `/${card.defense}`}
        </span>
      )}
      {card.materials > 0 && <span className="tile-badge">{card.materials}</span>}
    </button>
  );
}

// the top card of a pile, drawn inside the pile's own button
function PileFace({ card }: { card: CardView }) {
  const [art, setArt] = useState(0);
  return (
    <span className={`tile pile-top ${frame(card)} ${art === card.code ? "pictured" : ""}`}>
      <CardArt key={card.code} code={card.code} onLoad={() => setArt(card.code)} />
    </span>
  );
}

function LifeBar({ name, lp, extra, mine, active, children }: { name: string; lp: number; extra?: string; mine?: boolean; active: boolean; children?: ReactNode }) {
  const fill = Math.max(0, Math.min(1, lp / START_LP));
  return (
    <div className={`lifebar ${mine ? "mine" : "theirs"} ${active ? "active" : ""}`}>
      {children}
      <div className="lifebar-body">
        <div className="lifebar-head">
          <span className="lifebar-name">{name}</span>
          {extra && <span className="lifebar-extra">{extra}</span>}
          <span className="lifebar-lp">{lp}</span>
        </div>
        <div className="lifebar-track">
          <div className="lifebar-fill" style={{ width: `${fill * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

const PHASE_SHORT: Record<string, string> = { Draw: "DP", Standby: "SP", "Main 1": "M1", Battle: "BP", Damage: "BP", "Main 2": "M2", End: "EP" };

export function Duel({ view, texts, requestText, answer, restart, leave }: Props) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [phaseOpen, setPhaseOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picks, setPicks] = useState<number[]>([]);
  const prompt = view.prompt;

  // a new prompt starts with nothing picked and nothing open
  useEffect(() => {
    setPicks([]);
    setSheet(null);
    setFocus(null);
    setPhaseOpen(false);
  }, [prompt]);

  const idle = prompt?.kind === "choice" && prompt.idle;
  const zonePrompt = prompt?.kind === "multi" && prompt.choices.every((choice) => choice.zone);
  const choices = prompt?.choices ?? [];

  const actionsFor = (card: CardRef) => choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.card && same(choice.card, card));
  const hasAction = (card: CardRef) => !!prompt && !zonePrompt && choices.some((choice) => choice.card && same(choice.card, card));
  const zoneIndex = (zone: CardRef) => (zonePrompt ? choices.findIndex((choice) => choice.zone && same(choice.zone, zone)) : -1);
  const isPicked = (card: CardRef) => prompt?.kind === "multi" && !zonePrompt && picks.some((pick) => choices[pick].card && same(choices[pick].card!, card));

  const togglePick = (index: number) => {
    if (prompt?.kind !== "multi") return;
    const next = picks.includes(index) ? picks.filter((pick) => pick !== index) : [...picks, index];
    if (next.length > prompt.max) return;
    // nothing left to decide: send it without a confirm tap
    if (next.length === prompt.max && prompt.min === prompt.max) answer(next);
    else setPicks(next);
  };

  const showDetail = (card: CardView) => {
    if (card.code) requestText(card.code);
    setFocus(null);
    setPhaseOpen(false);
    setSheet({ kind: "card", card });
  };

  // tap: pick it, or float its actions over it; a card with nothing to do shows its text
  const tapCard = (card: CardView, el: HTMLElement) => {
    setPhaseOpen(false);
    if (prompt?.kind === "multi" && !zonePrompt) {
      const index = choices.findIndex((choice) => choice.card && same(choice.card, card));
      if (index >= 0) return togglePick(index);
    }
    if (focus && same(focus.card, card)) return setFocus(null);
    if ((idle || prompt?.kind === "choice") && actionsFor(card).length > 0) {
      if (card.code) requestText(card.code);
      return setFocus({ card, rect: el.getBoundingClientRect() });
    }
    showDetail(card);
  };

  const fieldCard = (card: CardView, index: number) => (
    <CardTile
      card={card}
      glow={hasAction(card)}
      picked={isPicked(card)}
      focused={!!focus && same(focus.card, card)}
      onTap={(el) => (index >= 0 ? togglePick(index) : tapCard(card, el))}
      onHold={() => showDetail(card)}
    />
  );

  const zone = (player: PlayerView, controller: number, location: number, sequence: number, extraClass = "") => {
    const card = (location === LOCATION.MZONE ? player.monsters : player.spells)[sequence] ?? null;
    const ref = { controller, location, sequence };
    const index = zoneIndex(ref);
    return (
      <div
        className={`zone ${extraClass} ${index >= 0 ? "open" : ""} ${picks.includes(index) ? "picked" : ""}`}
        key={`${controller}-${location}-${sequence}`}
        onClick={index >= 0 && !card ? () => togglePick(index) : undefined}
      >
        {card && fieldCard(card, index)}
      </div>
    );
  };

  const pile = (controller: number, name: Pile | "deck") => {
    const player = view.players[controller];
    const cards = name === "deck" ? [] : player[name];
    const count = name === "deck" ? player.deck : cards.length;
    const top = name === "grave" || name === "banished" ? cards[cards.length - 1] : undefined;
    const label = { deck: "Deck", grave: "GY", banished: "Banished", extra: "Extra" }[name];
    const open = name !== "deck" && count > 0 ? () => setSheet({ kind: "pile", controller, pile: name }) : undefined;
    return (
      <button key={`${controller}-${name}`} className={`zone pile pile-${name} ${cards.some(hasAction) ? "glow" : ""}`} onClick={open} disabled={!open} aria-label={`${label} ${count}`}>
        {count > 0 && (top ? <PileFace card={top} /> : <span className="tile back pile-top" />)}
        <span className="pile-label">{label}</span>
        <span className="pile-count">{count}</span>
      </button>
    );
  };

  // 7 columns: a side column on each edge for the piles and the field zone, the 5 zones between them.
  // The opponent sits across the table, so their side is the same picture turned around.
  const me = view.players[0];
  const them = view.players[1];
  const extraZone = (mine: number) => {
    const theirs = mine === 5 ? 6 : 5;
    if (them.monsters[theirs]) return zone(them, 1, LOCATION.MZONE, theirs, "emz");
    return zone(me, 0, LOCATION.MZONE, mine, "emz");
  };
  const mainRow = (controller: number, location: number) => {
    const player = view.players[controller];
    const order = controller === 0 ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];
    return order.map((sequence) => zone(player, controller, location, sequence));
  };

  const phaseChoices = idle ? choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.phase) : [];
  const pickButton = (choice: Choice, index: number, className = "button") => (
    <button className={className} key={index} onClick={() => answer([index])}>
      {choice.label}
    </button>
  );

  // the floating actions go above the card, or below it when there is no room above
  const floatRef = useRef<HTMLDivElement>(null);
  const [floatPos, setFloatPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!focus || !floatRef.current) return setFloatPos(null);
    const box = floatRef.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, focus.rect.left + focus.rect.width / 2 - box.width / 2), window.innerWidth - box.width - margin);
    const above = focus.rect.top - box.height - margin;
    const top = above >= margin ? above : Math.min(focus.rect.bottom + margin, window.innerHeight - box.height - margin);
    setFloatPos({ left, top });
  }, [focus]);

  const sheetBody = useMemo(() => {
    if (sheet?.kind === "card") {
      const text = texts.get(sheet.card.code);
      const actions = idle || prompt?.kind === "choice" ? actionsFor(sheet.card) : [];
      return (
        <>
          <div className="sheet-head">
            <CardArt key={sheet.card.code} code={sheet.card.code} />
            <div>
              <h2>{sheet.card.code ? sheet.card.name : "Face-down card"}</h2>
              {text?.line && <p className="muted">{text.line}</p>}
            </div>
          </div>
          {actions.length > 0 && <div className="actions">{actions.map(({ choice, index }) => pickButton(choice, index))}</div>}
          {text?.text && <p className="card-text">{text.text}</p>}
          <button className="button ghost" onClick={() => setSheet(null)}>
            Close
          </button>
        </>
      );
    }
    if (sheet?.kind === "pile") {
      const cards = view.players[sheet.controller][sheet.pile];
      return (
        <>
          <h2>
            {sheet.controller === 1 ? "Opponent's " : ""}
            {sheet.pile === "grave" ? "Graveyard" : sheet.pile === "banished" ? "Banished" : "Extra Deck"}
          </h2>
          <div className="pile-grid">
            {cards.map((card, index) => (
              <CardTile
                key={index}
                card={card}
                glow={hasAction(card)}
                picked={isPicked(card)}
                onTap={() => {
                  if (prompt?.kind === "multi" && !zonePrompt) {
                    const pick = choices.findIndex((choice) => choice.card && same(choice.card, card));
                    if (pick >= 0) return togglePick(pick);
                  }
                  showDetail(card);
                }}
                onHold={() => showDetail(card)}
              />
            ))}
          </div>
          <button className="button ghost" onClick={() => setSheet(null)}>
            Close
          </button>
        </>
      );
    }
    if (!prompt || idle || zonePrompt) return null;
    if (prompt.kind === "choice") {
      return (
        <>
          <h2>{prompt.title}</h2>
          <div className="actions">{prompt.choices.map((choice, index) => pickButton(choice, index))}</div>
          {prompt.cancel && (
            <button className="button ghost" onClick={() => answer(null)}>
              {prompt.cancel}
            </button>
          )}
        </>
      );
    }
    const ready = picks.length >= prompt.min && picks.length <= prompt.max;
    return (
      <>
        <h2>
          {prompt.title} ({prompt.min === prompt.max ? prompt.min : `${prompt.min}-${prompt.max}`})
        </h2>
        <div className="list">
          {prompt.choices.map((choice, index) => (
            <button className={`list-row ${picks.includes(index) ? "picked" : ""}`} key={index} onClick={() => togglePick(index)}>
              {choice.label}
            </button>
          ))}
        </div>
        <div className="actions">
          <button className="button primary" disabled={!ready} onClick={() => answer(picks)}>
            Confirm
          </button>
          {prompt.cancel && (
            <button className="button ghost" onClick={() => answer(null)}>
              Cancel
            </button>
          )}
        </div>
      </>
    );
  }, [sheet, prompt, picks, texts, view]);

  // the hand fans out from the bottom edge; with many cards they overlap more
  const handRef = useRef<HTMLDivElement>(null);
  const [handWidth, setHandWidth] = useState(360);
  useLayoutEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHandWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const cardWidth = Math.min(108, Math.max(72, handWidth / 4.2));
  const count = me.hand.length;
  const step = count > 1 ? Math.min(cardWidth * 0.92, (handWidth - cardWidth - 28) / (count - 1)) : 0;

  const focusActions = focus ? actionsFor(focus.card) : [];
  const myTurn = view.turnPlayer === 0;

  return (
    // a tap anywhere else closes the floating actions and the menus
    <div className="duel" onClick={() => (setFocus(null), setPhaseOpen(false), setMenuOpen(false))}>
      <LifeBar name="Opponent" lp={them.lp} extra={`Hand ${them.hand.length}`} active={!myTurn}>
        <button className="icon-button" aria-label="Menu" onClick={(event) => (event.stopPropagation(), setMenuOpen(!menuOpen))}>
          ☰
        </button>
      </LifeBar>
      {menuOpen && (
        <div className="menu" onClick={() => setMenuOpen(false)}>
          <button className="button" onClick={restart}>
            New hand
          </button>
          <button className="button ghost" onClick={leave}>
            Exit
          </button>
        </div>
      )}

      <div className="board">
        <div className="field-area">
          <div className="field">
            {pile(1, "deck")}
            {mainRow(1, LOCATION.SZONE)}
            {pile(1, "extra")}

            {pile(1, "grave")}
            {mainRow(1, LOCATION.MZONE)}
            {zone(them, 1, LOCATION.SZONE, 5, "fieldzone")}

            {pile(1, "banished")}
            <div className="zone none" />
            {extraZone(5)}
            <div className="zone none" />
            {extraZone(6)}
            <div className="zone none" />
            {pile(0, "banished")}

            {zone(me, 0, LOCATION.SZONE, 5, "fieldzone")}
            {mainRow(0, LOCATION.MZONE)}
            {pile(0, "grave")}

            {pile(0, "extra")}
            {mainRow(0, LOCATION.SZONE)}
            {pile(0, "deck")}
          </div>
        </div>

        <div className="board-foot">
          <div className="phase-dock">
            <button
              className={`phase-button ${phaseChoices.length ? "ready" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                setFocus(null);
                if (phaseChoices.length) setPhaseOpen(!phaseOpen);
              }}
              aria-label={`Phase: ${view.phase}`}
            >
              <span className="phase-short">{PHASE_SHORT[view.phase] ?? view.phase}</span>
              <span className="phase-turn">T{view.turn}</span>
            </button>
            {phaseOpen && <div className="phase-menu">{phaseChoices.map(({ choice, index }) => pickButton(choice, index, "button primary"))}</div>}
          </div>
        </div>

        {zonePrompt && <p className="banner">{prompt!.title}: tap a highlighted zone</p>}
        {view.ended && <p className="banner">The duel has ended.</p>}
      </div>

      <LifeBar name="You" lp={me.lp} mine active={myTurn} />

      <div className="hand" ref={handRef}>
        {me.hand.map((card, i) => {
          const offset = i - (count - 1) / 2;
          const lifted = (focus && same(focus.card, card)) || isPicked(card);
          return (
            <CardTile
              key={card.sequence}
              card={card}
              className="hand-card"
              style={{
                width: cardWidth,
                left: `calc(50% + ${offset * step - cardWidth / 2}px)`,
                transform: `translateY(${Math.abs(offset) * Math.abs(offset) * 2 - (lifted ? 22 : 0)}px) rotate(${offset * (count > 6 ? 2 : 3)}deg)`,
                zIndex: lifted ? 50 : i + 1,
              }}
              glow={hasAction(card)}
              picked={isPicked(card)}
              focused={!!focus && same(focus.card, card)}
              onTap={(el) => tapCard(card, el)}
              onHold={() => showDetail(card)}
            />
          );
        })}
      </div>

      {focus && focusActions.length > 0 && (
        <>
          <div className="scrim" onClick={() => setFocus(null)} />
          <div className="float-actions" ref={floatRef} style={floatPos ? { left: floatPos.left, top: floatPos.top } : { visibility: "hidden" }}>
            {focusActions.map(({ choice, index }) => pickButton(choice, index, "float-action"))}
            <button className="float-action info" onClick={() => showDetail(focus.card)}>
              Card text
            </button>
          </div>
        </>
      )}

      {sheetBody && (
        <>
          {sheet && <div className="scrim dim" onClick={() => setSheet(null)} />}
          <div className="sheet">{sheetBody}</div>
        </>
      )}
    </div>
  );
}
