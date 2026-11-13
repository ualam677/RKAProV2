import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardArt } from "./CardArt";
import { LOCATION, POSITION, TYPE, sumReady, sumSoFar, type CardRef, type CardText, type CardView, type Choice, type DuelEvent, type DuelView, type PlayerView } from "./engine/protocol";

interface Props {
  view: DuelView;
  texts: Map<number, CardText>;
  requestText: (code: number) => void;
  answer: (picks: number[] | null) => void;
  restart: () => void;
  leave: () => void;
  // jump past the animations still waiting to play
  skip: () => void;
  // "This worked": keeps the test and the board it ended on; undefined while nothing has been played yet
  worked: boolean;
  onWorked?: () => void;
  // a saved test playing back: where it is, and stopping it to play on yourself
  replaying: { at: number; of: number; stop: () => void } | null;
  // save states: keep this moment, or go back to one kept earlier
  states: { id: string; name: string; date: number }[];
  onSaveState: () => string | undefined;
  onLoadState: (id: string) => void;
}

// How long each moment stays on screen, close to EDOPro's own pacing.
const CUE_MS: Record<DuelEvent["kind"], number> = {
  activate: 650,
  resolve: 420,
  summon: 320,
  added: 520,
  draw: 300,
  negated: 650,
  reveal: 750,
  coin: 900,
  dice: 900,
  attack: 380,
  message: 1400,
  phase: 550,
};
export const cueTime = (events: DuelEvent[]) => events.reduce((longest, event) => Math.max(longest, CUE_MS[event.kind]), 0);

type Pile = "grave" | "banished" | "extra";
type Sheet = { kind: "card"; card: CardView } | { kind: "pile"; controller: number; pile: Pile } | null;
// the card whose actions float over it, with where it sits on screen
type Focus = { card: CardView; rect: DOMRect } | null;

const HOLD_MS = 350;
const START_LP = 8000;
// wide screens get EDOPro's arrangement: card info on the left, the field in the middle, a flat hand
const WIDE_QUERY = "(min-width: 900px) and (min-aspect-ratio: 1/1)";

const same = (a: CardRef, b: CardRef) => a.controller === b.controller && a.location === b.location && a.sequence === b.sequence;
// cards the player can see and tap where they are; anything else is picked from a grid of cards
const onBoard = (card: CardRef) => card.location === LOCATION.MZONE || card.location === LOCATION.SZONE || (card.location === LOCATION.HAND && card.controller === 0);
// only cards on the field are ever "set"; the hand and the piles just report a face-down position
const faceDown = (card: CardView) =>
  (card.location === LOCATION.MZONE || card.location === LOCATION.SZONE) && (card.position & (POSITION.FACEDOWN_ATTACK | POSITION.FACEDOWN_DEFENSE)) !== 0;
const sideways = (card: CardView) => card.location === LOCATION.MZONE && (card.position & (POSITION.FACEUP_DEFENSE | POSITION.FACEDOWN_DEFENSE)) !== 0;

function frame(card: { code: number; type: number }): string {
  if (!card.code) return "back";
  if (card.type & TYPE.SPELL) return "spell";
  if (card.type & TYPE.TRAP) return "trap";
  if (card.type & TYPE.LINK) return "link";
  if (card.type & TYPE.XYZ) return "xyz";
  if (card.type & TYPE.SYNCHRO) return "synchro";
  if (card.type & TYPE.FUSION) return "fusion";
  return "monster";
}

// ★8 for a Level, ☆4 for a Rank, L3 for a Link Rating, as on the card itself
function levelLabel(card: { type: number; level: number }): string {
  const value = card.level & 0xff;
  if (card.type & TYPE.LINK) return `L${value}`;
  if (card.type & TYPE.XYZ) return `☆${value}`;
  return `★${value}`;
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
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
  // waiting to be picked: the border pulses until it is
  pulse?: boolean;
  picked?: boolean;
  focused?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onTap?: (el: HTMLElement) => void;
  onHold?: () => void;
  onHover?: () => void;
  caption?: string;
}

