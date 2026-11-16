// The Deck Optimiser panel inside the deck editor: tag what each Main Deck card is for, read the exact odds for both
// turns, and check your worked lines against hand traps.
import { useEffect, useMemo, useState } from "react";
import { describeInterruption, describeNibiru, describeProtection } from "./interruptText";
import { hasRole, rolesOf, secondOnly } from "./optimiser";
import type { TestResult } from "./decks";
import { CardArt } from "./CardArt";
import { EndBoard } from "./Tests";
import { MiniCards, RoleBadges, RoleStrip, TraitGlyphs, type Mini } from "./CardGlyphs";
import { rescored } from "./decks";
import { EXTRA_TYPES, deckSignature, loadTagDefaults, storeTagDefault, type SavedDeck, type SavedRoute } from "./decks";
import { CHOKE_TRAPS, type CardEvidence, type Choke, type ChokeCombo } from "./engine/probe";
import type { CardInfo, TestRecord } from "./engine/protocol";
import {
  deckSizes, withoutCards, changed, tryChanges, TOP_CUT, type SizeRow, GOALS, ROLES, allProven, normalLimit, throughMany, throughOdds, bestCuts, bestSwaps, computeOdds, describePartners, grade, guessTag, matchesPartner, provenOnly, testHand,
  type DeckCard, type Goal, type Partners, type Role, type Score, type Swap, type Tag,
} from "./optimiser";

/** What the app's back button calls first on the Test screen: closes the hand trap picker (true if it did). */
export const testOverlay = { close: (): boolean => false };

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
  choking: { code: number; waiting: number[] } | null;
  onFindLines: (starts: { code: number; hand: number[] }[]) => void;
  traits: Map<number, string[]>;
  requestTraits: (codes: number[]) => void;
  // "lines": only the starts, their lines and records (the Test screen shows this part)
  only?: "lines";
  // the Test screen's own settings (hand size, your hand traps) and its hand picker, placed in the layout
  setup?: React.ReactNode;
  play?: React.ReactNode;
  cutResult: { cut: number; lines?: { start: number; before: number; after: number; board: number[] }[] } | null;
  onCutTest: (code: number) => void;
  onCheckChokes: (starts: { code: number; hand: number[] }[]) => void;
  onWatchLine: (line: TestRecord, code: number) => void;
}

const ATTRIBUTE_NAMES = ["EARTH", "WATER", "FIRE", "WIND", "LIGHT", "DARK", "DIVINE"];
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const oneIn = (value: number) => (value <= 0 ? "never" : `about 1 hand in ${Math.max(1, Math.round(1 / value))}`);
const ORDER: Role[] = ["none", "starter", "pair", "digger", "extender", "piece", "handtrap", "handtrap2", "breaker", "brick", "other"];

