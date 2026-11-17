// Messages between the page and the duel worker. The worker turns everything
// the duel core says into these plain shapes, so the page knows nothing about the core.
import type { CardEvidence, Choke, ChokeCombo, Route } from "./probe";
import type { BoardAudit, Interruption, NibiruCheck, Piece, Protection } from "./interruptions";

export interface CardRef {
  controller: number;
  location: number;
  sequence: number;
}

export interface CardView extends CardRef {
  code: number; // 0 when the card is hidden
  name: string;
  type: number;
  attack: number;
  defense: number;
  level: number;
  position: number;
  materials: number;
  // attached Xyz materials, by passcode
  overlay: number[];
  // its effects are negated right now (face-up on the field)
  negated?: boolean;
  counters: { name: string; count: number }[];
}

export interface PlayerView {
  lp: number;
  deck: number;
  hand: CardView[];
  monsters: (CardView | null)[]; // 0-4 main zones, 5-6 extra monster zones
  spells: (CardView | null)[]; // 0-4 spell/trap zones, 5 field zone
  grave: CardView[];
  banished: CardView[];
  extra: CardView[];
}

export interface Choice {
  label: string;
  card?: CardRef & { code: number; name: string; type?: number };
  zone?: CardRef;
  // idle and battle commands that belong to the phase bar, not to a card
  phase?: boolean;
  // the same as another choice (a summon the core offers twice the same way): kept for numbering, not shown
  hidden?: boolean;
  // a plain pick (Xyz materials and the like): tapping the card answers at once
  pick?: boolean;
  // already picked; picking it again takes it back
  picked?: boolean;
}

export type Prompt =
  // pick exactly one (index into choices), or null when cancel is allowed
  | { kind: "choice"; idle: boolean; title: string; choices: Choice[]; cancel: string | null }
  // pick between min and max
  | { kind: "multi"; title: string; choices: Choice[]; min: number; max: number; cancel: boolean; sum?: SumRule }
  // remove counters: picks[i] is how many to take from choices[i]
  | { kind: "counter"; title: string; choices: Choice[]; available: number[]; total: number }
  // declare a card name (Crossout Designator, Prohibition); picks[0] is an index into options
  | { kind: "announce"; title: string; choices: Choice[]; options: { code: number; name: string }[] };

// Picking cards whose values add up to a number (Synchro and Ritual materials). Each card counts as one of two
// values (the second is 0 when it has only one); "must" cards are always part of the total.
export interface SumRule {
  target: number;
  exact: boolean; // false: at least the target, without a card to spare
  values: [number, number][];
  must: [number, number][];
}

// every total the chosen cards can make
function totals(values: [number, number][]): Set<number> {
  let sums = new Set([0]);
  for (const [a, b] of values) {
    const next = new Set<number>();
    for (const sum of sums) {
      next.add(sum + a);
      if (b) next.add(sum + b);
    }
    sums = next;
  }
  return sums;
}

export function sumReady(rule: SumRule, picks: number[]): boolean {
  const chosen = [...rule.must, ...picks.map((pick) => rule.values[pick])];
  if (rule.exact) return totals(chosen).has(rule.target);
  const low = (value: [number, number]) => (value[1] && value[1] < value[0] ? value[1] : value[0]);
  const least = chosen.reduce((sum, value) => sum + low(value), 0);
  const smallest = Math.min(...picks.map((pick) => low(rule.values[pick])));
  return least >= rule.target && least - smallest < rule.target;
}

export function sumSoFar(rule: SumRule, picks: number[]): number {
  return [...rule.must, ...picks.map((pick) => rule.values[pick])].reduce((sum, [a]) => sum + a, 0);
}

// Moments shown on screen before play goes on, like EDOPro's animations.
export interface DuelEvent extends CardRef {
  kind: "summon" | "activate" | "resolve" | "added" | "draw" | "negated" | "reveal" | "coin" | "dice" | "attack" | "message" | "phase";
  code: number;
  name: string;
  chain?: number; // chain link number, for activate and resolve
  text?: string; // the effect being activated, or what a coin, die or message says
  target?: CardRef; // the monster being attacked
}