function CardTile({ card, glow, pulse, picked, focused, className, style, onTap, onHold, onHover, caption }: TileProps) {
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
    pulse && !picked ? "pulse" : "",
    picked ? "picked" : "",
    focused ? "focused" : "",
    faceDown(card) && !hidden ? "set" : "",
    className ?? "",
  ];
  return (
    <button className={classes.join(" ")} style={style} {...handlers} onPointerEnter={onHover} aria-label={hidden ? "Face-down card" : card.name}>
      {!hidden && <CardArt key={card.code} code={card.code} onLoad={() => setArt(card.code)} />}
      {!hidden && !pictured && <span className="tile-name">{card.name}</span>}
      {card.materials > 0 && <span className="tile-badge">{card.materials}</span>}
      {caption && <span className="tile-caption">{caption}</span>}
    </button>
  );
}

// the top card of a pile, filling the pile's box; a card back for the Deck and Extra Deck
function PileFace({ card }: { card?: CardView }) {
  const [art, setArt] = useState(0);
  if (!card) return <span className="pile-face back" />;
  return (
    <span className={`pile-face ${frame(card)}`}>
      <CardArt key={card.code} code={card.code} onLoad={() => setArt(card.code)} />
      {art !== card.code && <span className="pile-face-name">{card.name}</span>}
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

// card picture, name, stats line and text: the detail sheet on phones, the left panel on wide screens
function CardInfo({ card, text, materials, children }: { card: CardView | null; text?: CardText; materials?: string[]; children?: ReactNode }) {
  if (!card) return <p className="muted info-empty">Tap or point at a card to read it.</p>;
  return (
    <>
      <div className="info-head">
        <div className="info-art">{card.code ? <CardArt key={card.code} code={card.code} /> : null}</div>
        <div>
          <h2>{card.code ? card.name : "Face-down card"}</h2>
          {text?.line && <p className="muted">{text.line}</p>}
          {card.counters.map((counter) => (
            <p className="muted" key={counter.name}>
              {counter.name}: <b>{counter.count}</b>
            </p>
          ))}
        </div>
      </div>
      {materials && materials.length > 0 && (
        <p className="muted">
          Materials: <b>{materials.join(", ")}</b>
        </p>
      )}
      {children}
      {text?.text && <p className="card-text">{text.text}</p>}
    </>
  );
}

const PHASE_SHORT: Record<string, string> = { Draw: "DP", Standby: "SP", "Main 1": "M1", Battle: "BP", Damage: "BP", "Main 2": "M2", End: "EP" };

// DP SP M1 BP M2 EP, the current one lit, in your colour or the opponent's (EDOPro's phase bar)
const TRACK = ["Draw", "Standby", "Main 1", "Battle", "Main 2", "End"];
function PhaseTrack({ phase, mine }: { phase: string; mine: boolean }) {
  const now = phase === "Damage" ? "Battle" : phase;
  return (
    <div className={`phase-track ${mine ? "mine" : "theirs"}`} aria-label={`${mine ? "Your" : "Opponent's"} ${phase} Phase`}>
      {TRACK.map((name) => (
        <span key={name} className={name === now ? "on" : ""}>
          {PHASE_SHORT[name]}
        </span>
      ))}
    </div>
  );
}

// What happened just now, drawn over the board: the activated card in the middle, a resolving chain link,
// a burst on a summoned monster's zone, a card added to the hand.
function Cues({ events, onSkip }: { events: DuelEvent[]; onSkip: () => void }) {
  const activate = events.filter((event) => event.kind === "activate").pop();
  const resolve = events.filter((event) => event.kind === "resolve").pop();
  const added = events.filter((event) => event.kind === "added");
  const negated = events.filter((event) => event.kind === "negated").pop();
  const revealed = events.filter((event) => event.kind === "reveal");
  // coins, dice and the core's messages are a line of text
  const notes = events.filter((event) => event.kind === "coin" || event.kind === "dice" || event.kind === "message");
  // a new phase, yours or the opponent's, as EDOPro shows it
  const phaseCue = events.filter((event) => event.kind === "phase").pop();
  // the last view of a play keeps its events, so the cue hides itself once it has been seen
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const hide = window.setTimeout(() => setShown(false), cueTime(events));
    return () => window.clearTimeout(hide);
  }, [events]);
  if (!shown || (!activate && !resolve && !negated && !added.length && !revealed.length && !notes.length && !phaseCue)) return null;
  return (
    <div className="cues" onClick={(event) => (event.stopPropagation(), onSkip())}>
      {phaseCue && !activate && (
        <div className={`cue-phase ${phaseCue.controller === 0 ? "mine" : "theirs"}`} key={`p${phaseCue.text}`}>
          {phaseCue.text}
        </div>
      )}
      {activate && (
        <div className="cue-activate" key={`a${activate.chain}-${activate.code}`}>
          <span className="cue-chain">Chain {activate.chain}</span>
          <div className="cue-card">
            <CardArt code={activate.code} />
            <span className="cue-card-name">{activate.name}</span>
          </div>
          <span className="cue-label">{activate.text || "Activate"}</span>
        </div>
      )}
      {!activate && negated && (
        <div className="cue-negated" key={`n${negated.chain}-${negated.code}`}>
          <div className="cue-card small">
            <CardArt code={negated.code} />
            <span className="cue-card-name">{negated.name}</span>
          </div>
          <span className="cue-stamp">{negated.text}</span>
        </div>
      )}
      {!activate && !negated && resolve && (
        <div className="cue-resolve" key={`r${resolve.chain}-${resolve.code}`}>
          <div className="cue-thumb">
            <CardArt code={resolve.code} />
          </div>
          <span>
            <b>Chain {resolve.chain}</b> resolving
            <br />
            {resolve.name}
          </span>
        </div>
      )}
      {added.length > 0 && (
        <div className="cue-added">
          {added.map((card, index) => (
            <div className="cue-thumb" key={index}>
              <CardArt code={card.code} />
              <span className="cue-card-name">{card.name}</span>
            </div>
          ))}
          <span className="cue-label">Added to hand</span>
        </div>
      )}
      {revealed.length > 0 && (
        <div className="cue-added">
          {revealed.map((card, index) => (
            <div className="cue-thumb" key={index}>
              <CardArt code={card.code} />
              <span className="cue-card-name">{card.name}</span>
            </div>
          ))}
          <span className="cue-label">Revealed</span>
        </div>
      )}
      {notes.map((note, index) => (
        <span className="cue-label cue-note" key={index}>
          {note.text}
        </span>
      ))}
    </div>
  );
}

