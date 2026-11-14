import { HAND_TRAPS, HAND_TRAPS_SECOND } from "./engine/handtraps.ts";
// Deck Optimiser: what every card in the Main Deck is for, turned into exact opening-hand odds and swaps worth making.
// v2's roles and exact maths (gframe/deck_optimizer.h) with v1's two-card starts (RKAPro lines.json): a card that only
// starts a combo together with a partner (Galaxy Soldier + a LIGHT monster) counts only when the partner is there too,
// and a hand trap used as that partner is no longer a hand trap you hold.
// Every possible hand is counted with its exact probability: no sampling, no rounding until the screen.
// Erasable TypeScript only, so Node can run it directly for the checks in tools/.

export type Role = "none" | "starter" | "pair" | "extender" | "piece" | "handtrap" | "handtrap2" | "breaker" | "brick" | "other";

export const ROLES: { role: Role; name: string; help: string }[] = [
  { role: "starter", name: "Starter", help: "Starts your combo by itself." },
  { role: "pair", name: "Starter with a partner", help: "Starts your combo only together with one of the cards you pick." },
  { role: "extender", name: "Extender", help: "Keeps the combo going or plays through a negate. Does nothing alone." },
  { role: "handtrap", name: "Hand trap", help: "Stops the opponent from your hand, going first or second." },
  { role: "handtrap2", name: "Hand trap, going 2nd", help: "Only works while you control no cards, like the Mulcharmy cards." },
  { role: "breaker", name: "Board breaker", help: "Clears the opponent's board when you go second." },
  { role: "piece", name: "Combo piece in the Deck", help: "The combo needs it in the Deck (searched or summoned from there). Dead if you draw it, but never suggested as a cut." },
  { role: "brick", name: "Brick", help: "Dead in the opening hand." },
  { role: "other", name: "Other", help: "Anything else: combo pieces you search, staples, traps." },
];
export const roleName = (role: Role) => ROLES.find((entry) => entry.role === role)?.name ?? "Not tagged";

// "Any LIGHT monster", "any Level 4 monster" and named cards; a card matches if any of them fits
export interface Partners {
  codes: number[];
  attributes: number;
  levels: number[];
}
export interface Tag {
  role: Role;
  with?: Partners;
  guessed?: boolean;
  // the start needs the turn's Normal Summon: a second such card in the same hand is dead
  normal?: boolean;
  // set by the engine probe (it played the card and saw it start), not by anyone
  engine?: boolean;
  // the start was played from the hand to a full board, with nothing else helping
  proven?: boolean;
  // ... shown by a saved test you marked as working, not ticked by hand
  provenByTest?: boolean;
}
export interface CardFacts {
  type: number;
  attribute: number;
  level: number;
}
export interface DeckCard {
  code: number;
  count: number;
  tag: Tag;
  facts?: CardFacts;
}

export const matchesPartner = (partners: Partners | undefined, card: DeckCard) =>
  !!partners &&
  (partners.codes.includes(card.code) ||
    (!!card.facts && (card.facts.type & 1) !== 0 && ((partners.attributes & card.facts.attribute) !== 0 || partners.levels.includes(card.facts.level))));

export interface Odds {
  hand: number;
  combo: number; // a starter, or a partnered starter with its partner
  comboExtender: number; // a combo start plus an Extender
  comboHandtrap: number; // a combo start plus a hand trap still in hand
  comboHandtrap2: number; // ... plus two
  handtrap: number; // at least one hand trap that works this turn
  handtrap2: number; // at least two
  handtrapAvg: number;
  breaker: number;
  dead: number; // at least one dead card: a Brick, a Combo piece, or a second Normal Summon card
  dead2: number;
  normal2: number; // two or more cards that need the Normal Summon
}

// At most 5 cards that need the Normal Summon in a 40-card deck (one per 8 cards)
export const normalLimit = (total: number) => Math.max(1, Math.floor(total / 8));

const choose = (() => {
  const table: number[][] = [];
  return (n: number, k: number): number => {
    if (k < 0 || n < 0 || k > n) return 0;
    const row = (table[n] ??= []);
    if (row[k] !== undefined) return row[k];
    let result = 1;
    const small = Math.min(k, n - k);
    for (let i = 1; i <= small; i++) result = (result * (n - small + i)) / i;
    return (row[k] = result);
  };
})();

