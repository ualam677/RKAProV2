// The Deck Optimiser panel inside the deck editor: tag what each Main Deck card is for, read the exact odds for both
// turns, and apply the swaps it finds with one tap (and undo them just as fast).
import { useEffect, useMemo, useState } from "react";
import { CardArt } from "./CardArt";
import { EXTRA_TYPES, deckSignature, loadTagDefaults, storeTagDefault, type SavedDeck, type SavedRoute } from "./decks";
import type { CardEvidence } from "./engine/probe";
import type { CardInfo, TestRecord } from "./engine/protocol";
import {
  GOALS, ROLES, allProven, normalLimit, bestCuts, bestSwaps, computeOdds, describePartners, grade, guessTag, matchesPartner, provenOnly, testHand,
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
  onTest: (chosen: number[]) => void;
  engineProgress: { done: number; total: number } | null;
  onCheck: () => void;
  routing: { code: number; tried: number; waiting: number[] } | null;
  onFindLines: (starts: { code: number; hand: number[] }[]) => void;
  onWatchLine: (line: TestRecord, code: number) => void;
}

const ATTRIBUTE_NAMES = ["EARTH", "WATER", "FIRE", "WIND", "LIGHT", "DARK", "DIVINE"];
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const oneIn = (value: number) => (value <= 0 ? "never" : `about 1 hand in ${Math.max(1, Math.round(1 / value))}`);
const ORDER: Role[] = ["none", "starter", "pair", "extender", "piece", "handtrap", "handtrap2", "breaker", "brick", "other"];

