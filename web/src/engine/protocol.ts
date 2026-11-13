// Messages between the page and the duel worker. The worker turns everything
// the duel core says into these plain shapes, so the page knows nothing about the core.

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
  kind: "summon" | "activate" | "resolve" | "added" | "draw" | "negated" | "reveal" | "coin" | "dice" | "attack" | "message";
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
}

export type ToWorker =
  | { type: "init" }
  | ({ type: "start" } & StartOptions)
  | { type: "answer"; picks: number[] | null }
  | { type: "text"; code: number };

export type FromWorker =
  | { type: "progress"; text: string }
  | { type: "ready"; cards: number }
  | { type: "view"; view: DuelView }
  | { type: "text"; card: CardText }
  | { type: "error"; text: string };

export const LOCATION = { DECK: 1, HAND: 2, MZONE: 4, SZONE: 8, GRAVE: 16, REMOVED: 32, EXTRA: 64 } as const;
export const POSITION = { FACEUP_ATTACK: 1, FACEDOWN_ATTACK: 2, FACEUP_DEFENSE: 4, FACEDOWN_DEFENSE: 8 } as const;
export const TYPE = { MONSTER: 1, SPELL: 2, TRAP: 4, FUSION: 0x40, SYNCHRO: 0x2000, XYZ: 0x800000, LINK: 0x4000000 } as const;