// Cards the maths cannot tell apart are counted together: same role, same partner lists they belong to.
interface Group {
  count: number;
  role: Role;
  normal: boolean;
  partnerOf: number[]; // indexes of the partnered starters this group can be the partner for
}
function groupDeck(cards: DeckCard[]) {
  const pairs = cards.filter((card) => card.tag.role === "pair" && card.count > 0);
  const groups: Group[] = [];
  const pairGroup: number[] = [];
  const bySignature = new Map<string, number>();
  for (const card of cards) {
    if (card.count <= 0) continue;
    const partnerOf = pairs.flatMap((pair, index) => (matchesPartner(pair.tag.with, card) ? [index] : []));
    const pairIndex = pairs.indexOf(card);
    // a partnered starter keeps a group of its own, so the maths knows which card needs which partner
    const normal = !!card.tag.normal;
    const signature = pairIndex >= 0 ? `pair:${pairIndex}` : `${card.tag.role}:${normal}:${partnerOf.join(",")}`;
    let at = bySignature.get(signature);
    if (at === undefined) {
      at = groups.push({ count: 0, role: card.tag.role, normal, partnerOf }) - 1;
      bySignature.set(signature, at);
    }
    groups[at].count += card.count;
    if (pairIndex >= 0) pairGroup[pairIndex] = at;
  }
  // for each partnered starter: the groups holding its partners
  const partnerGroups = pairGroup.map((_, pairIndex) => groups.flatMap((group, at) => (group.partnerOf.includes(pairIndex) ? [at] : [])));
  return { groups, pairGroup, partnerGroups };
}

interface HandFacts {
  combo: boolean;
  handtraps: number; // usable this turn, after any spent as a partner
  extenders: number;
  breakers: number;
  bricks: number;
  normals: number;
}

function evaluate(counts: number[], deck: ReturnType<typeof groupDeck>, goingSecond: boolean): HandFacts {
  const { groups, pairGroup, partnerGroups } = deck;
  let starters = 0, handtraps = 0, extenders = 0, breakers = 0, bricks = 0, normals = 0;
  const usable = (role: Role) => role === "handtrap" || (goingSecond && role === "handtrap2");
  groups.forEach((group, at) => {
    const held = counts[at];
    if (!held) return;
    if (group.role === "starter") starters += held;
    else if (usable(group.role)) handtraps += held;
    else if (group.role === "extender") extenders += held;
    else if (group.role === "breaker") breakers += held;
    else if (group.role === "brick" || group.role === "piece") bricks += held;
    if (group.normal) normals += held;
  });
  // cheapest way to start: a lone starter costs nothing, a partner that is a hand trap costs that hand trap
  let spent = Infinity;
  if (starters > 0) spent = 0;
  else
    pairGroup.forEach((own, pairIndex) => {
      if (!counts[own]) return;
      let partners = 0, free = 0;
      for (const at of partnerGroups[pairIndex]) {
        const held = counts[at] - (at === own ? 1 : 0); // the starter cannot be its own partner
        if (held <= 0) continue;
        partners += held;
        if (!usable(groups[at].role)) free += held;
      }
      if (partners > 0) spent = Math.min(spent, free > 0 ? 0 : 1);
    });
  const combo = spent !== Infinity;
  // one Normal Summon a turn: every Normal Summon card past the first is dead
  return { combo, handtraps: handtraps - (combo ? spent : 0), extenders, breakers, bricks: bricks + Math.max(0, normals - 1), normals };
}

// Every hand of `size` cards by how many of each group it holds, with its exact probability
function forEachHand(groups: Group[], size: number, visit: (counts: number[], p: number) => void) {
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  size = Math.min(size, total);
  const all = choose(total, size);
  const counts = new Array(groups.length).fill(0);
  const left = groups.map((_, at) => groups.slice(at).reduce((sum, group) => sum + group.count, 0));
  const walk = (at: number, need: number, ways: number) => {
    if (need === 0) return visit(counts, ways / all);
    if (at === groups.length || left[at] < need) return;
    for (let take = Math.min(need, groups[at].count); take >= 0; take--) {
      counts[at] = take;
      walk(at + 1, need - take, ways * choose(groups[at].count, take));
    }
    counts[at] = 0;
  };
  walk(0, size, 1);
}

const isStart = (role: Role) => role === "starter" || role === "pair";

/** The deck as if only the proven starts worked: what the numbers are worth before anything else has been played. */
export const provenOnly = (cards: DeckCard[]): DeckCard[] =>
  cards.map((card) => (isStart(card.tag.role) && !card.tag.proven ? { ...card, tag: { role: "other" } } : card));
