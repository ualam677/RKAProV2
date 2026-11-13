// The Deck Optimiser panel inside the deck editor: tag what each Main Deck card is for, read the exact odds for both
// turns, and apply the swaps it finds with one tap (and undo them just as fast).
import { useEffect, useMemo, useState } from "react";
import { CardArt } from "./CardArt";
import { EXTRA_TYPES, loadTagDefaults, storeTagDefault, type SavedDeck } from "./decks";
import type { CardInfo } from "./engine/protocol";
import {
  GOALS, ROLES, bestCuts, bestSwaps, computeOdds, describePartners, grade, guessTag, matchesPartner, roleName,
  type DeckCard, type Goal, type Partners, type Role, type Score, type Swap, type Tag,
} from "./optimiser";

interface Props {
  deck: SavedDeck;
  cards: Map<number, CardInfo>;
  nameKey: (code: number) => number;
  room: (code: number) => number;
  onChange: (deck: SavedDeck) => void;
  onShow: (code: number) => void;
  requestInfo: (codes: number[]) => void;
}

const ATTRIBUTE_NAMES = ["EARTH", "WATER", "FIRE", "WIND", "LIGHT", "DARK", "DIVINE"];
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const oneIn = (value: number) => (value <= 0 ? "never" : `about 1 hand in ${Math.max(1, Math.round(1 / value))}`);
const ORDER: Role[] = ["none", "starter", "pair", "extender", "handtrap", "handtrap2", "breaker", "brick", "other"];