export interface DuelView {
  // what just happened; views sent mid-play carry events and no prompt
  events: DuelEvent[];
  turn: number;
  turnPlayer: number;
  phase: string;
  players: [PlayerView, PlayerView];
  prompt: Prompt | null;
  ended: boolean;
  // who won, once the duel is over (0 = you)
  winner: number | null;
}

// A hand test as it was played: the duel's start (deck order, seed, settings) and every choice made, which replays it
// exactly, plus readable steps for the route list.
export interface TestRecord {
  options: StartOptions;
  picks: (number[] | null)[];
  // code: the card acted on or picked; hint: what a pick was for (the core's "Select a card to add to your hand")
  // turn: the turn the choice was made in (older tests don't have it)
  steps: { text: string; idle: boolean; code?: number; hint?: number; turn?: number }[];
  startHand: number[];
}

export interface CardText {
  code: number;
  name: string;
  line: string;
  text: string;
}

export interface StartOptions {
  main: number[];
  extra: number[];
  hand: number;
  // cards to open with; the rest of the hand is drawn at random
  chosen: number[];
  // hand traps in the player's hand never ask to be chained (testing a combo without Ash or Fuwalos popping up)
  ignoreHandTraps: boolean;
  seed: number;
  // the computer opponent's deck, in order; without one, its turn passes at once
  opponent?: { main: number[]; extra: number[] };
  // it chains its hand traps against you on your turn
  opponentHandTraps?: boolean;
  // the only hand traps it may use on your turn (the ones you picked); others it draws stay in its hand
  opponentTraps?: number[];
  // how it uses them: at the first legal chance, or as a strong player would ("smart"; tests saved before this setting
  // existed replay as "instant")
  trapTiming?: "instant" | "smart";
  // from your saved lines' hand trap checks: for each start and hand trap, the moments in order and the interruptions
  // left after using it there (smart uses it at the moment nothing later in the line beats)
  trapPlans?: TrapPlan[];
  // the opponent takes the first turn: yours passes at once, it opens with 4 and draws to 5
  goSecond?: boolean;
}

export interface TrapPlan {
  start: number;
  // the hand cards the line needs (all of them in your hand for the plan to apply); without it, the start card
  needs?: number[];
  // choke points you marked on the line, in order: the smart opponent uses its hand trap there
  marks?: { at: string; traps: number[] }[];
  trap: number;
  clean: number;
  windows: { at: string; interruptions: number }[];
}

// A card as the deck editor needs it.
export interface CardInfo {
  code: number;
  name: string;
  type: number;
  level: number; // Level, Rank or Link rating
  attribute: number;
  race: number;
  attack: number;
  defense: number;
  // passcode the card shares its name with (alternate artworks), for the 3-copy rule
  alias: number;
}

// The deck editor's search, after EDOPro's filters. Every field is optional.
export interface CardSearch {
  text?: string; // name or card text
  kind?: "monster" | "spell" | "trap";
  subtype?: number; // a TYPE bit (Effect, Fusion, Quick-Play, Continuous ...)
  attribute?: number;
  race?: number;
  level?: number;
  atk?: [number | null, number | null];
  def?: [number | null, number | null];
  limit?: 0 | 1 | 2 | 3; // ban-list status; 3 = unlimited
}