export function Optimiser({ only, setup, play, cutResult, onCutTest, traits, requestTraits, deck, cards, nameKey, room, onChange, onShow, requestInfo, onTest, engineProgress, onCheck, routing, choking, onFindLines, onCheckChokes, onWatchLine }: Props) {
  const [second, setSecond] = useState(false);
  const [goal, setGoal] = useState<Goal>(() => (localStorage.getItem("rka.goal") as Goal) || "comboHandtrap");
  const [partnerFor, setPartnerFor] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ deck: SavedDeck; what: string } | null>(null);
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
  // a Digger's depth, read from its text by the worker ("digs: sees 6 more cards")
  // its choices, deepest first: "sees 6 more cards (or 3)" → [6, 3]
  const digChoices = (key: number) => {
    const text = (traits.get(key) ?? []).find((one) => one.startsWith("draw power:")) ?? "";
    return [/sees (\d+)/.exec(text)?.[1], /\(or (\d+)\)/.exec(text)?.[1]].filter(Boolean).map(Number);
  };
  const digOf = (key: number) => Number(/^draw power: sees (\d+)/.exec((traits.get(key) ?? []).find((one) => one.startsWith("draw power:")) ?? "")?.[1] ?? 0);
  const baseTag = (key: number): Tag => {
    const tag = deck.tags?.[key] ?? engineTag(key) ?? defaults[key] ?? guessTag(key);
    if (tag) return tag;
    const dig = digOf(key);
    return dig ? { role: "digger", dig, guessed: true } : { role: "none" };
  };
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
    const found = baseTag(key);
    // a Digger always carries its depth (tagged by hand too)
    const tag = hasRole(found, "digger") && !found.dig ? { ...found, dig: digOf(key) || 1 } : found;
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
  }, [deck, cards, defaults, provenByTest, traits]);

  useEffect(() => {
    const missing = main.flatMap((card) => card.tag.with?.codes ?? []).filter((code) => !infoOf(code));
    if (missing.length) requestInfo([...new Set(missing)]);
  }, [main]);

  const first = useMemo(() => computeOdds(main, 5), [main]);
  const secondOdds = useMemo(() => computeOdds(main, 6), [main]);
  // remembered for the menu's Optimise tile
  useEffect(() => {
    try {
      localStorage.setItem(`rka.odds.${deck.id}`, String(first.combo));
    } catch {
      // the tile just shows no number
    }
  }, [deck.id, first.combo]);
  const odds = second ? secondOdds : first;
  const everyStartProven = useMemo(() => allProven(main), [main]);
  const proven = useMemo(() => computeOdds(provenOnly(main), second ? 6 : 5), [main, second]);
  const startCardsAll = main.filter((card) => card.tag.role === "starter" || card.tag.role === "pair");
  // the lines the route search found, for the deck as it is now
  // the lines checked against hand traps: your worked replays only (the engine's own searches are no longer shown)
  const routes = Object.fromEntries(Object.entries(deck.routes ?? {}).filter(([, route]) => route.source === "replay"));
  const routeOf = (code: number) => (routes[code]?.signature === signature ? routes[code] : undefined);
  const fullBoards = (deck.tests ?? []).filter((one) => one.worked && one.board?.length).length;
  // a full board: at least this many interruptions on the opponent's turn
  const fullAt = deck.fullAt ?? 3;
  const isFull = (route?: SavedRoute) => !!route && (route.interruptions?.length ?? 0) >= fullAt;
  // for the odds, a line counts toward a card only if that card is all it needs (plus any other cards)
  const aloneFull = (code: number, route?: SavedRoute) => isFull(route) && (!route!.needs || route!.needs.every((need) => nameKey(need) === code));
  // the hand a start's ▶ deals: a saved line's needed cards plus its other cards (from that line's own hand); with no
  // line, the card alone if the engine saw it start alone, or with its partner
  const neededHand = (card: DeckCard): number[] | null => {
    const route = routes[card.code];
    if (route?.needs?.length && route.record?.startHand) {
      let others = [...route.record.startHand];
      for (const need of route.needs) {
        const at = others.findIndex((code) => nameKey(code) === nameKey(need));
        if (at >= 0) others.splice(at, 1);
      }
      return [...route.needs, ...others.slice(0, route.any ?? 0)];
    }
    const full = testHand(card, main);
    return full ? full.slice(0, card.tag.role === "pair" ? 2 : 1) : null;
  };
  const reached = useMemo(() => {
    if (!startCardsAll.some((card) => routeOf(card.code))) return null;
    const checked = main.map((card) =>
      (card.tag.role === "starter" || card.tag.role === "pair") && !aloneFull(card.code, routeOf(card.code)) ? { ...card, tag: { role: "other" as Role } } : card,
    );
    return computeOdds(checked, second ? 6 : 5);
  }, [main, second, deck.routes, fullAt]);
  const startCards = main.filter((card) => card.tag.role === "starter" || card.tag.role === "pair");
  // through one hand trap, used at its best moment: a start still counts if its line keeps a full board
  const trapCodes = useMemo(() => [...new Set(Object.values(routes).flatMap((route) => (route.chokes ?? []).map((choke) => choke.trap)))], [deck.routes]);
  useEffect(() => {
    const missing = [...new Set([...trapCodes, ...CHOKE_TRAPS])].filter((code) => !infoOf(code));
    if (missing.length) requestInfo(missing);
  }, [trapCodes]);
  // the hand traps the opponent holds together, and how the hand fares against all of them
  const holding = deck.opponentTraps ?? [14558127, 10045474];
  const sameSet = (combo?: ChokeCombo) => !!combo && combo.traps.length === holding.length && holding.every((code) => combo.traps.includes(code));
  const worstOf = (route: SavedRoute | undefined, trap: number) => {
    const choke = route?.chokes?.find((one) => one.trap === trap);
    if (!choke) return null;
    return choke.windows.length ? Math.min(...choke.windows.map((window) => window.interruptions)) : (route?.interruptions?.length ?? 0);
  };
  // a full-board start: 1 life, plus 1 if it plays through each held hand trap alone, plus all of them if it plays
  // through them together
  const livesOf = (code: number) => {
    const route = routeOf(code);
    if (!isFull(route)) return 0;
    if (sameSet(route?.combo) && route!.combo!.interruptions >= fullAt) return 1 + holding.length;
    const each = holding.map((trap) => worstOf(route, trap));
    return each.every((worst) => worst !== null && worst >= fullAt) ? 2 : 1;
  };
  const together = useMemo(() => {
    if (holding.length < 2 || !startCardsAll.some((card) => sameSet(routeOf(card.code)?.combo))) return null;
    return throughMany(main, second ? 6 : 5, livesOf, holding.length);
  }, [main, second, deck.routes, fullAt, deck.opponentTraps]);
  const toggleHeld = (trap: number) => {
    const next = holding.includes(trap) ? holding.filter((code) => code !== trap) : [...holding, trap].slice(-3);
    // none picked is allowed: no hand traps
    onChange({ ...deck, opponentTraps: next, updated: Date.now() });
  };
  // each line checked from the hand it was played with (its moves only make sense from there)
  const checkAgain = () => onCheckChokes(Object.entries(routes).flatMap(([code, route]) => (route.keys && route.record?.startHand?.length ? [{ code: Number(code), hand: route.record.startHand }] : [])));
  const through = useMemo(
    () =>
      trapCodes.map((trap) => {
        const verdict = (code: number): "through" | "full" | "no" => {
          const route = routeOf(code);
          if (!isFull(route)) return "no";
          const choke = route?.chokes?.find((one) => one.trap === trap);
          // never usable against this line, or its worst moment still leaves a full board
          const worst = !choke ? 0 : choke.windows.length ? Math.min(...choke.windows.map((window) => window.interruptions)) : (route?.interruptions?.length ?? 0);
          return choke && worst >= fullAt ? "through" : "full";
        };
        return { trap, odds: throughOdds(main, second ? 6 : 5, verdict) };
      }),
    [trapCodes, main, second, deck.routes, fullAt],
  );

  // the Test headline: a full board against exactly what the opponent holds (none, one, or several together)
  const lined = startCards.filter((card) => routes[card.code]).length;
  const headline = !reached ? null : holding.length === 0 ? reached.combo : holding.length === 1 ? (through.find((one) => one.trap === holding[0])?.odds ?? null) : together;
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
  const count = (...roles: Role[]) => main.filter((card) => roles.some((role) => hasRole(card.tag, role))).reduce((sum, card) => sum + card.count, 0);
  const untagged = count("none");
  const normalCards = main.filter((card) => card.tag.normal);
  const normalCount = normalCards.reduce((sum, card) => sum + card.count, 0);
  // what the engine's lines take from the Deck: candidates for "Combo piece in the Deck"
  // each card's deckbuilding traits, asked for once
  useEffect(() => {
    const missing = main.map((card) => card.code).filter((code) => !traits.has(code));
    if (missing.length) requestTraits(missing);
  }, [main]);
  const takenBy = useMemo(() => {
    const map = new Map<number, number[]>();
    // credited to the card whose effect took it (Afterglow takes Galaxy-Eyes Photon Dragon in a Schwarzschild line), not to the
    // line's start; evidence from before this was recorded credits no one until the deck is checked again
    for (const entry of evidence.values())
      entry.alone.taken.forEach((code, at) => {
        const by = entry.alone.takers?.[at];
        if (by && by !== code && !(map.get(code) ?? []).includes(by)) map.set(code, [...(map.get(code) ?? []), by]);
      });
    return map;
  }, [evidence]);
  const hasStart = count("starter", "pair") > 0;


  const setTag = (key: number, tag: Tag) => {
    const clean: Tag = hasRole(tag, "pair") ? { role: tag.role, with: tag.with ?? { codes: [], attributes: 0, levels: [] } } : { role: tag.role };
    if (tag.roles && tag.roles.length > 1) clean.roles = tag.roles;
    if (tag.second) clean.second = true;
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
  // roles are multiple choice: a card can be a hand trap and a board breaker. Starter and "needs a partner" exclude each
  // other; Other means none of the rest.
  const PRIMARY: Role[] = ["starter", "pair", "digger", "extender", "piece", "handtrap", "breaker", "brick", "other"];
  const toggleRole = (key: number, role: Role) => {
    const old = tagOf(key);
    let roles: Role[] = rolesOf(old).filter((one) => one !== "none" && one !== "handtrap2");
    if (roles.includes(role)) roles = roles.filter((one) => one !== role);
    else if (role === "other") roles = ["other"];
    else roles = [...roles.filter((one) => one !== "other" && !(role === "starter" && one === "pair") && !(role === "pair" && one === "starter")), role];
    roles.sort((a, b) => PRIMARY.indexOf(a) - PRIMARY.indexOf(b));
    const primary = roles[0] ?? "none";
    setTag(key, { role: primary, roles, with: roles.includes("pair") ? old.with : undefined, normal: old.normal, second: roles.includes("handtrap") ? old.second : undefined });
    if (role === "pair" && roles.includes("pair") && !old.with) setPartnerFor(key);
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
        ...(count("digger") ? ([["Start from draw power", odds.dig, "no start in hand, and draw power finds one (already in Open a combo)"]] as [string, number, string][]) : []),
      ];

  const sorted = [...main].sort((a, b) => ORDER.indexOf(a.tag.role) - ORDER.indexOf(b.tag.role) || nameOf(a.code).localeCompare(nameOf(b.code)));
  const partnerCard = partnerFor !== null ? main.find((card) => card.code === partnerFor) : undefined;

  // the card whose roles are open for changing (the rest show only the roles they have)
  const [editingRoles, setEditingRoles] = useState<number | null>(null);
  const [explained, setExplained] = useState<{ code: number; full: string } | null>(null);
  // the odds row or warning whose words are showing (tapped)
  const [said, setSaid] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [explain, setExplain] = useState(false);
  // the phone's back button closes the hand trap picker first
  useEffect(() => {
    testOverlay.close = () => (picking ? (setPicking(false), true) : false);
    return () => {
      testOverlay.close = () => false;
    };
  }, [picking]);
  const [tab, setTab] = useState<"odds" | "cards" | "lines">(() => {
    try {
      const saved = localStorage.getItem("rka.optTab");
      return saved === "cards" ? "cards" : "odds";
    } catch {
      return "odds";
    }
  });
  const openTab = (next: typeof tab) => {
    setTab(next);
    try {
      localStorage.setItem("rka.optTab", next);
    } catch {
      // the tab just isn't remembered
    }
  };
  // the hand traps to check against: the ones you tag as hand traps, then the common staples
  const trapChoices = [...new Set([...main.filter((card) => hasRole(card.tag, "handtrap") && !secondOnly(card.tag)).map((card) => card.code), ...CHOKE_TRAPS])];
  const warnings = [
    untagged > 0 && { text: `${untagged} card${untagged === 1 ? "" : "s"} not tagged`, glyphs: ["dead"], value: `${untagged} ?`, action: { label: "Tag as Other", run: tagRest } },
    normalCount > normalLimit(total) && { text: `${normalCount} Normal Summon cards (two in hand: ${pct(first.normal2)})`, glyphs: ["n", "n"], value: pct(first.normal2) },
    !count("breaker") && { text: "No board breakers", glyphs: ["nobreak"], value: "0" },
    count("handtrap") > 0 && secondOdds.handtrap < 0.75 && { text: `A hand trap going 2nd: only ${pct(secondOdds.handtrap)}`, glyphs: ["hand"], value: `2ND ${pct(secondOdds.handtrap)}` },
  ].filter(Boolean) as { text: string; glyphs: Mini[]; value: string; action?: { label: string; run: () => void } }[];
  const ROLE_CHIPS: { role: Role; label: string }[] = [
    { role: "starter", label: "Starter" },
    { role: "pair", label: "Needs a partner" },
    { role: "extender", label: "Extender" },
    { role: "piece", label: "In-Deck piece" },
    { role: "handtrap", label: "Hand trap" },
    { role: "breaker", label: "Breaker" },
    { role: "brick", label: "Brick" },
    { role: "digger", label: "Draw power" },
    { role: "other", label: "Other" },
  ];

  return (
    <div className="optimiser">
      {!only && (
        <div className="segmented two opt-tabs">
          {(["odds", "cards"] as const).map((name) => (
            <button key={name} className={`button small ${tab === name ? "on" : ""}`} onClick={() => openTab(name)}>
              {name === "odds" ? "Odds" : "Cards"}
            </button>
          ))}
        </div>
      )}

      {!main.length && <p className="muted">Add cards to the Main Deck to get started.</p>}

      {main.length > 0 && !only && tab === "odds" && (
        <>
          <div className="opt-turns">
            <button className={second ? "" : "on"} onClick={() => setSecond(false)} aria-label="Going first, 5 cards">
              1ST · 5
            </button>
            <button className={second ? "on" : ""} onClick={() => setSecond(true)} aria-label="Going second, 6 cards">
              2ND · 6
            </button>
          </div>
          <div className="opt-big">
            <b>
              {(odds.combo * 100).toFixed(1)}
              <small>%</small>
            </b>
            <span>
              <MiniCards kinds={["play"]} />
              <em className={`grade grade-${grade(odds.combo).toLowerCase()}`}>{grade(odds.combo)}</em>
              <small className="muted" title="The engine played every card alone and with each other card">
                Engine-checked {engineChecked ? pct(engineChecked.combo) : engineProgress?.total ? `${engineProgress.done}/${engineProgress.total}` : "…"}
                {(everyStartProven || proven.combo > 0) && ` · proven ${pct(everyStartProven ? odds.combo : proven.combo)}`}
              </small>
            </span>
          </div>
          {engineProgress && engineProgress.total > 0 && (
            <span className="opt-bar opt-progress">
              <i style={{ width: `${(engineProgress.done / engineProgress.total) * 100}%` }} />
            </span>
          )}
          <ul className="opt-odds">
            {rows.map(([label, value, note]) => (
              <li key={label}>
                <button onClick={() => setSaid(said === label ? null : label)} aria-label={`${label}: ${pct(value)}`}>
                  <MiniCards kinds={ROW_GLYPHS[label] ?? ["play"]} />
                  <span className="opt-bar">
                    <i style={{ width: `${value * 100}%` }} />
                  </span>
                  <b>{pct(value)}</b>
                </button>
                {said === label && (
                  <p className="trait-said">
                    {label}
                    {note ? ` · ${note}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <RoleStrip cards={main.map((card) => ({ count: card.count, role: rolesOf(card.tag)[0] ?? "none" }))} />
          {warnings.length > 0 && (
            <div className="opt-warnings">
              {warnings.map((warning) => (
                <span key={warning.text} className="opt-warning">
                  <button onClick={() => setSaid(said === warning.text ? null : warning.text)} aria-label={warning.text}>
                    <MiniCards kinds={warning.glyphs} />
                    <b>{warning.value}</b>
                  </button>
                  {warning.action && (
                    <button className="opt-link" onClick={warning.action.run}>
                      {warning.action.label}
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {warnings.some((warning) => warning.text === said) && <p className="trait-said">{said}</p>}
          {(deck.results ?? []).length > 0 && <Measured results={deck.results ?? []} deck nameOf={nameOf} />}
          <DeckSize main={main} side={side} room={room} nameOf={nameOf} takenBy={takenBy} />
          <Clashes main={main} nameOf={nameOf} traits={traits} />
          {Object.keys(routes).length > 0 && (
            <div className="opt-from-lines">
              <h3 className="section-label">FROM YOUR LINES</h3>
              {reached && (
                <span className="opt-through-row" aria-label="Full board, no hand traps">
                  <MiniCards kinds={["play"]} />
                  <b>{pct(reached.combo)}</b>
                </span>
              )}
              {through.length > 0 && reached && (
                <div className="opt-through-list">
                  {through.map(({ trap, odds: value }) => (
                    <span key={trap} className="opt-through-row" aria-label={`Full board through ${nameOf(trap)}`} title={`Full board through ${nameOf(trap)}`}>
                      <span className="mini-card">
                        <CardArt code={trap} />
                      </span>
                      <b>{pct(value)}</b>
                    </span>
                  ))}
                </div>
              )}
              <TwoStarts routes={routes} nameOf={nameOf} />
              <CutTest main={main} lines={Object.keys(routes).length} nameOf={nameOf} result={cutResult} onTest={onCutTest} />
            </div>
          )}
        </>
      )}

      {main.length > 0 && !only && tab === "cards" && (
        <div className="opt-tags">
          {sorted.map((card) => {
            const roles = rolesOf(card.tag);
            const start = roles.includes("starter") || roles.includes("pair");
            return (
              <div className={`opt-tag ${card.tag.role === "none" ? "untagged" : ""}`} key={card.code}>
                <button className={`opt-thumb framed ${frameOf(cards.get(card.code)?.type ?? 0)} ${start ? "lit" : ""}`} onClick={() => onShow(card.code)} aria-label={`Read ${nameOf(card.code)}`}>
                  <CardArt code={card.code} />
                  <span className="opt-count">×{card.count}</span>
                  <RoleBadges roles={card.tag.role === "none" ? [] : roles} />
                </button>
                <div className="opt-tag-text">
                  <button className="opt-name" onClick={() => onShow(card.code)}>
                    {nameOf(card.code)}
                    {card.tag.engine && <span className="opt-guess engine">engine</span>}
                  </button>
                  <TraitGlyphs traits={traits.get(card.code) ?? []} normal={start && card.tag.normal} open={explained?.code === card.code ? explained.full : null} onOpen={(full) => setExplained(full ? { code: card.code, full } : null)} />
                  <div className="opt-role-chips">
                    {editingRoles === card.code &&
                      ROLE_CHIPS.map((chip) => (
                        <button key={chip.role} className={`opt-chip ${roles.includes(chip.role) ? "on" : ""}`} onClick={() => toggleRole(card.code, chip.role)}>
                          {chip.label}
                        </button>
                      ))}
                    <button className={`opt-chip ${card.tag.role === "none" ? "warn" : ""}`} onClick={() => setEditingRoles(editingRoles === card.code ? null : card.code)} aria-label={editingRoles === card.code ? "Done" : `Change the roles of ${nameOf(card.code)}`}>
                      {editingRoles === card.code ? "Done" : card.tag.role !== "none" ? "✎ Roles" : "Set role"}
                    </button>
                    {editingRoles === card.code && roles.includes("handtrap") && (
                      <button className={`opt-chip ${secondOnly(card.tag) ? "on" : ""}`} onClick={() => setTag(card.code, { ...card.tag, second: !secondOnly(card.tag) })} title="Only works going second, like the Mulcharmy cards">
                        2nd only
                      </button>
                    )}
                    {editingRoles === card.code &&
                      roles.includes("digger") &&
                      digChoices(card.code).length > 1 &&
                      digChoices(card.code).map((depth) => (
                        <button key={depth} className={`opt-chip ${card.tag.dig === depth ? "on" : ""}`} onClick={() => setTag(card.code, { ...card.tag, dig: depth })} title="How many cards it sees: banishing fewer from the Extra Deck sees fewer">
                          Sees {depth}
                        </button>
                      ))}
                    {editingRoles === card.code && start && (
                      <button className={`opt-chip ${card.tag.normal ? "on" : ""}`} onClick={() => setTag(card.code, { ...card.tag, normal: !card.tag.normal })} title="Its line uses the turn's Normal Summon">
                        Normal Summon
                      </button>
                    )}
                  </div>
                  {roles.includes("pair") && (
                    <button className="opt-partners" onClick={() => setPartnerFor(card.code)} aria-label={`Partners: ${card.tag.with && withAny(card.tag.with.codes) && !card.tag.with.attributes && !card.tag.with.levels.length ? "any other card" : describePartners(card.tag.with, nameOf)}. Edit`}>
                      <span className="partners-with">+</span>
                      {card.tag.with && withAny(card.tag.with.codes) && !card.tag.with.attributes && !card.tag.with.levels.length ? (
                        <span className="partners-any">ANY</span>
                      ) : card.tag.with && !card.tag.with.attributes && !card.tag.with.levels.length && card.tag.with.codes.length ? (
                        <>
                          {card.tag.with.codes.slice(0, 5).map((code) => (
                            <span key={code} className="mini-card plain">
                              <CardArt code={code} />
                            </span>
                          ))}
                          {card.tag.with.codes.length > 5 && <b className="partners-more">+{card.tag.with.codes.length - 5}</b>}
                        </>
                      ) : (
                        <span className="partners-text">{describePartners(card.tag.with, nameOf)}</span>
                      )}
                      <span className="partners-edit">✎</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {main.length > 0 && only === "lines" && (
        <>
          {/* 1. the setup: who you play against, what counts as a full board, and your own settings */}
          <section className="test-setup">
            <button className="setup-holds" onClick={() => setPicking(!picking)} aria-expanded={picking}>
              <span className="setup-label">VS</span>
              {holding.length ? (
                holding.map((trap) => (
                  <span key={trap} className="mini-card held" title={nameOf(trap)}>
                    <CardArt code={trap} />
                  </span>
                ))
              ) : (
                <span className="setup-none">no hand traps</span>
              )}
              <span className="setup-change">{picking ? "Done" : "Change"}</span>
            </button>
            {holding.length > 0 && (
              <div className="segmented two trap-timing" role="group" aria-label="How the opponent uses its hand traps">
                {(["smart", "instant"] as const).map((timing) => (
                  <button key={timing} className={`button small ${(deck.trapTiming ?? "smart") === timing ? "on" : ""}`} onClick={() => onChange({ ...deck, trapTiming: timing, updated: Date.now() })}>
                    {timing === "smart" ? "SMART" : "FIRST CHANCE"}
                  </button>
                ))}
              </div>
            )}
            {picking && (
              <div className="trap-picks">
                {trapChoices.map((trap) => (
                  <button key={trap} className={`trap-pick ${holding.includes(trap) ? "on" : ""}`} onClick={() => toggleHeld(trap)} aria-pressed={holding.includes(trap)}>
                    <span className="trap-pick-art">
                      <CardArt code={trap} />
                    </span>
                    <span className="trap-pick-name">{nameOf(trap)}</span>
                  </button>
                ))}
              </div>
            )}
            {explain && (
              <p className="trait-said setup-said">
                <b>VS</b> the hand traps the opponent holds (a dud deck) · <b>SMART</b> it uses each one as a strong player would: only on what it stops, at the moment your saved line suffers most · <b>FIRST CHANCE</b> at the first legal moment · <b>FULL ≥</b> interruptions that count as a full board · <b>HAND</b> cards in a random hand · <b>MY ✋</b> whether your own hand traps can chain on your turn
              </p>
            )}
            <div className="setup-row">
              <button className={`icon-button small setup-info ${explain ? "on" : ""}`} onClick={() => setExplain(!explain)} aria-label="What these settings mean" aria-expanded={explain}>
                ⓘ
              </button>
              <Stepper label="FULL ≥" value={fullAt} min={1} max={8} suffix="INT" title="A full board: at least this many interruptions (effects usable on the opponent's turn that negate or remove)" onChange={(value) => onChange({ ...deck, fullAt: value, results: rescored(deck.results, value), updated: Date.now() })} />
              {setup}
            </div>
          </section>

          {/* 2. the one number: how often your hand reaches a full board against what the opponent holds */}
          <span className="headline-label">FULL BOARD</span>
          <div className="test-headline">
            <b className={headline === null ? "empty" : ""}>{headline === null ? "–%" : pct(headline)}</b>
            <span className="headline-note">
              {lined === 0 ? "Play a start ▶, then save it as a working line" : headline === null ? "↻ to check vs these hand traps" : `${lined}/${startCards.length} starts have a line`}
            </span>
            {Object.keys(routes).length > 0 && (
              <button className="icon-button small" disabled={!!routing || !!choking} onClick={checkAgain} aria-label="Check the lines against hand traps again" title="Check the lines against hand traps again">
                ↻
              </button>
            )}
          </div>
          {choking && <span className="opt-chokes">Checking hand traps against your lines…</span>}

          {play}

          {/* 3. each start: test it, and the line you saved for it */}
          <h3 className="section-label">STARTS</h3>
          {startCards.length === 0 && <p className="muted">Tag your starters in Optimise › Cards.</p>}
          {startCards.map((card) => (
            <div key={card.code} className="opt-line">
              <div className="opt-line-head">
                <span className={`opt-thumb framed small ${frameOf(cards.get(card.code)?.type ?? 0)}`} aria-hidden="true">
                  <CardArt code={card.code} />
                </span>
                <b>{nameOf(card.code)}</b>
                <StartRecord results={(deck.results ?? []).filter((one) => one.start === card.code)} nameOf={nameOf} />
                <button
                  className="play-round"
                  aria-label={`Test ${nameOf(card.code)}`}
                  onClick={() => {
                    const hand = neededHand(card);
                    if (hand) onTest(hand.map((code) => held.get(code) ?? code));
                  }}
                  disabled={!neededHand(card)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 4v16l13-8z" />
                  </svg>
                </button>
              </div>
              {routes[card.code] && (
                <RouteLine
                  route={routes[card.code]}
                  fullAt={fullAt}
                  full={isFull(routes[card.code])}
                  checking={choking?.code === card.code ? "now" : choking?.waiting.includes(card.code) ? "waiting" : null}
                  fresh={!!routeOf(card.code)}
                  searching={null}
                  waiting={false}
                  nameOf={nameOf}
                  onWatch={() => routes[card.code] && onWatchLine(routes[card.code].record, card.code)}
                />
              )}
            </div>
          ))}
        </>
      )}

      {partnerCard && (
        <PartnerSheet
          card={partnerCard}
          main={main}
          nameOf={nameOf}
          onSave={(partners) => setTag(partnerCard.code, { ...partnerCard.tag, role: partnerCard.tag.role === "starter" ? "pair" : partnerCard.tag.role, with: partners })}
          onClose={() => setPartnerFor(null)}
        />
      )}
    </div>
  );
}

// What the route search found from this start's test hand
function RouteLine({ route, full, fullAt, checking, fresh, searching, waiting, nameOf, onWatch }: { route?: SavedRoute; full: boolean; fullAt: number; checking: "now" | "waiting" | null; fresh: boolean; searching: number | null; waiting: boolean; nameOf: (code: number) => string; onWatch: () => void }) {
  if (searching !== null) return <span className="opt-engine">Searching for a line… {searching} tried</span>;
  if (waiting) return <span className="opt-engine">Waiting to search</span>;
  const [said, setSaid] = useState<string | null>(null);
  if (!route) return null;
  const stops = route.interruptions ?? [];
  const say = (text: string) => setSaid(said === text ? null : text);
  const stopsText = stops.length ? `${stops.length} interruption${stops.length > 1 ? "s" : ""}: ${stops.map((one) => describeInterruption(one, nameOf)).join(", ")}` : "No interruptions";
  const protectText = route.protection?.length ? `Protection on their turn: ${route.protection.map((one) => describeProtection(one, nameOf)).join(" · ")}` : "";
  const nibiruText = route.nibiru ? describeNibiru(route.nibiru, nameOf) : "";
  const combo = route.combo;
  const comboText = combo
    ? `${combo.traps.map(nameOf).join(" + ")} together: ${
        combo.steps.length
          ? `${combo.steps.map((step) => `${nameOf(step.trap)} on ${step.at}`).join(", then ")} → ${combo.interruptions >= fullAt ? `still ${combo.interruptions}` : combo.interruptions === 0 ? "0: stops the line" : combo.interruptions}${combo.unused.length ? ` (${combo.unused.map(nameOf).join(", ")} not needed)` : ""}`
          : "never usable against this line"
      }`
    : "";
  const tone = (count: number) => (count >= fullAt ? "good" : count === 0 ? "bad" : "warn");
  return (
    <div className={`route-line ${full ? "full" : ""}`}>
      <div className="route-needs" aria-label={route.needs ? `This line needs ${route.needs.map(nameOf).join(" + ")}${route.any ? ` and ${route.any} other card${route.any === 1 ? "" : "s"}` : ""}` : "Working out which cards this line needs"}>
        <small>NEEDS</small>
        {route.needs ? (
          <>
            {route.needs.map((code, at) => (
              <span key={at} className="mini-card plain" title={nameOf(code)}>
                <CardArt code={code} />
              </span>
            ))}
            {route.any ? <b className="needs-any">+{route.any}</b> : null}
          </>
        ) : (
          <span className="muted">…</span>
        )}
      </div>
      {route.board.length > 0 && <EndBoard board={route.board} interruptions={stops} nameOf={nameOf} />}
      <div className="route-marks">
        <button className={`int-badge ${tone(stops.length)} ${said === stopsText ? "on" : ""}`} onClick={() => say(stopsText)} aria-label={stopsText}>
          {stops.length}
          <small>INT</small>
          {full && <span aria-hidden="true">✓</span>}
        </button>
        {route.nibiru && (
          <button className={`route-mark ${route.nibiru.proof ? "good" : "warn"} ${said === nibiruText ? "on" : ""}`} onClick={() => say(nibiruText)} aria-label={nibiruText}>
            <span className="mini-card">
              <CardArt code={27204311} />
            </span>
            {route.nibiru.proof ? "✓" : "✕"}
          </button>
        )}
        {protectText && (
          <button className={`route-mark good ${said === protectText ? "on" : ""}`} onClick={() => say(protectText)} aria-label={protectText}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" />
            </svg>
          </button>
        )}
        {combo && !checking && (
          <button className={`route-mark ${tone(combo.steps.length ? combo.interruptions : fullAt)} ${said === comboText ? "on" : ""}`} onClick={() => say(comboText)} aria-label={comboText}>
            {combo.traps.map((trap) => (
              <span key={trap} className="mini-card">
                <CardArt code={trap} />
              </span>
            ))}
            → {combo.steps.length ? combo.interruptions : "–"}
          </button>
        )}
        {!fresh && (
          <span className="route-mark warn" title="The deck changed since this line">
            Δ
          </span>
        )}
        <button className="route-watch" onClick={onWatch} aria-label="Watch the line">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4v16l13-8z" />
          </svg>
          Watch
        </button>
      </div>
      {said && <p className="trait-said">{said}</p>}
      {checking === "now" && <span className="opt-chokes">Checking hand traps against this line…</span>}
      {checking === "waiting" && <span className="opt-chokes">Hand traps next</span>}
      {!checking && route.chokes && route.chokes.length > 0 && <Chokes chokes={route.chokes} fullAt={fullAt} nameOf={nameOf} />}
    </div>
  );
}

// Each hand trap at its worst moment for this line, worst first; every moment one tap away
function Chokes({ chokes, fullAt, nameOf }: { chokes: Choke[]; fullAt: number; nameOf: (code: number) => string }) {
  const rows = chokes
    .map((choke) => {
      const worst = choke.windows.reduce<Choke["windows"][number] | null>((low, window) => (!low || window.interruptions < low.interruptions ? window : low), null);
      return { choke, worst };
    })
    .sort((a, b) => (a.worst?.interruptions ?? 99) - (b.worst?.interruptions ?? 99));
  const verdict = (count: number, clean: number) => (count >= fullAt ? `still ${count}` : count === 0 ? "0: stops the line" : count < clean ? `${count} of ${clean}` : `${count}`);
  return (
    <details className="opt-chokes">
      <summary>
        Choke points:{" "}
        {rows
          .filter(({ worst, choke }) => worst && worst.interruptions < choke.clean)
          .slice(0, 3)
          .map(({ choke, worst }) => `${nameOf(choke.trap)} on ${worst!.at} → ${verdict(worst!.interruptions, choke.clean)}`)
          .join(" · ") || "no hand trap costs this line anything"}
      </summary>
      <ul>
        {rows.map(({ choke, worst }) => (
          <li key={choke.trap}>
            <b>{nameOf(choke.trap)}</b>:{" "}
            {!worst
              ? "never usable against this line"
              : choke.windows
                  .slice()
                  .sort((a, b) => a.interruptions - b.interruptions)
                  .map((window) => `on ${window.at} → ${verdict(window.interruptions, choke.clean)}${window.replanned ? " (best way through)" : ""}`)
                  .join("; ")}
          </li>
        ))}
      </ul>
    </details>
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


// How your tests went, split by the hand traps the opponent held: "no hand traps 3/4 · D.D. Crow 1/3", then what stopped the misses
function Measured({ results, deck = false, nameOf }: { results: TestResult[]; deck?: boolean; nameOf?: (code: number) => string }) {
  if (!results.length) return null;
  const groups = new Map<string, TestResult[]>();
  for (const one of results) {
    const key = one.held === undefined ? "?" : one.held.length ? one.held.map((code) => nameOf?.(code) ?? `#${code}`).join(" + ") : "no hand traps";
    groups.set(key, [...(groups.get(key) ?? []), one]);
  }
  const misses = new Map<string, number>();
  for (const one of results) {
    if (one.kind === "full") continue;
    const reason = one.kind === "handtrap" ? one.why.split(":")[0] : one.kind === "brick" ? "no start in hand" : "fell short";
    misses.set(reason, (misses.get(reason) ?? 0) + 1);
  }
  return (
    <span className={`opt-engine measured ${deck ? "deck" : ""}`}>
      {[...groups].map(([key, list]) => `${key === "?" ? "earlier tests" : key} ${list.filter((one) => one.kind === "full").length}/${list.length}`).join(" · ")}
      {misses.size > 0 && (
        <small className="muted">
          {" "}
          · missed: {[...misses].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${reason}${count > 1 ? ` ×${count}` : ""}`).join(" · ")}
        </small>
      )}
    </span>
  );
}

// Is every card above 40 worth what it dilutes? The deck at each size down to 40, cutting what costs least, and a verdict
function DeckSize({ main, side, room, nameOf, takenBy }: { main: DeckCard[]; side: DeckCard[]; room: (code: number) => number; nameOf: (code: number) => string; takenBy: Map<number, number[]> }) {
  // your changes to try: copies taken out and added, at any size
  const [added, setAdded] = useState<number[]>([]);
  // the engine, by what each card does: starts; pieces your starts pull from the Deck (wanted there, weak to draw); the rest
  const isStart = (card: DeckCard) => card.tag.role === "starter" || card.tag.role === "pair";
  const isPiece = (card: DeckCard) => !isStart(card) && (card.tag.role === "piece" || (takenBy.has(card.code) && !["handtrap", "handtrap2", "breaker"].includes(card.tag.role)));
  const engineCards = main.filter((card) => !["handtrap", "handtrap2", "breaker"].includes(card.tag.role));
  const startCount = engineCards.filter(isStart).reduce((sum, card) => sum + card.count, 0);
  const pieceCards = engineCards.filter(isPiece);
  const pieceCount = pieceCards.reduce((sum, card) => sum + card.count, 0);
  // a one-of that's only ever pulled from the Deck: keep it only if it gives a line or a way through a hand trap that
  // nothing else gives
  const singleDuty = pieceCards.filter((card) => card.count === 1);
  const { rows: all, nonEngine, total } = useMemo(() => deckSizes(main), [main]);
  // only your deck as it is: the size check makes no cuts of its own (you pick yours below)
  const auto = all.slice(0, 1);
  // your own choice of what goes: tap the cards you'd take out to reach 40
  const [out, setOut] = useState<number[]>([]);
  const [sizeSaid, setSizeSaid] = useState(false);
  const mine = out.length ? withoutCards(main, out) : null;
  const rows = mine ? [...auto, mine] : auto;
  const now = rows[0];
  const forty = auto.find((row) => row.total === 40 && row !== now);
  const plus = auto.find((row) => row.added);
  // one number to judge a change by: starts count double (you need them every game), then a hand trap kept going
  // first and two going second (half your games): positive means the change is better
  const worth = (after: SizeRow) => (after.combo1 - now.combo1) * 2 + (after.comboTrap1 - now.comboTrap1) + (after.traps2 - now.traps2);
  const judge = (after: SizeRow, size: string) =>
    worth(after) > 0.02 ? `On balance the ${size} is better.` : worth(after) < -0.02 ? `On balance your ${total} is better: the extra cards are worth their dilution.` : "Close either way: which matters more to you decides it.";
  const delta = (after: number, before: number) => `${after >= before ? "+" : ""}${((after - before) * 100).toFixed(1)}%`;
  const names = (codes: number[]) => {
    const tally = new Map<number, number>();
    codes.forEach((code) => tally.set(code, (tally.get(code) ?? 0) + 1));
    return [...tally].map(([code, n]) => `${n > 1 ? `${n}× ` : ""}${nameOf(code)}`).join(", ");
  };
  const verdict =
    total === 40
      ? "40 cards: your best draws come up as often as they can."
      : `${total} cards: each card above 40 dilutes your best draws. Tap the cards you'd take out below to see what reaching 40 would cost and gain.`;
  // against what YCS top cut decks of this size play
  const sizes = Object.keys(TOP_CUT.nonEngineBySize).map(Number);
  const near = sizes.reduce((best, size) => (Math.abs(size - total) < Math.abs(best - total) ? size : best), 40);
  const theirs = TOP_CUT.nonEngineBySize[near];
  const engine = total - nonEngine;
  return (
    <div className="opt-size">
      <button className={`size-bar ${sizeSaid ? "on" : ""}`} onClick={() => setSizeSaid(!sizeSaid)} aria-label={`${total} cards: non-engine ${nonEngine}, engine ${engine}; YCS top cut at ${near} plays ${theirs.toFixed(0)} non-engine`}>
        <b>{total}</b>
        <span className="size-track">
          <i style={{ width: `${(nonEngine / total) * 100}%` }} />
          <em style={{ left: `${(theirs / near) * 100}%` }} />
        </span>
        <small>YCS</small>
      </button>
      <div className="size-chips" aria-hidden="true">
        <span className="size-chip"><MiniCards kinds={["play"]} /><b>{startCount}</b></span>
        <span className="size-chip"><MiniCards kinds={["piece"]} /><b>{pieceCount}</b></span>
        <span className="size-chip"><MiniCards kinds={["hand"]} /><b>{nonEngine}</b></span>
      </div>
      {sizeSaid && (
        <p className="trait-said">
          {total} cards. Starts {startCount}, in-Deck pieces {pieceCount}, engine {engine} in all; non-engine {nonEngine} ({Math.round((nonEngine / total) * 100)}%, the pink bar). YCS top cut decks at {near} cards play {theirs.toFixed(0)} non-engine (the gold mark) and {(near - theirs).toFixed(0)} engine: {TOP_CUT.decks} decks from ten 2025 YCS top 32s.
        </p>
      )}
      <details className="opt-compare">
        <summary>Try changes: take out or add cards</summary>
        <div className="opt-try">
          {[...main, ...side.filter((card) => !main.some((own) => own.code === card.code))].map((card) => {
            const taken = out.filter((code) => code === card.code).length;
            const put = added.filter((code) => code === card.code).length;
            const inMain = main.some((own) => own.code === card.code);
            const have = (main.find((own) => own.code === card.code)?.count ?? 0) - taken + put;
            return (
              <div key={card.code} className={`opt-try-row ${taken || put ? "changed" : ""}`}>
                <span>
                  {nameOf(card.code)} <span className="muted">{inMain ? `×${have}` : `Side ×${have}`}</span>
                </span>
                <button className="button small" disabled={have <= 0} onClick={() => (put ? setAdded(added.filter((code, at) => at !== added.lastIndexOf(card.code))) : setOut([...out, card.code]))} aria-label={`One fewer ${nameOf(card.code)}`}>
                  −
                </button>
                <button className="button small" disabled={have >= 3 || room(card.code) - put + taken <= 0} onClick={() => (taken ? setOut(out.filter((code, at) => at !== out.lastIndexOf(card.code))) : setAdded([...added, card.code]))} aria-label={`One more ${nameOf(card.code)}`}>
                  +
                </button>
              </div>
            );
          })}
        </div>
        {(out.length > 0 || added.length > 0) && (
          <>
            <table className="opt-size-table">
              <thead>
                <tr>
                  <th />
                  <th>Combo 1st</th>
                  <th>+ trap</th>
                  <th>2 traps 2nd</th>
                  <th>Dead card</th>
                </tr>
              </thead>
              <tbody>
                {[now, tryChanges(main, side, out, added)].map((row, at) => (
                  <tr key={at} className={at === 0 ? "now" : ""}>
                    <td>{at === 0 ? `Now ${row.total}` : `Then ${row.total}`}</td>
                    <td>{(row.combo1 * 100).toFixed(1)}%</td>
                    <td>{(row.comboTrap1 * 100).toFixed(1)}%</td>
                    <td>{(row.traps2 * 100).toFixed(1)}%</td>
                    <td>{(row.dead * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="opt-link" onClick={() => (setOut([]), setAdded([]))}>
              Clear changes
            </button>
          </>
        )}
      </details>
    </div>
  );
}

// Cards that hurt each other in the same hand, for any deck: two that each need an empty field (only one gets it), and a
// second copy of a once-per-turn card (dead that turn unless it's used another way). With how often you open each.
function Clashes({ main, nameOf, traits }: { main: DeckCard[]; nameOf: (code: number) => string; traits: Map<number, string[]> }) {
  const total = main.reduce((sum, card) => sum + card.count, 0);
  // hypergeometric: the chance a 5-card hand holds exactly k of `copies` cards
  const choose = (n: number, k: number) => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return k < 0 || k > n ? 0 : r;
  };
  const exactly = (copies: number, k: number, hand = 5) => (choose(copies, k) * choose(total - copies, hand - k)) / choose(total, hand);
  const none = (copies: number) => exactly(copies, 0);
  const atLeastTwo = (copies: number) => 1 - exactly(copies, 0) - exactly(copies, 1);
  const has = (code: number, trait: string) => (traits.get(code) ?? []).some((one) => one.startsWith(trait));
  const empty = main.filter((card) => has(card.code, "needs an empty field"));
  const lines: { codes: number[]; kind: "empty" | "opt"; chance: number; text: string }[] = [];
  for (let a = 0; a < empty.length; a++)
    for (let b = a + 1; b < empty.length; b++) {
      const [x, y] = [empty[a], empty[b]];
      const both = 1 - none(x.count) - none(y.count) + none(x.count + y.count);
      lines.push({ codes: [x.code, y.code], kind: "empty", chance: both, text: `${nameOf(x.code)} + ${nameOf(y.code)}: both need an empty field` });
    }
  for (const card of main) {
    if (card.count < 2 || !has(card.code, "once per turn by name") || !["starter", "pair", "extender"].includes(card.tag.role)) continue;
    const two = atLeastTwo(card.count);
    if (two >= 0.02) lines.push({ codes: [card.code, card.code], kind: "opt", chance: two, text: `Two ${nameOf(card.code)}: once per turn, so the second is dead` });
  }
  const [said, setSaid] = useState<string | null>(null);
  if (!lines.length) return null;
  return (
    <div className="opt-note">
      <h3 className="section-label">CLASHES IN HAND</h3>
      <div className="clash-list">
        {lines.map((line) => (
          <button key={line.text} className={`clash ${said === line.text ? "on" : ""}`} onClick={() => setSaid(said === line.text ? null : line.text)} aria-label={`${line.text}: ${(line.chance * 100).toFixed(1)}%`}>
            <span className="clash-cards">
              {line.codes.map((code, at) => (
                <span key={at} className="mini-card plain">
                  <CardArt code={code} />
                </span>
              ))}
            </span>
            <span className="clash-why">{line.kind === "empty" ? "□" : "↻1"}</span>
            <b>{(line.chance * 100).toFixed(1)}%</b>
          </button>
        ))}
      </div>
      {said && <p className="trait-said">{said}</p>}
    </div>
  );
}

// Holding two starts: which line to lead with, from each line's own hand trap check. Against an opponent who uses a hand
// trap at the first chance (common, and how the computer opponent plays): lead with A and it lands on A's first moment
// if A has one, and you still play B in full; if A has none, it lands on B's first moment and you keep A's board.
// Leading with the line you'd rather lose shows up here as the better order. Against an opponent who waits for the
// worst moment, the order matters much less: that's said too.
function TwoStarts({ routes, nameOf }: { routes: Record<string, SavedRoute>; nameOf: (code: number) => string }) {
  const starts = Object.keys(routes)
    .map(Number)
    .filter((code) => routes[code].chokes?.length);
  if (starts.length < 2) return null;
  const clean = (code: number) => routes[code].interruptions?.length ?? 0;
  // A first, then B, against one hand trap used at its first chance
  const firstChance = (a: number, b: number, trap: number) => {
    const onA = routes[a].chokes!.find((one) => one.trap === trap);
    const onB = routes[b].chokes!.find((one) => one.trap === trap);
    if (onA?.windows.length) return { left: Math.max(onA.windows[0].interruptions, clean(b)), hit: a, at: onA.windows[0].at };
    if (onB?.windows.length) return { left: Math.max(clean(a), onB.windows[0].interruptions), hit: b, at: onB.windows[0].at };
    return { left: Math.max(clean(a), clean(b)), hit: null, at: null };
  };
  const traps = [...new Set(starts.flatMap((code) => routes[code].chokes!.map((one) => one.trap)))];
  const pairs: [number, number][] = [];
  starts.forEach((a, i) => starts.slice(i + 1).forEach((b) => pairs.push([a, b])));
  return (
    <div className="opt-note">
      <b title="From each line's hand trap check, against an opponent who uses a hand trap at the first chance. One who waits for the worst moment can hit either line, so then the order matters less.">Two starts: lead with</b>
      <ul className="opt-clashes">
        {pairs.map(([a, b]) => {
          const ab = traps.map((trap) => ({ trap, ...firstChance(a, b, trap) }));
          const ba = traps.map((trap) => ({ trap, ...firstChance(b, a, trap) }));
          const sum = (list: { left: number }[]) => list.reduce((total, one) => total + one.left, 0) / list.length;
          const [sa, sb] = [sum(ab), sum(ba)];
          const lead = sa >= sb ? a : b;
          const other = lead === a ? b : a;
          const mine = lead === a ? ab : ba;
          const theirs = lead === a ? ba : ab;
          const wins = mine.filter((one, at) => one.left > theirs[at].left);
          return (
            <li key={`${a}-${b}`}>
              {nameOf(a)} + {nameOf(b)}:{" "}
              {Math.abs(sa - sb) < 0.05
                ? "either order holds up the same."
                : `lead with ${nameOf(lead)}, then ${nameOf(other)}: ${Math.max(sa, sb).toFixed(1)} interruptions left on average, against ${Math.min(sa, sb).toFixed(1)} the other way.` +
                  (wins.length
                    ? ` Against ${wins.map((one) => nameOf(one.trap)).join(", ")}, the hand trap lands on ${nameOf(lead)} (${wins[0].at ?? "its first moment"}) and ${nameOf(other)}'s line still runs.`
                    : "")}{" "}
            </li>
          );
        })}
      </ul>
    </div>
  );
}


// What a card does for your lines: each worked line played as recorded, then without one copy of the card. Measured on
// your own lines, so it means the same for any deck; with no worked lines there is nothing to measure.
function CutTest({ main, lines, nameOf, result, onTest }: { main: DeckCard[]; lines: number; nameOf: (code: number) => string; result: { cut: number; lines?: { start: number; before: number; after: number; board: number[] }[] } | null; onTest: (code: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="opt-note cut-test">
      <h3 className="section-label">CUT TEST</h3>
      {lines === 0 ? (
        <p className="muted">Needs working lines.</p>
      ) : (
        <>
          <button className="button cut-open" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Done" : "Pick a card to take out"}
          </button>
          {open && (
            <div className="pick-grid cut-grid">
              {main.map((card) => (
                <button key={card.code} className={`pick-card ${result?.cut === card.code ? "on" : ""}`} onClick={() => (onTest(card.code), setOpen(false))} aria-label={`Replay my lines without one ${nameOf(card.code)}`}>
                  <span className="pick-art">
                    <CardArt code={card.code} />
                    <b>×{card.count}</b>
                  </span>
                  <span className="pick-name">{nameOf(card.code)}</span>
                </button>
              ))}
            </div>
          )}
          {result && (
            <div className="cut-result">
              <span className="cut-without" aria-label={`Without one ${nameOf(result.cut)}`}>
                <span className="mini-card plain cut">
                  <CardArt code={result.cut} />
                </span>
                −1
              </span>
              {!result.lines ? (
                <span className="muted">Replaying your lines…</span>
              ) : (
                result.lines.map((line) => (
                  <span key={line.start} className={`cut-line ${line.after < line.before ? "loss" : ""}`} aria-label={`${nameOf(line.start)} line: ${line.before} to ${line.after} interruptions`}>
                    <span className="mini-card plain">
                      <CardArt code={line.start} />
                    </span>
                    {line.before} → <b>{line.after}</b>
                  </span>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// a Main Deck card's frame colour, as the duel draws it
const frameOf = (type: number) => (type & 0x2 ? "spell" : type & 0x4 ? "trap" : "monster");

// each odds row as card symbols: what the hand holds
const ROW_GLYPHS: Record<string, Mini[]> = {
  "Open a combo": ["play"],
  "Combo + hand trap": ["play", "hand"],
  "Combo + 2 hand traps": ["play", "hand", "hand"],
  "Combo + extender": ["play", "plus"],
  "Hand trap in hand": ["hand"],
  "Two or more hand traps": ["hand", "hand"],
  "Board breaker in hand": ["break"],
  "Two Normal Summon cards": ["n", "n"],
  "Dead card in hand": ["dead"],
  "Start from draw power": ["dig", "play"],
};

// − value + in one line
function Stepper({ label, value, min, max, suffix, title, onChange }: { label: string; value: number; min: number; max: number; suffix?: string; title?: string; onChange: (value: number) => void }) {
  return (
    <span className="stepper" title={title}>
      <span className="stepper-label">{label}</span>
      <button className="button small" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`${label} fewer`}>
        −
      </button>
      <b>{value}</b>
      <button className="button small" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`${label} more`}>
        +
      </button>
      {suffix && <small>{suffix}</small>}
    </span>
  );
}
export { Stepper };

// a start's tests: full boards out of all, tap for how they went by the hand traps held and what the misses were
function StartRecord({ results, nameOf }: { results: TestResult[]; nameOf: (code: number) => string }) {
  const [open, setOpen] = useState(false);
  if (!results.length) return null;
  const full = results.filter((one) => one.kind === "full").length;
  const rate = full / results.length;
  return (
    <span className="start-record">
      <button className={`int-badge ${rate >= 0.75 ? "good" : rate >= 0.4 ? "warn" : "bad"}`} onClick={() => setOpen(!open)} aria-label={`${full} of ${results.length} tests reached a full board`}>
        {full}/{results.length}
      </button>
      {open && (
        <span className="start-record-detail">
          <Measured results={results} nameOf={nameOf} />
        </span>
      )}
    </span>
  );
}