export function Optimiser({ deck, cards, nameKey, room, onChange, onShow, requestInfo }: Props) {
  const [second, setSecond] = useState(false);
  const [goal, setGoal] = useState<Goal>(() => (localStorage.getItem("rka.goal") as Goal) || "comboHandtrap");
  const [partnerFor, setPartnerFor] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ deck: SavedDeck; what: string } | null>(null);
  const [suggestions, setSuggestions] = useState<{ swaps: Swap[]; cut: { cuts: number[]; before: Score; after: Score } | null } | null>(null);
  const defaults = useMemo(loadTagDefaults, [deck.tags]);

  const tagOf = (key: number): Tag => deck.tags?.[key] ?? defaults[key] ?? guessTag(key) ?? { role: "none" };
  // a card is known by its original code; its details may only be cached under the artwork the deck holds
  const held = useMemo(() => {
    const map = new Map<number, number>();
    for (const code of [...deck.main, ...deck.side]) if (!map.has(nameKey(code))) map.set(nameKey(code), code);
    return map;
  }, [deck, cards]);
  const infoOf = (code: number) => cards.get(code) ?? cards.get(held.get(code) ?? code);
  const nameOf = (code: number) => infoOf(code)?.name ?? `#${code}`;
  const factsOf = (code: number) => {
    const card = infoOf(code);
    return card && { type: card.type, attribute: card.attribute, level: card.level };
  };

  // the Main Deck by card (alternate artworks together), and Side Deck cards that could come in
  const { main, side, sideKeys, total } = useMemo(() => {
    const collect = (codes: number[]) => {
      const byKey = new Map<number, DeckCard>();
      for (const code of codes) {
        const key = nameKey(code);
        const entry = byKey.get(key);
        if (entry) entry.count++;
        else byKey.set(key, { code: key, count: 1, tag: tagOf(key), facts: factsOf(key) });
      }
      return [...byKey.values()];
    };
    const sideCards = collect(deck.side.filter((code) => !((cards.get(code)?.type ?? 0) & EXTRA_TYPES)));
    return { main: collect(deck.main), side: sideCards, sideKeys: new Set(sideCards.map((card) => card.code)), total: deck.main.length };
  }, [deck, cards, defaults]);

  useEffect(() => {
    const missing = main.flatMap((card) => card.tag.with?.codes ?? []).filter((code) => !infoOf(code));
    if (missing.length) requestInfo([...new Set(missing)]);
  }, [main]);

  const first = useMemo(() => computeOdds(main, 5), [main]);
  const secondOdds = useMemo(() => computeOdds(main, 6), [main]);
  const odds = second ? secondOdds : first;
  const count = (...roles: Role[]) => main.filter((card) => roles.includes(card.tag.role)).reduce((sum, card) => sum + card.count, 0);
  const untagged = count("none");
  const hasStart = count("starter", "pair") > 0;

  // swaps take a moment on big decks: show the odds first, work these out right after
  useEffect(() => {
    setSuggestions(null);
    if (!hasStart || !main.length) return;
    const wait = window.setTimeout(() => {
      const candidates = [...main, ...side.filter((card) => !main.some((own) => own.code === card.code))];
      setSuggestions({
        swaps: bestSwaps(main, candidates, goal, room, sideKeys),
        cut: total > 40 ? bestCuts(main, goal) : null,
      });
    }, 30);
    return () => window.clearTimeout(wait);
  }, [main, side, goal]);

  const setTag = (key: number, tag: Tag) => {
    const clean: Tag = tag.role === "pair" ? { role: "pair", with: tag.with ?? { codes: [], attributes: 0, levels: [] } } : { role: tag.role };
    storeTagDefault(key, clean);
    onChange({ ...deck, tags: { ...deck.tags, [key]: clean }, updated: Date.now() });
  };
  const tagRest = () => {
    const rest = main.filter((card) => card.tag.role === "none");
    rest.forEach((card) => storeTagDefault(card.code, { role: "other" }));
    onChange({ ...deck, tags: { ...deck.tags, ...Object.fromEntries(rest.map((card) => [card.code, { role: "other" }])) }, updated: Date.now() });
  };
  const setRole = (key: number, role: Role) => {
    const old = tagOf(key);
    setTag(key, { role, with: role === "pair" ? old.with : undefined });
    if (role === "pair" && !old.with) setPartnerFor(key);
  };

  const removeOne = (list: number[], key: number) => {
    const at = list.map(nameKey).lastIndexOf(key);
    return at < 0 ? list : list.filter((_, index) => index !== at);
  };
  const apply = (next: Partial<SavedDeck>, what: string) => {
    setUndo({ deck, what });
    onChange({ ...deck, ...next, updated: Date.now() });
  };
  const applySwap = (swap: Swap) => {
    const main = removeOne(deck.main, swap.cut);
    if (swap.fromSide) {
      // a real side-deck swap: the card coming in leaves the Side Deck and the one going out takes its place
      const code = deck.side.find((one) => nameKey(one) === swap.add)!;
      const cutCode = deck.main.find((one) => nameKey(one) === swap.cut)!;
      apply({ main: [...main, code], side: [...removeOne(deck.side, swap.add), cutCode] }, `Swapped ${nameOf(swap.cut)} for ${nameOf(swap.add)}`);
    } else {
      const code = deck.main.find((one) => nameKey(one) === swap.add) ?? swap.add;
      apply({ main: [...main, code] }, `Swapped ${nameOf(swap.cut)} for ${nameOf(swap.add)}`);
    }
  };
  const applyCuts = (cuts: number[]) => apply({ main: cuts.reduce(removeOne, deck.main) }, `Cut ${cuts.length} cards`);

  const goalName = GOALS.find((entry) => entry.goal === goal)!.name.toLowerCase();
  const change = (before: Score, after: Score) => (
    <span className="opt-change">
      1st {pct(before.first[goal])} → <b>{pct(after.first[goal])}</b> · 2nd {pct(before.second[goal])} → <b>{pct(after.second[goal])}</b>
    </span>
  );
  const grouped = (codes: number[]) => {
    const tally = new Map<number, number>();
    codes.forEach((code) => tally.set(code, (tally.get(code) ?? 0) + 1));
    return [...tally].map(([code, n]) => (n > 1 ? `${n} ${nameOf(code)}` : nameOf(code))).join(", ");
  };

  const rows: [string, number, string?][] = second
    ? [
        ["Open a combo", odds.combo],
        ["Combo + hand trap", odds.comboHandtrap],
        ["Hand trap in hand", odds.handtrap, `${odds.handtrapAvg.toFixed(1)} on average`],
        ["Two or more hand traps", odds.handtrap2],
        ["Board breaker in hand", odds.breaker, count("breaker") ? undefined : "none tagged"],
      ]
    : [
        ["Open a combo", odds.combo],
        ["Combo + hand trap", odds.comboHandtrap],
        ["Combo + 2 hand traps", odds.comboHandtrap2],
        ...(count("extender") ? ([["Combo + extender", odds.comboExtender, "plays through a negate"]] as [string, number, string][]) : []),
        ...(count("brick") ? ([["Brick in hand", odds.dead, `two or more: ${pct(odds.dead2)}`]] as [string, number, string][]) : []),
      ];

  const sorted = [...main].sort((a, b) => ORDER.indexOf(a.tag.role) - ORDER.indexOf(b.tag.role) || nameOf(a.code).localeCompare(nameOf(b.code)));
  const partnerCard = partnerFor !== null ? main.find((card) => card.code === partnerFor) : undefined;

  return (
    <div className="optimiser">
      <div className="segmented two">
        <button className={`button small ${second ? "" : "on"}`} onClick={() => setSecond(false)}>
          Going 1st · 5 cards
        </button>
        <button className={`button small ${second ? "on" : ""}`} onClick={() => setSecond(true)}>
          Going 2nd · 6 cards
        </button>
      </div>

      {!main.length ? (
        <p className="muted">Add cards to the Main Deck to get started.</p>
      ) : (
        <>
          <div className="opt-big">
            <b>{pct(odds.combo)}</b>
            <span>
              open a combo · <em className={`grade grade-${grade(odds.combo).toLowerCase()}`}>{grade(odds.combo)}</em>
              <br />
              <small className="muted">Bricks {oneIn(1 - odds.combo)}</small>
            </span>
          </div>
          <ul className="opt-odds">
            {rows.map(([label, value, note]) => (
              <li key={label}>
                <span>
                  {label}
                  {note && <small> · {note}</small>}
                </span>
                <span className="opt-bar">
                  <i style={{ width: `${value * 100}%` }} />
                </span>
                <b>{pct(value)}</b>
              </li>
            ))}
          </ul>
          <p className="opt-counts">
            {total} cards: <b>{count("starter")}</b> starter · <b>{count("pair")}</b> with a partner · <b>{count("extender")}</b> extender · <b>{count("handtrap", "handtrap2")}</b> hand trap ·{" "}
            <b>{count("breaker")}</b> breaker · <b>{count("brick")}</b> brick · <b>{count("other")}</b> other{untagged ? <> · <b className="warn">{untagged}</b> not tagged</> : null}
          </p>
        </>
      )}

      {main.length > 0 && (
        <section className="opt-section">
          <h3>Suggestions</h3>
          {!hasStart ? (
            <p className="opt-note">Tag your starters first: pick "Starter" next to each card below that starts your combo by itself. Everything else is worked out from that.</p>
          ) : (
            <>
              <p className="muted">Improve the chance to:</p>
              <div className="segmented three opt-goals">
                {GOALS.map((entry) => (
                  <button
                    key={entry.goal}
                    className={`button small ${goal === entry.goal ? "on" : ""}`}
                    onClick={() => (setGoal(entry.goal), localStorage.setItem("rka.goal", entry.goal))}
                  >
                    {entry.name}
                  </button>
                ))}
              </div>
              {undo && (
                <div className="opt-card done">
                  <span>{undo.what}.</span>
                  <button className="button small" onClick={() => (onChange({ ...undo.deck, updated: Date.now() }), setUndo(null))}>
                    Undo
                  </button>
                </div>
              )}
              {!suggestions && <p className="muted">Working out swaps…</p>}
              {suggestions?.cut && suggestions.cut.cuts.length > 0 && (
                <div className="opt-card">
                  <div>
                    <b>Cut to 40: take out {grouped(suggestions.cut.cuts)}</b>
                    <span className="muted">{GOALS.find((entry) => entry.goal === goal)!.name}: </span>
                    {change(suggestions.cut.before, suggestions.cut.after)}
                  </div>
                  <button className="button small primary" onClick={() => applyCuts(suggestions.cut!.cuts)}>
                    Apply
                  </button>
                </div>
              )}
              {suggestions?.swaps.map((swap) => (
                <div className="opt-card" key={`${swap.cut}-${swap.add}`}>
                  <div>
                    <b>
                      −1 {nameOf(swap.cut)}, +1 {nameOf(swap.add)}
                      {swap.fromSide && <small> (from Side)</small>}
                    </b>
                    <span className="muted">{GOALS.find((entry) => entry.goal === goal)!.name}: </span>
                    {change(swap.before, swap.after)}
                    {Math.abs(swap.after.first.combo - swap.before.first.combo) >= 0.001 && (
                      <span className="opt-change">
                        Open a combo going 1st: {pct(swap.before.first.combo)} → {pct(swap.after.first.combo)}
                      </span>
                    )}
                  </div>
                  <button className="button small primary" onClick={() => applySwap(swap)}>
                    Apply
                  </button>
                </div>
              ))}
              {suggestions && !suggestions.swaps.length && !suggestions.cut?.cuts.length && <p className="opt-note">No single swap improves {goalName}. The ratios are solid for this goal.</p>}
              {untagged > 0 && (
                <div className="opt-note">
                  {untagged} card{untagged === 1 ? " is" : "s are"} not tagged. They count as never starting a combo and are never suggested as cuts (Extenders aren't either).{" "}
                  <button className="button small" onClick={tagRest}>
                    Tag the rest as Other
                  </button>
                </div>
              )}
              {!count("breaker") && <p className="opt-note">No board breakers tagged. Going second, nothing in the Main Deck clears an established board.</p>}
              {count("handtrap", "handtrap2") > 0 && secondOdds.handtrap < 0.75 && (
                <p className="opt-note">Going second you hold a hand trap in only {pct(secondOdds.handtrap)} of hands. Most decks run 9 to 12 of them.</p>
              )}
            </>
          )}
        </section>
      )}

      {main.length > 0 && (
        <section className="opt-section">
          <h3>What each card does</h3>
          <div className="opt-tags">
            {sorted.map((card) => (
              <div className={`opt-tag ${card.tag.role === "none" ? "untagged" : ""}`} key={card.code}>
                <button className="opt-thumb" onClick={() => onShow(card.code)} aria-label={`Read ${nameOf(card.code)}`}>
                  <CardArt code={card.code} />
                </button>
                <div className="opt-tag-text">
                  <button className="opt-name" onClick={() => onShow(card.code)}>
                    {nameOf(card.code)} <span className="muted">×{card.count}</span>
                    {card.tag.guessed && <span className="opt-guess">guess</span>}
                  </button>
                  {card.tag.role === "pair" && (
                    <button className="opt-partners" onClick={() => setPartnerFor(card.code)}>
                      with {describePartners(card.tag.with, nameOf)} <u>Edit</u>
                    </button>
                  )}
                </div>
                <select value={card.tag.role} onChange={(event) => setRole(card.code, event.target.value as Role)} aria-label={`Role of ${nameOf(card.code)}`}>
                  <option value="none">Not tagged</option>
                  {ROLES.map((entry) => (
                    <option key={entry.role} value={entry.role}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <details className="opt-help">
            <summary>What the roles and numbers mean</summary>
            <ul>
              {ROLES.map((entry) => (
                <li key={entry.role}>
                  <b>{entry.name}:</b> {entry.help}
                </li>
              ))}
            </ul>
            <p>
              Every possible opening hand is counted with its exact chance, no sampling. A combo opens with a Starter, or a Starter with a partner plus one of its partners. A hand trap used as the
              partner doesn't count as a hand trap you still hold. Going first, "Hand trap, going 2nd" cards count as dead. Swaps are judged on going first and going second equally, and use the
              tags of the card coming in.
            </p>
          </details>
        </section>
      )}

      {partnerCard && (
        <PartnerSheet
          card={partnerCard}
          main={main}
          nameOf={nameOf}
          onSave={(partners) => setTag(partnerCard.code, { role: "pair", with: partners })}
          onClose={() => setPartnerFor(null)}
        />
      )}
    </div>
  );
}

function PartnerSheet({ card, main, nameOf, onSave, onClose }: { card: DeckCard; main: DeckCard[]; nameOf: (code: number) => string; onSave: (partners: Partners) => void; onClose: () => void }) {
  const partners = card.tag.with ?? { codes: [], attributes: 0, levels: [] };
  const monsters = main.filter((one) => one.facts && one.facts.type & 1);
  const attributes = [...new Set(monsters.map((one) => one.facts!.attribute))].filter(Boolean).sort((a, b) => a - b);
  const levels = [...new Set(monsters.map((one) => one.facts!.level))].filter(Boolean).sort((a, b) => a - b);
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((one) => one !== value) : [...list, value]);
  const byRule = (one: DeckCard) => matchesPartner({ ...partners, codes: [] }, one);
  const copies = (attribute: number | null, level: number | null) =>
    monsters.filter((one) => (attribute !== null ? one.facts!.attribute & attribute : one.facts!.level === level)).reduce((sum, one) => sum + one.count, 0);

  return (
    <div className="sheet opt-sheet">
      <div className="sheet-title">
        <h2>{nameOf(card.code)} starts a combo with…</h2>
        <button className="button small primary" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="muted">Pick every card that works as its partner. A rule like "any LIGHT monster" keeps working when you add new cards.</p>
      <div className="opt-chips">
        {attributes.map((attribute) => (
          <button
            key={`a${attribute}`}
            className={`button small ${partners.attributes & attribute ? "on" : ""}`}
            onClick={() => onSave({ ...partners, attributes: partners.attributes ^ attribute })}
          >
            Any {ATTRIBUTE_NAMES[Math.log2(attribute)] ?? "?"} monster ({copies(attribute, null)})
          </button>
        ))}
        {levels.map((level) => (
          <button key={`l${level}`} className={`button small ${partners.levels.includes(level) ? "on" : ""}`} onClick={() => onSave({ ...partners, levels: toggle(partners.levels, level) })}>
            Any Level {level} ({copies(null, level)})
          </button>
        ))}
      </div>
      <div className="opt-checks">
        {main.map((one) => {
          const rule = byRule(one);
          const checked = rule || partners.codes.includes(one.code);
          const self = one.code === card.code;
          return (
            <label key={one.code} className={rule ? "by-rule" : ""}>
              <input type="checkbox" checked={checked} disabled={rule} onChange={() => onSave({ ...partners, codes: toggle(partners.codes, one.code) })} />
              <span>
                {self ? `A second ${nameOf(one.code)}` : nameOf(one.code)} <span className="muted">×{one.count}</span>
                {rule && <small> · by the rule above</small>}
                {self && one.count < 2 && <small> · only 1 in the deck</small>}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