export function Duel({ view, texts, requestText, answer, restart, leave, skip, worked, onWorked, replaying, states, onSaveState, onLoadState }: Props) {
  const [stateList, setStateList] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const wide = useMedia(WIDE_QUERY);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [info, setInfo] = useState<CardView | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [phaseOpen, setPhaseOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [promptHidden, setPromptHidden] = useState(false);
  const [picks, setPicks] = useState<number[]>([]);
  const prompt = view.prompt;

  // a new prompt starts with nothing picked and nothing open
  useEffect(() => {
    setPicks([]);
    setSheet(null);
    setFocus(null);
    setPhaseOpen(false);
    setPromptHidden(false);
  }, [prompt]);

  const idle = prompt?.kind === "choice" && prompt.idle;
  const choices = prompt?.choices ?? [];
  const zonePrompt = prompt?.kind === "multi" && choices.length > 0 && choices.every((choice) => choice.zone);
  const cardPrompt = !!prompt && !idle && choices.length > 0 && choices.every((choice) => choice.card);
  // how a prompt is shown: on the board itself, as a grid of cards, or as a small dialog of buttons
  const promptMode: "none" | "board" | "grid" | "dialog" | "announce" = !prompt || idle ? "none" : prompt.kind === "announce" ? "announce" : prompt.kind === "counter" ? "dialog" : zonePrompt || (cardPrompt && choices.every((choice) => onBoard(choice.card!))) ? "board" : cardPrompt ? "grid" : "dialog";

  const actionsFor = (card: CardRef) => choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.card && same(choice.card, card));
  const hasAction = (card: CardRef) => !!prompt && !zonePrompt && choices.some((choice) => choice.card && same(choice.card, card));
  const zoneIndex = (zone: CardRef) => (zonePrompt ? choices.findIndex((choice) => choice.zone && same(choice.zone, zone)) : -1);
  const isPicked = (card: CardRef) =>
    (prompt?.kind === "multi" && !zonePrompt && picks.some((pick) => choices[pick].card && same(choices[pick].card!, card))) ||
    choices.some((choice) => choice.picked && choice.card && same(choice.card, card));

  // a prompt that is only about picking cards (materials, tributes, targets)
  const pickPrompt = (prompt?.kind === "multi" && !zonePrompt) || (prompt?.kind === "choice" && !idle && choices.some((choice) => choice.pick));

  const togglePick = (index: number) => {
    if (prompt?.kind !== "multi") return;
    const next = picks.includes(index) ? picks.filter((pick) => pick !== index) : [...picks, index];
    if (next.length > prompt.max) return;
    // adding up to a total: sent as soon as the total is right (any more cards would be one too many)
    if (prompt.sum) {
      if (sumReady(prompt.sum, next) && next.length >= prompt.min) answer(next);
      else setPicks(next);
      return;
    }
    // nothing left to decide: send it without a confirm tap
    if (next.length === prompt.max && prompt.min === prompt.max) answer(next);
    else setPicks(next);
  };

  const materialNames = (card: CardView) => card.overlay.map((code) => texts.get(code)?.name ?? "…");
  const inspect = (card: CardView) => {
    if (card.code) requestText(card.code);
    card.overlay.forEach(requestText);
    setInfo(card);
  };

  const showDetail = (card: CardView) => {
    inspect(card);
    setFocus(null);
    setPhaseOpen(false);
    // the wide layout always has the card panel open
    if (!wide) setSheet({ kind: "card", card });
  };

  // tap: pick it, or float its actions over it; a card with nothing to do shows its text
  const tapCard = (card: CardView, el: HTMLElement) => {
    setPhaseOpen(false);
    if (prompt?.kind === "multi" && !zonePrompt) {
      const index = choices.findIndex((choice) => choice.card && same(choice.card, card));
      if (index >= 0) {
        inspect(card);
        return togglePick(index);
      }
    }
    if (focus && same(focus.card, card)) return setFocus(null);
    const actions = actionsFor(card);
    // picking materials or targets: the tap is the answer
    if (prompt?.kind === "choice" && !idle && actions.length === 1 && actions[0].choice.pick) {
      inspect(card);
      return answer([actions[0].index]);
    }
    if (prompt?.kind === "choice" && actions.length > 0) {
      inspect(card);
      return setFocus({ card, rect: el.getBoundingClientRect() });
    }
    showDetail(card);
  };

  const fieldCard = (card: CardView, index: number) => (
    <CardTile
      card={card}
      glow={hasAction(card)}
      pulse={pickPrompt && hasAction(card)}
      picked={isPicked(card)}
      focused={!!focus && same(focus.card, card)}
      onTap={(el) => (index >= 0 ? togglePick(index) : tapCard(card, el))}
      onHold={() => showDetail(card)}
      onHover={wide ? () => inspect(card) : undefined}
    />
  );

  const zone = (player: PlayerView, controller: number, location: number, sequence: number, extraClass = "") => {
    const card = (location === LOCATION.MZONE ? player.monsters : player.spells)[sequence] ?? null;
    const ref = { controller, location, sequence };
    const index = zoneIndex(ref);
    const cue =
      view.events.find((event) => same(event, ref) && event.kind !== "added" && event.kind !== "reveal") ??
      (view.events.some((event) => event.kind === "attack" && event.target && same(event.target, ref)) ? { kind: "attacked" } : undefined);
    return (
      <div
        className={`zone ${extraClass} ${index >= 0 ? "open" : ""} ${picks.includes(index) ? "picked" : ""} ${cue ? `cue-${cue.kind}` : ""}`}
        key={`${controller}-${location}-${sequence}`}
        onClick={index >= 0 && !card ? (event) => (event.stopPropagation(), togglePick(index)) : undefined}
      >
        {card && fieldCard(card, index)}
        {card && card.code !== 0 && (card.type & TYPE.MONSTER) !== 0 && location === LOCATION.MZONE ? (
          <>
            <span className="zone-level">{levelLabel(card)}</span>
            {card.counters.length > 0 && <span className="zone-counters">{card.counters.reduce((sum, counter) => sum + counter.count, 0)}</span>}
            <span className="zone-stats">
              {card.attack}
              {(card.type & TYPE.LINK) === 0 && <span className="def">/{card.defense}</span>}
            </span>
          </>
        ) : null}
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
      <button
        key={`${controller}-${name}`}
        className={`zone pile pile-${name} ${count === 0 ? "empty" : ""} ${cards.some(hasAction) ? "glow" : ""}`}
        onClick={open && ((event) => (event.stopPropagation(), open()))}
        disabled={!open}
        aria-label={`${label} ${count}`}
      >
        {count > 0 && <PileFace card={top} />}
        <span className="pile-info">
          <span className="pile-label">{label}</span>
          <b className="pile-count">{count}</b>
        </span>
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
    <button
      className={className}
      key={index}
      onClick={(event) => {
        event.stopPropagation();
        answer([index]);
      }}
    >
      {choice.label}
    </button>
  );

  // the floating actions go above the card, or below it when there is no room above
  const floatRef = useRef<HTMLDivElement>(null);
  const [floatPos, setFloatPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!focus || !floatRef.current) return setFloatPos(null);
    const box = floatRef.current.getBoundingClientRect();
    // a hand card lifts when it is picked, after its place was measured
    const margin = focus.card.location === LOCATION.HAND ? 30 : 8;
    const left = Math.min(Math.max(8, focus.rect.left + focus.rect.width / 2 - box.width / 2), window.innerWidth - box.width - 8);
    const above = focus.rect.top - box.height - margin;
    const top = above >= 8 ? above : Math.min(focus.rect.bottom + 8, window.innerHeight - box.height - 8);
    setFloatPos({ left, top });
  }, [focus]);

  const ready =
    prompt?.kind === "multi" && picks.length >= prompt.min && picks.length <= prompt.max && (!prompt.sum || sumReady(prompt.sum, picks));
  const cancelLabel = prompt?.kind === "choice" ? prompt.cancel : prompt?.kind === "multi" && prompt.cancel ? "Cancel" : null;
  const count =
    prompt?.kind === "multi"
      ? prompt.sum
        ? `${sumSoFar(prompt.sum, picks)}/${prompt.sum.target}`
        : prompt.min === prompt.max
          ? `${prompt.min}`
          : `${prompt.min}-${prompt.max}`
      : "";
  const promptButtons = (
    <>
      {prompt?.kind === "multi" && (prompt.min !== prompt.max || !!prompt.sum) && (
        <button className="button primary" disabled={!ready} onClick={(event) => (event.stopPropagation(), answer(picks))}>
          Confirm{picks.length ? ` (${picks.length})` : ""}
        </button>
      )}
      {cancelLabel && (
        <button className="button ghost" onClick={(event) => (event.stopPropagation(), answer(null))}>
          {cancelLabel}
        </button>
      )}
    </>
  );

  // the question asked by a board prompt sits in a slim bar above the hand, so nothing is covered
  const promptBar =
    promptMode === "board" ? (
      <div className="prompt-bar" onClick={(event) => event.stopPropagation()}>
        <span className="prompt-title">
          {zonePrompt ? `${prompt!.title}: tap a highlighted zone` : prompt!.title}
          {count && !zonePrompt && <b> ({count})</b>}
        </span>
        {promptButtons}
      </div>
    ) : (promptMode === "grid" || promptMode === "dialog" || promptMode === "announce") && promptHidden ? (
      <div className="prompt-bar" onClick={(event) => event.stopPropagation()}>
        <span className="prompt-title">{prompt!.title}</span>
        <button className="button primary" onClick={() => setPromptHidden(false)}>
          Back to choice
        </button>
      </div>
    ) : null;

  // a selection window with the cards themselves, like EDOPro's
  const promptGrid = promptMode === "grid" && !promptHidden && (
    <div className="sheet prompt-sheet" onClick={(event) => event.stopPropagation()}>
      <div className="sheet-title">
        <h2>
          {prompt!.title}
          {count && <b> ({count})</b>}
        </h2>
        <button className="button ghost small" onClick={() => setPromptHidden(true)}>
          View field
        </button>
      </div>
      <div className="card-grid">
        {choices.map((choice, index) => {
          const ref = choice.card!;
          const card: CardView = { ...ref, type: ref.type ?? 0, attack: 0, defense: 0, level: 0, position: POSITION.FACEUP_ATTACK, materials: 0, overlay: [], counters: [], location: ref.location };
          const label = choice.label && choice.label !== ref.name ? choice.label.replace(`${ref.name}: `, "") : "";
          return (
            <CardTile
              key={index}
              card={card}
              className="grid-card"
              pulse={pickPrompt}
              picked={picks.includes(index) || !!choice.picked}
              caption={label}
              onTap={() => {
                inspect(card);
                if (prompt!.kind === "multi") togglePick(index);
                else answer([index]);
              }}
              onHold={() => showDetail(card)}
              onHover={wide ? () => inspect(card) : undefined}
            />
          );
        })}
      </div>
      <div className="prompt-actions">{promptButtons}</div>
    </div>
  );

  // declaring a card name: type to narrow the list, tap a name
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [prompt]);
  const announceList = useMemo(() => {
    if (prompt?.kind !== "announce") return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return prompt.options
      .map((option, index) => ({ ...option, index }))
      .filter((option) => words.every((word) => option.name.toLowerCase().includes(word)))
      .slice(0, 80);
  }, [prompt, query]);
  const promptAnnounce = promptMode === "announce" && !promptHidden && prompt?.kind === "announce" && (
    <div className="sheet prompt-sheet" onClick={(event) => event.stopPropagation()}>
      <div className="sheet-title">
        <h2>{prompt.title}</h2>
        <button className="button ghost small" onClick={() => setPromptHidden(true)}>
          View field
        </button>
      </div>
      {prompt.options.length > 12 && (
        <input className="search" type="search" placeholder={`Search ${prompt.options.length.toLocaleString()} cards`} value={query} onChange={(event) => setQuery(event.target.value)} />
      )}
      <div className="list">
        {announceList.map((option) => (
          <button className="list-row" key={option.code} onClick={() => answer([option.index])}>
            {option.name}
          </button>
        ))}
        {announceList.length === 0 && <p className="muted">No card matches.</p>}
      </div>
    </div>
  );

  // removing counters: a stepper per card, sent when the count is right
  const [removing, setRemoving] = useState<number[]>([]);
  useEffect(() => setRemoving(prompt?.kind === "counter" ? prompt.available.map(() => 0) : []), [prompt]);
  const removed = removing.reduce((sum, count) => sum + count, 0);
  const counterDialog = prompt?.kind === "counter" && !promptHidden && (
    <div className="dialog" onClick={(event) => event.stopPropagation()}>
      <h2>
        {prompt.title} ({removed}/{prompt.total})
      </h2>
      <div className="actions">
        {prompt.choices.map((choice, index) => (
          <div className="stepper" key={index}>
            <span>
              {choice.label} <span className="muted">({prompt.available[index]})</span>
            </span>
            <button className="button small" disabled={!removing[index]} onClick={() => setRemoving(removing.map((count, at) => (at === index ? count - 1 : count)))}>
              −
            </button>
            <b>{removing[index] ?? 0}</b>
            <button
              className="button small"
              disabled={removing[index] >= prompt.available[index] || removed >= prompt.total}
              onClick={() => setRemoving(removing.map((count, at) => (at === index ? count + 1 : count)))}
            >
              +
            </button>
          </div>
        ))}
      </div>
      <div className="prompt-actions">
        <button className="button primary" disabled={removed !== prompt.total} onClick={() => answer(removing)}>
          Confirm
        </button>
      </div>
    </div>
  );

  const promptDialog = prompt?.kind === "counter" ? counterDialog : promptMode === "dialog" && !promptHidden && (
    <div className="dialog" onClick={(event) => event.stopPropagation()}>
      <h2>{prompt!.title}</h2>
      <div className="actions">
        {prompt!.kind === "choice"
          ? choices.map((choice, index) => pickButton(choice, index))
          : choices.map((choice, index) => (
              <button className={`list-row ${picks.includes(index) ? "picked" : ""}`} key={index} onClick={() => togglePick(index)}>
                {choice.label}
              </button>
            ))}
      </div>
      <div className="prompt-actions">
        {promptButtons}
        <button className="button ghost small" onClick={() => setPromptHidden(true)}>
          View field
        </button>
      </div>
    </div>
  );

  const sheetBody = (() => {
    if (sheet?.kind === "card") {
      const actions = prompt?.kind === "choice" ? actionsFor(sheet.card) : [];
      return (
        <>
          <CardInfo card={sheet.card} text={texts.get(sheet.card.code)} materials={materialNames(sheet.card)}>
            {actions.length > 0 && <div className="actions">{actions.map(({ choice, index }) => pickButton(choice, index))}</div>}
          </CardInfo>
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
          <div className="card-grid">
            {cards.map((card, index) => (
              <CardTile
                key={index}
                card={card}
                className="grid-card"
                glow={hasAction(card)}
                picked={isPicked(card)}
                onTap={(el) => {
                  if (hasAction(card) || (prompt?.kind === "multi" && !zonePrompt)) {
                    setSheet(null);
                    return tapCard(card, el);
                  }
                  showDetail(card);
                }}
                onHold={() => showDetail(card)}
                onHover={wide ? () => inspect(card) : undefined}
              />
            ))}
          </div>
          <button className="button ghost" onClick={() => setSheet(null)}>
            Close
          </button>
        </>
      );
    }
    return null;
  })();

  // the hand fans out from the bottom edge on phones; wide screens lay it flat like EDOPro
  const handRef = useRef<HTMLDivElement>(null);
  const [handWidth, setHandWidth] = useState(360);
  useLayoutEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHandWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [wide]);
  const cardWidth = wide ? 96 : Math.min(108, Math.max(72, handWidth / 4.2));
  const handCount = me.hand.length;
  // the cards just drawn are the last ones in the hand; they slide in from the Deck
  const drawn = view.events.filter((event) => event.kind === "draw").length;
  const step = handCount > 1 ? Math.min(cardWidth * (wide ? 1.06 : 0.92), (handWidth - cardWidth - 28) / (handCount - 1)) : 0;

  const focusActions = focus ? actionsFor(focus.card) : [];
  const myTurn = view.turnPlayer === 0;

  const menu = (
    <>
      <button
        className="button"
        onClick={(event) => {
          event.stopPropagation();
          const name = onSaveState();
          if (name) setSavedNote(`Saved: ${name}`);
          window.setTimeout(() => setSavedNote(""), 1800);
        }}
      >
        Save state
      </button>
      {states.length > 0 && (
        <button className={`button ${stateList ? "on" : ""}`} onClick={(event) => (event.stopPropagation(), setStateList(!stateList))}>
          Load state ({states.length})
        </button>
      )}
      {stateList &&
        states.map((state) => (
          <button key={state.id} className="button small ghost state-row" onClick={() => (setStateList(false), onLoadState(state.id))}>
            {state.name}
            <small>{new Date(state.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
          </button>
        ))}
      {savedNote && <p className="muted saved-note">{savedNote}</p>}
      {onWorked && (
        <button className={`button ${worked ? "on" : ""}`} onClick={onWorked}>
          {worked ? "✓ Worked (tap to undo)" : "✓ This worked"}
        </button>
      )}
      <button className="button" onClick={restart}>
        New hand
      </button>
      <button className="button ghost" onClick={leave}>
        Exit
      </button>
    </>
  );

  const phaseControl = wide ? (
    <div className="phase-strip" onClick={(event) => event.stopPropagation()}>
      <span className="phase-now">Turn {view.turn}</span>
      <PhaseTrack phase={view.phase} mine={view.turnPlayer === 0} />
      {phaseChoices.map(({ choice, index }) => pickButton(choice, index, "button primary"))}
    </div>
  ) : (
    <div className="phase-dock">
      <PhaseTrack phase={view.phase} mine={view.turnPlayer === 0} />
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
  );

  const opponentBar = (
    <LifeBar name="Opponent" lp={them.lp} extra={`Hand ${them.hand.length}`} active={!myTurn}>
      {!wide && (
        <button className="icon-button" aria-label="Menu" onClick={(event) => (event.stopPropagation(), setMenuOpen(!menuOpen))}>
          ☰
        </button>
      )}
    </LifeBar>
  );
  const myBar = <LifeBar name="You" lp={me.lp} mine active={myTurn} />;

  return (
    // a tap anywhere else closes the floating actions and the menus
    <div className={`duel ${wide ? "wide" : "phone"}`} onClick={() => (setFocus(null), setPhaseOpen(false), setMenuOpen(false))}>
      {wide && (
        <aside className="side">
          {opponentBar}
          {myBar}
          <div className="info-panel">
            <CardInfo card={info} text={info ? texts.get(info.code) : undefined} materials={info ? materialNames(info) : undefined} />
          </div>
          <div className="side-menu">{menu}</div>
        </aside>
      )}
      {!wide && opponentBar}
      {!wide && menuOpen && <div className="menu">{menu}</div>}
      {replaying && (
        <div className="replay-bar" onClick={(event) => event.stopPropagation()}>
          <span>
            Replaying · choice {Math.min(replaying.at + 1, replaying.of)} of {replaying.of}
            <small> · make any choice to take over</small>
          </span>
          <button className="button small" onClick={replaying.stop}>
            Take over
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
          {promptBar}
          {phaseControl}
        </div>

        {view.ended && <p className="banner">{view.winner === 0 ? "You win" : view.winner === 1 ? "You lose" : "The duel has ended."}</p>}
        {promptDialog}
      </div>

      {!wide && myBar}

      <div className={`hand ${wide ? "flat" : "fan"}`} ref={handRef}>
        {me.hand.map((card, i) => {
          const offset = i - (handCount - 1) / 2;
          const lifted = (focus && same(focus.card, card)) || isPicked(card);
          const transform = wide
            ? `translateY(${lifted ? -14 : 0}px)`
            : `translateY(${Math.abs(offset) * Math.abs(offset) * 2 - (lifted ? 22 : 0)}px) rotate(${offset * (handCount > 6 ? 2 : 3)}deg)`;
          return (
            <CardTile
              key={card.sequence}
              card={card}
              className={`hand-card ${i >= handCount - drawn ? "drawn" : ""}`}
              style={{ animationDelay: i >= handCount - drawn ? `${(i - (handCount - drawn)) * 50}ms` : undefined, width: cardWidth, left: `calc(50% + ${offset * step - cardWidth / 2}px)`, transform, zIndex: lifted ? 50 : i + 1 }}
              glow={hasAction(card)}
              pulse={pickPrompt && hasAction(card)}
              picked={isPicked(card)}
              focused={!!focus && same(focus.card, card)}
              onTap={(el) => tapCard(card, el)}
              onHold={() => showDetail(card)}
              onHover={wide ? () => inspect(card) : undefined}
            />
          );
        })}
      </div>

      {focus && focusActions.length > 0 && (
        <>
          <div className="scrim" onClick={(event) => (event.stopPropagation(), setFocus(null))} />
          <div className="float-actions" ref={floatRef} style={floatPos ? { left: floatPos.left, top: floatPos.top } : { visibility: "hidden" }}>
            {focusActions.map(({ choice, index }) => {
              // two actions with the same words (a pile of cards): say which card each is for
              const twin = focusActions.some((other) => other.index !== index && other.choice.label === choice.label);
              return pickButton(twin && choice.card ? { ...choice, label: `${choice.label}: ${choice.card.name}` } : choice, index, "float-action");
            })}
            {!wide && (
              <button className="float-action info" onClick={(event) => (event.stopPropagation(), showDetail(focus.card))}>
                Card text
              </button>
            )}
          </div>
        </>
      )}

      {view.events.length > 0 && <Cues key={view.events.map((event) => event.kind + event.code).join()} events={view.events} onSkip={skip} />}

      {promptGrid}
      {promptAnnounce}

      {sheetBody && (
        <>
          <div className="scrim dim" onClick={(event) => (event.stopPropagation(), setSheet(null))} />
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            {sheetBody}
          </div>
        </>
      )}
    </div>
  );
}