export function Optimiser({ deck, cards, nameKey, room, onChange, onShow, requestInfo, onTest, engineProgress, onCheck, routing, onFindLines, onWatchLine }: Props) {
  const [second, setSecond] = useState(false);
  const [goal, setGoal] = useState<Goal>(() => (localStorage.getItem("rka.goal") as Goal) || "comboHandtrap");
  const [partnerFor, setPartnerFor] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ deck: SavedDeck; what: string } | null>(null);
  const [suggestions, setSuggestions] = useState<{ swaps: Swap[]; cut: { cuts: number[]; before: Score; after: Score } | null } | null>(null);
  const defaults = useMemo(loadTagDefaults, [deck.tags]);

  // what the engine found, for the deck as it is now or (while it checks again) as it was
  const signature = deckSignature(deck);
  const fresh = deck.engine?.signature === signature;
  useEffect(() => {
    if (fresh || deck.main.length === 0) return;
    const wait = window.setTimeout(onCheck, 800);
    return () => window.clearTimeout(wait);
  }, [signature]);
  const evidence = useMemo(() => new Map((deck.engine?.evidence ?? []).map((entry) => [entry.code, entry])), [deck.engine]);
  // a card the engine pairs with every card that doesn't start alone works with any second card in a real hand
  const lone = useMemo(() => [...evidence.values()].filter((entry) => entry.alone.deck === 0).length, [evidence]);
  const withAny = (codes: number[]) => lone > 1 && codes.length >= lone;
  const engineTag = (key: number): Tag | null => {
    const found = evidence.get(key);
    if (!found) return null;
    // a line that opens with a Normal Summon needs the turn's Normal Summon
    if (found.alone.deck > 0) return { role: "starter", engine: true, normal: found.alone.steps[0]?.startsWith("Normal Summon ") };
    if (found.partners.length) return { role: "pair", with: { codes: found.partners, attributes: 0, levels: [] }, engine: true };
    // "starts nothing" is not "does nothing": a combo piece or a trap is left for you to tag, so it is never cut
    return null;
  };
  // yours in this deck, then the engine's starts, then yours from other decks, then known cards
  const baseTag = (key: number): Tag => deck.tags?.[key] ?? engineTag(key) ?? defaults[key] ?? guessTag(key) ?? { role: "none" };
  // a working test that opened with exactly one start proves that start (the rest of the hand had none)
  const provenByTest = useMemo(() => {
    const proven = new Set<number>();
    for (const one of deck.tests ?? []) {
      if (!one.worked) continue;
      const starts = [...new Set(one.startHand.map(nameKey))].filter((key) => ["starter", "pair"].includes(baseTag(key).role));
      if (starts.length === 1) proven.add(starts[0]);
    }
    return proven;
  }, [deck.tests, deck.tags, evidence, defaults, cards]);
  const tagOf = (key: number): Tag => {
    const tag = baseTag(key);
    return !tag.proven && provenByTest.has(key) ? { ...tag, proven: true, provenByTest: true } : tag;
  };
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
  }, [deck, cards, defaults, provenByTest]);

  useEffect(() => {
    const missing = main.flatMap((card) => card.tag.with?.codes ?? []).filter((code) => !infoOf(code));
    if (missing.length) requestInfo([...new Set(missing)]);
  }, [main]);

  const first = useMemo(() => computeOdds(main, 5), [main]);
  const secondOdds = useMemo(() => computeOdds(main, 6), [main]);
  const odds = second ? secondOdds : first;
  const everyStartProven = useMemo(() => allProven(main), [main]);
  const proven = useMemo(() => computeOdds(provenOnly(main), second ? 6 : 5), [main, second]);
  const startCardsAll = main.filter((card) => card.tag.role === "starter" || card.tag.role === "pair");
  // the lines the route search found, for the deck as it is now
  const routes = deck.routes ?? {};
  const routeOf = (code: number) => (routes[code]?.signature === signature ? routes[code] : undefined);
  const fullBoards = (deck.tests ?? []).filter((one) => one.worked && one.board?.length).length;
  // a full board: at least this many interruptions on the opponent's turn
  const fullAt = deck.fullAt ?? 3;
  const isFull = (route?: SavedRoute) => !!route && (route.interruptions?.length ?? 0) >= fullAt;
  const reached = useMemo(() => {
    if (!startCardsAll.some((card) => routeOf(card.code))) return null;
    const checked = main.map((card) =>
      (card.tag.role === "starter" || card.tag.role === "pair") && !isFull(routeOf(card.code)) ? { ...card, tag: { role: "other" as Role } } : card,
    );
    return computeOdds(checked, second ? 6 : 5);
  }, [main, second, deck.routes, fullAt]);
  const startCards = main.filter((card) => card.tag.role === "starter" || card.tag.role === "pair");
  const handFor = (card: DeckCard) => testHand(card, main)?.map((code) => held.get(code) ?? code) ?? null;
  const findAll = () => onFindLines(startCards.flatMap((card) => { const hand = handFor(card); return hand ? [{ code: card.code, hand }] : []; }));

  // only the starts the engine saw work, with the partners it found
  const engineChecked = useMemo(() => {
    if (!evidence.size) return null;
    const checked = main.map((card) => {
      const engine = engineTag(card.code);
      if (engine) return { ...card, tag: engine };
      return card.tag.role === "starter" || card.tag.role === "pair" ? { ...card, tag: { role: "other" as Role } } : card;
    });
    return computeOdds(checked, second ? 6 : 5);
  }, [main, second, evidence]);
  const count = (...roles: Role[]) => main.filter((card) => roles.includes(card.tag.role)).reduce((sum, card) => sum + card.count, 0);
  const untagged = count("none");
  const normalCards = main.filter((card) => card.tag.normal);
  const normalCount = normalCards.reduce((sum, card) => sum + card.count, 0);
  // what the engine's lines take from the Deck: candidates for "Combo piece in the Deck"
  const takenBy = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const entry of evidence.values()) if (entry.alone.deck > 0) for (const code of new Set(entry.alone.taken)) map.set(code, [...(map.get(code) ?? []), entry.code]);
    return map;
  }, [evidence]);
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
    if (tag.proven && (tag.role === "starter" || tag.role === "pair")) clean.proven = true;
    if (tag.normal && (tag.role === "starter" || tag.role === "pair" || tag.role === "extender")) clean.normal = true;
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
    setTag(key, { role, with: role === "pair" ? old.with : undefined, normal: old.normal }); // a new role has to be proven again
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
        ...(normalCount > 1 ? ([["Two Normal Summon cards", odds.normal2, "one of them is dead"]] as [string, number, string][]) : []),
        ...(count("brick", "piece") || normalCount > 1 ? ([["Dead card in hand", odds.dead, `two or more: ${pct(odds.dead2)}`]] as [string, number, string][]) : []),
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
          <ul className="opt-evidence">
            <li>
              <span>As tagged</span>
              <b>{pct(odds.combo)}</b>
            </li>
            <li title="The engine played every card alone and with each other card, and counted the starts that kept a new card from the Deck">
              <span>
                Engine-checked starts
                {engineProgress && engineProgress.total > 0 && (
                  <small>
                    {" "}
                    · checking {engineProgress.done} of {engineProgress.total}
                  </small>
                )}
                {engineProgress && !engineProgress.total && <small> · getting ready</small>}
              </span>
              <b>{engineChecked ? pct(engineChecked.combo) : "…"}</b>
            </li>
            {reached && (
              <li title="Starts from which the route search reached a board with enough interruptions">
                <span>Engine reached a full board ({fullAt}+ interruptions)</span>
                <b>{pct(reached.combo)}</b>
              </li>
            )}
            <li title="Starts you played to your full board with Test, then ticked Proven">
              <span>Proven to a full board</span>
              <b className={everyStartProven ? "" : "warn"}>{pct(everyStartProven ? odds.combo : proven.combo)}</b>
            </li>
          </ul>
          {startCards.length > 0 && (
            <div className="opt-find">
              <button className="button small" onClick={findAll} disabled={!!routing}>
                {routing ? `Finding lines… ${routing.waiting.length + 1} start${routing.waiting.length ? "s" : ""} to go` : "Find a line for every start"}
              </button>
              <span className="opt-fullat">
                Full board: at least
                <button className="button small" onClick={() => onChange({ ...deck, fullAt: Math.max(1, fullAt - 1), updated: Date.now() })} aria-label="Fewer">
                  −
                </button>
                <b>{fullAt}</b>
                <button className="button small" onClick={() => onChange({ ...deck, fullAt: Math.min(8, fullAt + 1), updated: Date.now() })} aria-label="More">
                  +
                </button>
                interruptions
              </span>
              <span className="muted">
                An interruption: an effect usable on the opponent's turn that negates or removes (Quick Effects, Set Traps), read from the card scripts.
                {fullBoards ? ` Lines close to your ${fullBoards} working board${fullBoards > 1 ? "s" : ""} are preferred.` : ""}
              </span>
            </div>
          )}
          {engineProgress && engineProgress.total > 0 && (
            <span className="opt-bar opt-progress">
              <i style={{ width: `${(engineProgress.done / engineProgress.total) * 100}%` }} />
            </span>
          )}
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
            <b>{count("breaker")}</b> breaker · <b>{count("piece")}</b> combo piece · <b>{count("brick")}</b> brick · <b>{count("other")}</b> other{untagged ? <> · <b className="warn">{untagged}</b> not tagged</> : null}
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
              {normalCount > normalLimit(total) && (
                <p className="opt-note warn">
                  {normalCount} cards need your Normal Summon ({normalCards.map((card) => `${card.count} ${nameOf(card.code)}`).join(", ")}). Keep it to {normalLimit(total)} in a {total}-card deck:
                  you hold two of them in {pct(first.normal2)} of hands going first, and only one can be summoned. Swaps never add another.
                </p>
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
                    {card.tag.engine && <span className="opt-guess engine">engine</span>}
                  </button>
                  <EngineLine
                    found={evidence.get(card.code)}
                    tag={card.tag}
                    own={!!deck.tags?.[card.code]}
                    nameOf={nameOf}
                    withAny={withAny}
                    takenBy={(takenBy.get(card.code) ?? []).map(nameOf)}
                    onPiece={() => setRole(card.code, "piece")}
                    onUseEngine={() => {
                      const tags = { ...deck.tags };
                      delete tags[card.code];
                      onChange({ ...deck, tags, updated: Date.now() });
                    }}
                  />
                  {card.tag.role === "pair" && (
                    <button className="opt-partners" onClick={() => setPartnerFor(card.code)}>
                      with {card.tag.with && withAny(card.tag.with.codes) && !card.tag.with.attributes && !card.tag.with.levels.length ? "any other card" : describePartners(card.tag.with, nameOf)} <u>Edit</u>
                    </button>
                  )}
                  {(card.tag.role === "starter" || card.tag.role === "pair") && (
                    <span className="opt-proof">
                      <button className={`button small ${card.tag.normal ? "on" : "ghost"}`} onClick={() => setTag(card.code, { ...card.tag, normal: !card.tag.normal })} title="Its line uses the turn's Normal Summon">
                        {card.tag.normal ? "✓ Normal Summon" : "Normal Summon?"}
                      </button>
                      <button
                        className="button small"
                        onClick={() => {
                          const hand = testHand(card, main);
                          if (hand) onTest(hand.map((code) => held.get(code) ?? code));
                        }}
                        disabled={!testHand(card, main)}
                      >
                        Test
                      </button>
                      <button className="button small" disabled={!!routing || !handFor(card)} onClick={() => { const hand = handFor(card); if (hand) onFindLines([{ code: card.code, hand }]); }}>
                        Find a line
                      </button>
                      <button
                        className={`button small ${card.tag.proven ? "on" : "ghost"}`}
                        disabled={card.tag.provenByTest}
                        onClick={() => setTag(card.code, { ...card.tag, proven: !card.tag.proven })}
                      >
                        {card.tag.provenByTest ? "✓ Proven by your test" : card.tag.proven ? "✓ Proven" : "Proven?"}
                      </button>
                    </span>
                  )}
                  {(card.tag.role === "starter" || card.tag.role === "pair") && (
                    <RouteLine
                      route={routes[card.code]}
                      full={isFull(routes[card.code])}
                      fresh={!!routeOf(card.code)}
                      searching={routing?.code === card.code ? routing.tried : null}
                      waiting={!!routing?.waiting.includes(card.code)}
                      nameOf={nameOf}
                      onWatch={() => routes[card.code] && onWatchLine(routes[card.code].record, card.code)}
                    />
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
              Normal Summon: a start whose line uses the turn's Normal Summon (the engine marks the ones whose line opens with one). Holding two, one is
              dead, so it counts as a dead card, and swaps never take you past 5 in 40 cards (one per 8). Extenders and Combo pieces are never suggested
              as cuts: what they do (play through a negate, be there to search) isn't in these numbers yet. Engine-checked: the duel engine (EDOPro's own card scripts) played every card in the Main Deck alone, then every pair of cards that start nothing alone,
              trying the actions it allows a few steps deep. A start counts when the hand ends up keeping a new card from the Deck, so a search that has to put a card
              back doesn't count. It finds partners by itself: what the engine lets a card do with each other card in the hand. It says whether a hand gets going,
              not whether it reaches your full board; that's what Proven is for. Every possible opening hand is counted with its exact chance, no sampling. A combo opens with a Starter, or a Starter with a partner plus one of its partners. A hand trap used as the
              partner doesn't count as a hand trap you still hold. A start is only as good as its tag: Test deals it with a partner (if it needs one) and
              cards that can't help, hand traps held back; tick Proven once it reaches your full board (or mark the test "This worked" in the duel menu, and it ticks itself). Until every start is proven, the headline also shows the
              proven-only number. Going first, "Hand trap, going 2nd" cards count as dead. Swaps are judged on going first and going second equally, and use the
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

// What the route search found from this start's test hand
function RouteLine({ route, full, fresh, searching, waiting, nameOf, onWatch }: { route?: SavedRoute; full: boolean; fresh: boolean; searching: number | null; waiting: boolean; nameOf: (code: number) => string; onWatch: () => void }) {
  if (searching !== null) return <span className="opt-engine">Searching for a line… {searching} tried</span>;
  if (waiting) return <span className="opt-engine">Waiting to search</span>;
  if (!route) return null;
  const board = route.board.length ? route.board.map(nameOf).join(", ") : "nothing on the field";
  const stops = route.interruptions ?? [];
  const where = { field: "", hand: " from the hand", set: " Set", gy: " in the GY" };
  return (
    <span className={`opt-engine route ${full ? "full" : ""}`}>
      Engine line ({route.tried} tried): ends on {board}. {full ? "✓ " : ""}
      {stops.length
        ? `${stops.length} interruption${stops.length > 1 ? "s" : ""}: ${stops.map((one) => `${nameOf(one.code)} (${one.kind}${where[one.from]})`).join(", ")}`
        : "No interruptions"}
      {route.aimed && route.coverage > 0 && ` · ${Math.round(route.coverage * 100)}% of your closest working board`}
      {!fresh && " · deck changed since"}{" "}
      <button className="opt-link" onClick={onWatch}>
        Watch
      </button>
    </span>
  );
}

// How the engine knows, in one line, and where it disagrees with a tag you set
function EngineLine({ found, tag, own, nameOf, withAny, takenBy, onPiece, onUseEngine }: { found?: CardEvidence; tag: Tag; own: boolean; nameOf: (code: number) => string; withAny: (codes: number[]) => boolean; takenBy: string[]; onPiece: () => void; onUseEngine: () => void }) {
  if (!found) return null;
  // a card that starts nothing but the engine's lines pull from the Deck: maybe one to keep there
  if (found.alone.deck === 0 && !found.partners.length && takenBy.length && tag.role !== "starter" && tag.role !== "pair")
    return (
      <span className="opt-engine">
        Engine: nothing alone, but {takenBy.slice(0, 3).join(", ")}
        {takenBy.length > 3 ? ` and ${takenBy.length - 3} more` : ""} take{takenBy.length === 1 ? "s" : ""} it from the Deck.{" "}
        {tag.role !== "piece" && (
          <button className="opt-link" onClick={onPiece}>
            Combo piece?
          </button>
        )}
      </span>
    );
  const alone = found.alone.deck > 0;
  const partnered = found.partners.length > 0;
  const steps = found.alone.steps.filter((step) => !step.startsWith("pick ")).slice(0, 4).join(" › ");
  const picks = found.alone.taken.slice(0, 3).map(nameOf).join(", ");
  let text: string;
  if (alone) text = `Engine: alone it keeps ${found.alone.deck} new card${found.alone.deck > 1 ? "s" : ""} from the Deck (${steps}${picks ? `: ${picks}` : ""})`;
  else if (partnered) text = `Engine: nothing alone; starts with ${withAny(found.partners) ? "any other card" : `${found.partners.length} card${found.partners.length > 1 ? "s" : ""} in this deck`}`;
  else text = `Engine: nothing alone or with any one other card (${found.checked} tried)`;
  const role = tag.role;
  const disagrees = own && ((role === "starter" && !alone) || (role === "pair" && alone) || ((role === "pair" || role === "starter") && !alone && !partnered) || (role !== "starter" && role !== "pair" && (alone || partnered)));
  return (
    <span className={`opt-engine ${disagrees ? "warn" : ""}`}>
      {disagrees && "⚠ "}
      {text}
      {disagrees && (
        <>
          {" "}
          <button className="opt-link" onClick={onUseEngine}>
            Use the engine's tag
          </button>
        </>
      )}
    </span>
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