export type ToWorker =
  | { type: "init" }
  // load another ban list (a file in ProjectIgnis' LFLists: "0TCG", "OCG")
  | { type: "banlist"; file: string }
  | ({ type: "start" } & StartOptions)
  | { type: "answer"; picks: number[] | null }
  // where the duel is now, named as the hand trap check names moments (to mark a choke point)
  | { type: "moment"; id: number }
  // start a recorded test and make its first `picks` choices at once, showing only where that leaves the duel
  | ({ type: "jump"; picks: (number[] | null)[] } & StartOptions)
  // replay a recorded test and send back every moment of it (for a video), without showing it
  | ({ type: "views"; id: string; picks: (number[] | null)[]; reveal?: boolean } & StartOptions)
  | { type: "text"; code: number }
  | { type: "search"; id: number; search: CardSearch }
  | { type: "info"; codes: number[] }
  // the engine probe: what every Main Deck card starts, alone and in pairs (see probe.ts)
  | { type: "probe"; id: number; main: number[]; extra: number[] }
  // route search from `hand` (the rest of `main` is the Deck) toward `targets`, your full boards
  | { type: "route"; id: number; main: number[]; extra: number[]; hand: number[]; targets: number[][]; prior: string[]; goal: number }
  // choke points for a line found: each hand trap at each moment, the worst ones searched again
  // `combo`: the hand traps the opponent holds together (Ash and Imperm), checked as a set after the single ones
  // traps: the hand traps to check (the ones the deck tags as hand traps, then the common staples)
  | { type: "choke"; id: number; main: number[]; extra: number[]; hand: number[]; keys: string[]; goal: number; combo?: number[]; traps?: number[] }
  // the board audit for a working line: replayed, then the opponent's turn probed
  | { type: "audit"; id: string; main: number[]; extra: number[]; hand: number[]; keys: string[]; board: number[]; pieces?: Piece[] }
  // the interruptions a board holds (a working test's end): cards still in the hand it opened with don't count
  // used: the effects the line activated (code, and which of its effects when known), for what they leave in place
  // fifth: what you had right after your 5th summon, if the line made 5 (for Nibiru)
  | { type: "interruptions"; id: string; pieces: Piece[]; startHand: number[]; used?: { code: number; effect?: string }[]; summons?: number; fifth?: Piece[] }
  // card names (from a deck list) to the cards they are
  | { type: "names"; id: string; names: string[] }
  // each of your lines played as recorded, then without one copy of `cut` in the deck: what each line loses
  | { type: "cut"; id: number; main: number[]; extra: number[]; cut: number; lines: { start: number; hand: number[]; keys: string[] }[] }
  // which opening-hand cards each saved line needs: replayed without each card in turn
  | { type: "needs"; id: number; main: number[]; extra: number[]; lines: { key: string; hand: number[]; keys: string[] }[] }
  // what each card does that matters for building a deck, read from its text
  | { type: "traits"; codes: number[] };

export type FromWorker =
  | { type: "progress"; text: string }
  | { type: "ready"; cards: number; banlist: { name: string; limits: Record<number, number> } }
  | { type: "banlist"; banlist: { name: string; limits: Record<number, number> } }
  | { type: "view"; view: DuelView }
  | { type: "record"; record: TestRecord }
  // marks[i]: how many views there were once play i was made (marks[0]: the duel's start)
  | { type: "views"; id: string; views: DuelView[]; marks: number[] }
  | { type: "text"; card: CardText }
  | { type: "search"; id: number; results: CardInfo[]; more: boolean }
  // asked: the passcode as requested (Omega numbers alternate artworks itself), code: the card it is
  | { type: "info"; cards: (CardInfo & { asked: number })[] }
  | { type: "probe"; id: number; done: number; total: number; evidence?: CardEvidence[] }
  // progress, then the line found, as a test the duel screen replays
  | { type: "route"; id: number; tried: number; done?: { route: Route; record: TestRecord } }
  | { type: "choke"; id: number; done?: Choke[]; combo?: ChokeCombo }
  | { type: "audit"; id: string; audit: BoardAudit | null }
  | { type: "interruptions"; id: string; list: Interruption[]; protection: Protection[]; nibiru?: NibiruCheck }
  | { type: "names"; id: string; cards: (CardInfo | null)[] }
  | { type: "cut"; id: number; cut: number; lines: { start: number; before: number; after: number; board: number[] }[] }
  // needs: cards whose absence lowers the line's board; any: how many more of the hand's other cards it still uses
  | { type: "needs"; id: number; lines: { key: string; before: number; needs: number[]; any: number }[] }
  // traps: the hand traps the opponent could have used there (a mark binds only those)
  | { type: "moment"; id: number; at: string; step: number; traps: number[] }
  | { type: "traits"; traits: [number, string[]][] }
  | { type: "error"; text: string };

export const LOCATION = { DECK: 1, HAND: 2, MZONE: 4, SZONE: 8, GRAVE: 16, REMOVED: 32, EXTRA: 64 } as const;
export const POSITION = { FACEUP_ATTACK: 1, FACEDOWN_ATTACK: 2, FACEUP_DEFENSE: 4, FACEDOWN_DEFENSE: 8 } as const;
export const TYPE = { MONSTER: 1, SPELL: 2, TRAP: 4, FUSION: 0x40, SYNCHRO: 0x2000, XYZ: 0x800000, LINK: 0x4000000 } as const;