export const allProven = (cards: DeckCard[]) => cards.every((card) => !isStart(card.tag.role) || card.tag.proven);

/**
 * The hand that tests one start: the start, one partner if it needs one (a card that starts nothing itself, so the
 * test is about this card), and the rest from cards that cannot help (hand traps first, then bricks).
 */
export function testHand(card: DeckCard, cards: DeckCard[], size = 5): number[] | null {
  const hand = [card.code];
  const left = new Map(cards.map((one) => [one.code, one.count - (one.code === card.code ? 1 : 0)]));
  const take = (one: DeckCard) => (hand.push(one.code), left.set(one.code, left.get(one.code)! - 1));
  if (card.tag.role === "pair") {
    const rank = (role: Role) => ["other", "none", "brick", "extender", "handtrap2", "handtrap", "pair", "starter"].indexOf(role);
    const partner = cards.filter((one) => matchesPartner(card.tag.with, one) && left.get(one.code)! > 0).sort((a, b) => rank(a.tag.role) - rank(b.tag.role))[0];
    if (!partner) return null;
    take(partner);
  }
  const partnersOfAny = (one: DeckCard) => cards.some((pair) => pair.tag.role === "pair" && pair.code !== one.code && matchesPartner(pair.tag.with, one));
  for (const role of ["handtrap", "handtrap2", "brick"] as Role[])
    for (const one of cards)
      while (hand.length < size && one.tag.role === role && left.get(one.code)! > 0 && !partnersOfAny(one)) take(one);
  return hand;
}

export function computeOdds(cards: DeckCard[], hand: number): Odds {
  const goingSecond = hand >= 6;
  const deck = groupDeck(cards);
  const odds: Odds = { hand, combo: 0, comboExtender: 0, comboHandtrap: 0, comboHandtrap2: 0, handtrap: 0, handtrap2: 0, handtrapAvg: 0, breaker: 0, dead: 0, dead2: 0, normal2: 0 };
  if (!deck.groups.length) return odds;
  forEachHand(deck.groups, hand, (counts, p) => {
    const facts = evaluate(counts, deck, goingSecond);
    if (facts.combo) {
      odds.combo += p;
      if (facts.extenders > 0) odds.comboExtender += p;
      if (facts.handtraps >= 1) odds.comboHandtrap += p;
      if (facts.handtraps >= 2) odds.comboHandtrap2 += p;
    }
    // hand traps held at all: a hand trap you keep instead of starting still counts here
    const held = counts.reduce((sum, held, at) => {
      const role = deck.groups[at].role;
      return sum + (role === "handtrap" || (goingSecond && role === "handtrap2") ? held : 0);
    }, 0);
    if (held >= 1) odds.handtrap += p;
    if (held >= 2) odds.handtrap2 += p;
    odds.handtrapAvg += p * held;
    if (facts.breakers > 0) odds.breaker += p;
    if (facts.bricks >= 1) odds.dead += p;
    if (facts.bricks >= 2) odds.dead2 += p;
    if (facts.normals >= 2) odds.normal2 += p;
  });
  return odds;
}

export type Goal = "combo" | "comboHandtrap" | "comboHandtrap2";
export const GOALS: { goal: Goal; name: string }[] = [
  { goal: "combo", name: "Open a combo" },
  { goal: "comboHandtrap", name: "Combo + hand trap" },
  { goal: "comboHandtrap2", name: "Combo + 2 hand traps" },
];

export function grade(combo: number) {
  if (combo >= 0.9) return "Excellent";
  if (combo >= 0.82) return "Good";
  if (combo >= 0.72) return "Okay";
  return "Inconsistent";
}

// ---- suggestions ----
// A swap is judged on going first and going second equally: you win the coin toss half the time.
export interface Score {
  first: Odds;
  second: Odds;
  value: number;
}
export function score(cards: DeckCard[], goal: Goal): Score {
  const first = computeOdds(cards, 5), second = computeOdds(cards, 6);
  return { first, second, value: (first[goal] + second[goal]) / 2 };
}

export interface Swap {
  cut: number;
  add: number;
  fromSide: boolean;
  before: Score;
  after: Score;
}

const withCount = (cards: DeckCard[], code: number, change: number, extra?: DeckCard): DeckCard[] => {
  const found = cards.some((card) => card.code === code);
  const list = found ? cards : [...cards, { ...extra!, count: 0 }];
  return list.map((card) => (card.code === code ? { ...card, count: card.count + change } : card)).filter((card) => card.count > 0);
};

// Never offered as cuts: Extenders (what they add, playing through a negate, is not in these numbers)
// and cards not tagged yet (nothing is known about them)
const cuttable = (card: DeckCard) => card.tag.role !== "extender" && card.tag.role !== "piece" && card.tag.role !== "none";
const normals = (cards: DeckCard[]) => cards.filter((card) => card.tag.normal).reduce((sum, card) => sum + card.count, 0);

/**
 * One-for-one swaps that help the goal, best first. `candidates` are the cards that could come in: the Main Deck's
 * own cards and the Side Deck's. `room(code)` is how many more copies the ban list allows; Side Deck cards just move.
 */
export function bestSwaps(cards: DeckCard[], candidates: DeckCard[], goal: Goal, room: (code: number) => number, side: Set<number>, limit = 3): Swap[] {
  const before = score(cards, goal);
  const swaps: Swap[] = [];
  for (const cut of cards.filter(cuttable)) {
    const without = withCount(cards, cut.code, -1);
    for (const add of candidates) {
      if (add.code === cut.code) continue;
      const fromSide = side.has(add.code);
      if (!fromSide && room(add.code) <= 0) continue;
      // never past the Normal Summon limit
      if (add.tag.normal && normals(without) + 1 > normalLimit(cards.reduce((sum, card) => sum + card.count, 0))) continue;
      const after = score(withCount(without, add.code, 1, add), goal);
      if (after.value - before.value >= 0.001) swaps.push({ cut: cut.code, add: add.code, fromSide, before, after });
    }
  }
  swaps.sort((a, b) => b.after.value - a.after.value || b.after.first.combo - a.after.first.combo);
  // one suggestion per card coming in, so the list offers real choices
  const seen = new Set<number>();
  return swaps.filter((swap) => !seen.has(swap.add) && seen.add(swap.add)).slice(0, limit);
}

/** Copies to take out to reach `size` cards, one at a time, each the one that costs the goal least. */
export function bestCuts(cards: DeckCard[], goal: Goal, size = 40): { cuts: number[]; before: Score; after: Score } {
  let deck = cards;
  const cuts: number[] = [];
  const before = score(cards, goal);
  let after = before;
  let total = cards.reduce((sum, card) => sum + card.count, 0);
  while (total > size) {
    let best: { code: number; result: Score } | null = null;
    for (const card of deck.filter(cuttable)) {
      const result = score(withCount(deck, card.code, -1), goal);
      if (!best || result.value > best.result.value + 1e-12) best = { code: card.code, result };
    }
    if (!best) break;
    deck = withCount(deck, best.code, -1);
    cuts.push(best.code);
    after = best.result;
    total--;
  }
  return { cuts, before, after };
}

// ---- guesses, so a fresh deck is not a wall of "Not tagged" ----
const LIGHT = 16;
const GUESSES: Record<number, Tag> = {
  ...Object.fromEntries(HAND_TRAPS.map((code) => [code, { role: "handtrap" } as Tag])),
  // "If you control no cards": dead going first
  ...Object.fromEntries(HAND_TRAPS_SECOND.map((code) => [code, { role: "handtrap2" } as Tag])),
  // board breakers
  14532163: { role: "breaker" }, 12580477: { role: "breaker" }, 54693926: { role: "breaker" }, 15693423: { role: "breaker" },
  18144506: { role: "breaker" }, 24299458: { role: "breaker" }, 102380: { role: "breaker" }, 55063751: { role: "breaker" },
  48130397: { role: "breaker" }, 8267140: { role: "breaker" },
  // staples
  24224830: { role: "other" }, 65681983: { role: "other" }, 25311006: { role: "other" }, 41420027: { role: "other" }, 23002292: { role: "other" },
  // Galaxy-Eyes, from RKAPro v1's engine-verified lines (packs/galaxy-eyes/lines.json)
  91714772: { role: "starter" }, // Galaxy Defense Robot Orbital 7
  18294799: { role: "starter" }, // Schwarzschild Infinity Dragon
  7477101: { role: "starter" }, // Seventh Tachyon
  47051709: { role: "starter" }, // Photon Delta Wing
  98555327: { role: "starter" }, // Galaxy Wizard
  46659709: { role: "pair", with: { codes: [], attributes: LIGHT, levels: [] } }, // Galaxy Soldier: discards a LIGHT monster
  89132148: { role: "pair", with: { codes: [863795, 19316241, 65367484], attributes: 0, levels: [] } }, // Photon Orbital + Summoner / War Drake / Thrasher
};

export function guessTag(code: number): Tag | null {
  const guess = GUESSES[code];
  return guess ? { ...guess, guessed: true } : null;
}

export function describePartners(partners: Partners | undefined, nameOf: (code: number) => string): string {
  if (!partners) return "no partner picked";
  const parts: string[] = [];
  const attributes = ["EARTH", "WATER", "FIRE", "WIND", "LIGHT", "DARK", "DIVINE"].filter((_, bit) => partners.attributes & (1 << bit));
  if (attributes.length) parts.push(`any ${attributes.join(" or ")} monster`);
  if (partners.levels.length) parts.push(`any Level ${[...partners.levels].sort((a, b) => a - b).join(" or ")} monster`);
  parts.push(...partners.codes.map(nameOf));
  return parts.length ? parts.join(", ") : "no partner picked";
}

/**
 * The chance a hand still makes a full board when the opponent has one hand trap and uses it at its worst moment for
 * you: the hand holds a start whose line plays through that hand trap, or two different full-board starts (it can
 * only stop one of them). `verdict(code)`: "through" for a start that plays through it, "full" for one that reaches a
 * full board but is stopped by it, anything else for the rest. Every hand counted exactly.
 */
export function throughOdds(cards: DeckCard[], hand: number, verdict: (code: number) => "through" | "full" | "no"): number {
  const list = cards.filter((card) => card.count > 0);
  const total = list.reduce((sum, card) => sum + card.count, 0);
  if (total < hand) return 0;
  const all = choose(total, hand);
  const held = new Array(list.length).fill(0);
  let odds = 0;
  const starts = (index: number): boolean => {
    const card = list[index];
    if (card.tag.role === "starter") return true;
    if (card.tag.role !== "pair") return false;
    // a partnered start needs its partner in the hand (a second copy of itself counts)
    return list.some((other, at) => held[at] > (at === index ? 1 : 0) && matchesPartner(card.tag.with, other));
  };
  const visit = (ways: number) => {
    let through = false;
    let full = 0;
    held.forEach((count, index) => {
      if (!count || !starts(index)) return;
      const result = verdict(list[index].code);
      if (result === "through") through = true;
      else if (result === "full") full++;
    });
    if (through || full >= 2) odds += ways / all;
  };
  const walk = (at: number, left: number, ways: number) => {
    if (left === 0) return visit(ways);
    if (at === list.length) return;
    for (let take = Math.min(left, list[at].count); take >= 0; take--) {
      held[at] = take;
      walk(at + 1, left - take, ways * choose(list[at].count, take));
    }
    held[at] = 0;
  };
  walk(0, hand, 1);
  return odds;
}

/**
 * The chance a hand still makes a full board against `traps` hand traps, each used at its worst moment for you.
 * `lives(code)`: 0 for a start that doesn't reach a full board; otherwise 1, plus how many of the hand traps its line
 * plays through. Each hand trap takes one life, so a hand gets through when its different starts have more lives in
 * total than the opponent has hand traps. Every hand counted exactly.
 */
export function throughMany(cards: DeckCard[], hand: number, lives: (code: number) => number, traps: number): number {
  const list = cards.filter((card) => card.count > 0);
  const total = list.reduce((sum, card) => sum + card.count, 0);
  if (total < hand) return 0;
  const all = choose(total, hand);
  const held = new Array(list.length).fill(0);
  let odds = 0;
  const starts = (index: number): boolean => {
    const card = list[index];
    if (card.tag.role === "starter") return true;
    if (card.tag.role !== "pair") return false;
    return list.some((other, at) => held[at] > (at === index ? 1 : 0) && matchesPartner(card.tag.with, other));
  };
  const walk = (at: number, left: number, ways: number) => {
    if (left === 0) {
      let sum = 0;
      held.forEach((count, index) => {
        if (count && starts(index)) sum += lives(list[index].code);
      });
      if (sum > traps) odds += ways / all;
      return;
    }
    if (at === list.length) return;
    for (let take = Math.min(left, list[at].count); take >= 0; take--) {
      held[at] = take;
      walk(at + 1, left - take, ways * choose(list[at].count, take));
    }
    held[at] = 0;
  };
  walk(0, hand, 1);
  return odds;
}
