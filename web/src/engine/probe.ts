// The engine probe: what a hand can really do, decided by the card scripts EDOPro runs, not by anyone's tags.
// It deals an exact hand on top of the rest of the deck, then tries the actions the core offers in the first Main Phase,
// a few steps deep, replaying each branch from the start (the core cannot copy a duel). What it measures is net:
// cards that left the Deck and are still out of it, and Extra Deck summons. A search that has to put a card back
// (Seventh Tachyon from a hand with nothing else in it) gains nothing, and the probe sees that.
// No DOM or worker globals: the app's worker and the Node checks in tools/ both run it.

import {
  OcgDuelMode,
  OcgLocation,
  OcgMessageType,
  OcgPosition,
  OcgProcessResult,
  OcgQueryFlags,
  OcgResponseType,
  SelectIdleCMDAction,
  type OcgCardData,
  type OcgCoreSync,
  type OcgDuelHandle,
  type OcgMessage,
  type OcgResponse,
} from "ocgcore-wasm";

export interface ProbeEnv {
  core: OcgCoreSync;
  card: (code: number) => OcgCardData | null;
  script: (name: string) => string;
  name: (code: number) => string;
}

export interface ProbeResult {
  // the best the hand reached: new cards out of the Deck (not the ones it started with), and Extra Deck summons
  deck: number;
  extra: number;
  // what that took, as the core's own actions ("Normal Summon Galaxy Wizard", ...)
  steps: string[];
  // cards taken from the Deck on the way there, and the card whose effect took the first one
  taken: number[];
  firstTaker: number | null;
  // branches tried, and whether the budget ran out before the search space did
  tried: number;
  exhausted: boolean;
}

interface Measure {
  deck: number;
  extra: number;
  taken: number[];
  firstTaker: number | null;
}

interface Stop {
  // the branch point after the plan: what can be chosen there
  options: string[];
  measure: Measure;
  key: string;
  failed?: boolean;
}

const QUERY_CODE = OcgQueryFlags.CODE as OcgQueryFlags;
// never TYPE: ocgcore-wasm misreads every field after it (see worker.ts)
const QUERY_OUT = (OcgQueryFlags.CODE | OcgQueryFlags.OVERLAY_CARD) as OcgQueryFlags;
const isPrompt = (type: number) => (type >= 10 && type <= 26 && type !== 17) || type === 132 || (type >= 140 && type <= 143);

/**
 * Plays one branch: the hand on top of the deck, `plan` the choices made at each branch point so far.
 * Branch points are Main Phase actions and single picks from the Deck or Extra Deck (what to search, what to summon).
 */
function play(env: ProbeEnv, hand: number[], deck: number[], extra: number[], plan: number[]): Stop {
  const { core } = env;
  const duel: OcgDuelHandle | null = core.createDuel({
    flags: OcgDuelMode.MODE_MR5 | OcgDuelMode.PSEUDO_SHUFFLE,
    seed: [1n, 2n, 3n, 4n],
    team1: { drawCountPerTurn: 1, startingDrawCount: hand.length, startingLP: 8000 },
    team2: { drawCountPerTurn: 1, startingDrawCount: 0, startingLP: 8000 },
    cardReader: (code) => env.card(code),
    scriptReader: (name) => env.script(name),
    errorHandler: () => {},
  });
  if (!duel) throw new Error("The probe could not create a duel");
  try {
    for (const file of ["constant.lua", "utility.lua"]) core.loadScript(duel, file, env.script(file));
    const add = (code: number, location: OcgLocation) =>
      core.duelNewCard(duel, { team: 0, duelist: 0, code, controller: 0, location, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    // the last card added is on top: the hand goes in last
    for (const code of [...deck, ...[...hand].reverse()]) add(code, OcgLocation.DECK);
    for (const code of extra) add(code, OcgLocation.EXTRA);
    core.startDuel(duel);

    const extra0 = extra.length;
    const extraCodes = new Set(extra);
    const taken: number[] = [];
    let firstTaker: number | null = null;
    const chain: number[] = [];
    let solving: number | null = null;
    const path: string[] = [];
    let step = 0;
    let started = false;

    // net gain: the cards out of the Deck now (field, hand, GY, banished, Xyz materials) that the hand did not start with.
    // Counting cards alone would miss a search that sends a different card back (Seventh Tachyon puts one on top).
    const outside = () => {
      const codes: number[] = [];
      for (const location of [OcgLocation.HAND, OcgLocation.MZONE, OcgLocation.SZONE, OcgLocation.GRAVE, OcgLocation.REMOVED])
        for (const card of core.duelQueryLocation(duel, { flags: QUERY_OUT, controller: 0, location })) {
          if (!card?.code) continue;
          codes.push(card.code);
          if (location === OcgLocation.MZONE) codes.push(...(card.overlayCards ?? []));
        }
      return codes;
    };
    const measure = (): Measure => {
      const left = [...hand];
      let gained = 0;
      for (const code of outside()) {
        const at = left.indexOf(code);
        if (at >= 0) left.splice(at, 1);
        else if (!extraCodes.has(code)) gained++;
      }
      return { deck: gained, extra: extra0 - core.duelQueryCount(duel, 0, OcgLocation.EXTRA), taken: [...taken], firstTaker };
    };
    const stateKey = () => {
      const codes = (location: OcgLocation) =>
        core
          .duelQueryLocation(duel, { flags: QUERY_CODE, controller: 0, location })
          .map((card) => card?.code ?? 0)
          .filter(Boolean)
          .sort((a, b) => a - b)
          .join(",");
      // the same cards in the same places after the same actions in another order is the same position
      return [OcgLocation.HAND, OcgLocation.MZONE, OcgLocation.SZONE, OcgLocation.GRAVE, OcgLocation.REMOVED].map(codes).join("|") + "#" + [...path].sort().join(";");
    };
    const stop = (options: string[]): Stop => ({ options, measure: measure(), key: stateKey() });
    const failed = (): Stop => ({ options: [], measure: measure(), key: "failed:" + path.join(";"), failed: true });

    for (let guard = 0; guard < 3000; guard++) {
      const status = core.duelProcess(duel);
      let response: OcgResponse | null = null;
      for (const message of core.duelGetMessage(duel)) {
        switch (message.type) {
          case OcgMessageType.CHAINING:
            chain.push(message.code);
            break;
          case OcgMessageType.CHAIN_SOLVING:
            solving = chain[message.chain_size - 1] ?? null;
            break;
          case OcgMessageType.CHAIN_END:
            chain.length = 0;
            solving = null;
            break;
          case OcgMessageType.MOVE:
            if (message.from.location === OcgLocation.DECK && message.from.controller === 0 && message.to.location !== OcgLocation.DECK && started && message.card) {
              taken.push(message.card);
              if (firstTaker === null) firstTaker = solving ?? message.card;
            }
            break;
          case OcgMessageType.RETRY:
            return failed();
          default:
            if (!isPrompt(message.type)) break;
            if (message.type === OcgMessageType.SELECT_IDLECMD && message.player === 0) {
              started = true;
              const options = idleOptions(env, message);
              if (step >= plan.length) return stop(options.map((option) => option.label));
              const pick = options[plan[step++]];
              if (!pick) return failed();
              path.push(pick.label);
              response = pick.response;
            } else {
              const branch = deckPick(env, message);
              if (branch && started) {
                if (step >= plan.length) return stop(branch.map((option) => option.label));
                const pick = branch[plan[step++]];
                if (!pick) return failed();
                path.push(pick.label);
                response = pick.response;
              } else response = autoAnswer(message);
            }
            if (!response) return failed();
        }
      }
      if (response) core.duelSetResponse(duel, response);
      else if (status === OcgProcessResult.END) return stop([]);
    }
    return failed();
  } finally {
    core.destroyDuel(duel);
  }
}

interface Option {
  label: string;
  response: OcgResponse;
}

// Main Phase actions worth trying: summons and activations (not Set, position changes or moving to another phase)
function idleOptions(env: ProbeEnv, message: Extract<OcgMessage, { type: OcgMessageType.SELECT_IDLECMD }>): Option[] {
  const options: Option[] = [];
  const seen = new Set<string>();
  const add = (verb: string, action: SelectIdleCMDAction, list: { code: number; location: number; description?: bigint }[]) =>
    list.forEach((card, index) => {
      // two copies of a card in the hand offer the same thing: try one
      const label = `${verb} ${env.name(card.code)}${card.description !== undefined ? `#${card.description}` : ""}@${card.location}`;
      if (seen.has(label)) return;
      seen.add(label);
      options.push({ label, response: { type: OcgResponseType.SELECT_IDLECMD, action, index } });
    });
  add("Normal Summon", SelectIdleCMDAction.SELECT_SUMMON, message.summons);
  add("Special Summon", SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, message.special_summons);
  add("Activate", SelectIdleCMDAction.SELECT_ACTIVATE, message.activates);
  return options;
}

// A single card picked from the Deck, Extra Deck or hand is a real decision (what to search or summon, what to discard
// or put back): branch on it. Picks from the field keep the first legal card.
const PICKED_FROM: number[] = [OcgLocation.DECK, OcgLocation.EXTRA, OcgLocation.HAND];
function deckPick(env: ProbeEnv, message: OcgMessage): Option[] | null {
  if (message.type !== OcgMessageType.SELECT_CARD || message.player !== 0 || message.min !== 1 || message.max !== 1) return null;
  if (!message.selects.length || !message.selects.every((card) => PICKED_FROM.includes(card.location))) return null;
  const options: Option[] = [];
  const seen = new Set<number>();
  message.selects.forEach((card, index) => {
    if (seen.has(card.code)) return;
    seen.add(card.code);
    options.push({ label: `pick ${env.name(card.code)}`, response: { type: OcgResponseType.SELECT_CARD, indicies: [index] } });
  });
  return options.length > 1 ? options : null;
}

// Everything else gets the plain answer: yes to optional effects, the first legal cards, the first free zone.
function autoAnswer(message: OcgMessage): OcgResponse | null {
  switch (message.type) {
    case OcgMessageType.SELECT_IDLECMD:
      return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null };
    case OcgMessageType.SELECT_BATTLECMD:
      return { type: OcgResponseType.SELECT_BATTLECMD, action: 3 as never, index: null };
    case OcgMessageType.SELECT_EFFECTYN:
      return { type: OcgResponseType.SELECT_EFFECTYN, yes: message.player === 0 };
    case OcgMessageType.SELECT_YESNO:
      return { type: OcgResponseType.SELECT_YESNO, yes: message.player === 0 };
    case OcgMessageType.SELECT_OPTION:
      return { type: OcgResponseType.SELECT_OPTION, index: 0 };
    case OcgMessageType.SELECT_CHAIN: {
      // triggers on the field or in the GY go off; cards in the hand stay there (a hand trap would only stop our own play)
      if (message.player !== 0) return { type: OcgResponseType.SELECT_CHAIN, index: message.forced ? 0 : null };
      const at = message.selects.findIndex((card) => card.location !== OcgLocation.HAND);
      return { type: OcgResponseType.SELECT_CHAIN, index: at >= 0 ? at : message.forced ? 0 : null };
    }
    case OcgMessageType.SELECT_CARD:
      return { type: OcgResponseType.SELECT_CARD, indicies: Array.from({ length: Math.max(1, message.min) }, (_, index) => index) };
    case OcgMessageType.SELECT_TRIBUTE:
      return { type: OcgResponseType.SELECT_TRIBUTE, indicies: Array.from({ length: Math.max(1, message.min) }, (_, index) => index) };
    case OcgMessageType.SELECT_UNSELECT_CARD:
      // pick until the core lets us finish
      return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: message.can_finish ? null : 0 } as OcgResponse;
    case OcgMessageType.SELECT_PLACE:
    case OcgMessageType.SELECT_DISFIELD: {
      const places: { player: number; location: OcgLocation; sequence: number }[] = [];
      const own = message.field_mask & 0xffff;
      for (let sequence = 0; sequence < 5 && places.length < Math.max(1, message.count); sequence++) if (!(own & (1 << sequence))) places.push({ player: message.player, location: OcgLocation.MZONE, sequence });
      for (let sequence = 0; sequence < 5 && places.length < Math.max(1, message.count); sequence++) if (!(own & (0x100 << sequence))) places.push({ player: message.player, location: OcgLocation.SZONE, sequence });
      for (let sequence = 5; sequence < 8 && places.length < Math.max(1, message.count); sequence++) {
        if (sequence < 7 && !(own & (1 << sequence))) places.push({ player: message.player, location: OcgLocation.MZONE, sequence });
        else if (!(own & (0x100 << sequence))) places.push({ player: message.player, location: OcgLocation.SZONE, sequence });
      }
      return { type: message.type === OcgMessageType.SELECT_PLACE ? OcgResponseType.SELECT_PLACE : OcgResponseType.SELECT_DISFIELD, places } as OcgResponse;
    }
    case OcgMessageType.SELECT_POSITION: {
      const position = [OcgPosition.FACEUP_ATTACK, OcgPosition.FACEUP_DEFENSE, OcgPosition.FACEDOWN_DEFENSE, OcgPosition.FACEDOWN_ATTACK].find((one) => message.positions & one)!;
      return { type: OcgResponseType.SELECT_POSITION, position };
    }
    case OcgMessageType.SELECT_SUM: {
      // the smallest run of cards, in order, that reaches the total
      const picks: number[] = [];
      let total = message.selects_must.reduce((sum, card) => sum + (card.amount & 0xffff), 0);
      for (let index = 0; index < message.selects.length && total < message.amount; index++) {
        picks.push(index);
        total += message.selects[index].amount & 0xffff;
      }
      return { type: OcgResponseType.SELECT_SUM, indicies: picks };
    }
    case OcgMessageType.SELECT_COUNTER: {
      let left = message.count;
      return { type: OcgResponseType.SELECT_COUNTER, counters: message.cards.map((card) => { const take = Math.min(left, card.count); left -= take; return take; }) };
    }
    case OcgMessageType.ANNOUNCE_RACE: {
      const available = BigInt(message.available);
      const bit = [...Array(30).keys()].map((at) => 1n << BigInt(at)).find((one) => available & one) ?? 1n;
      return { type: OcgResponseType.ANNOUNCE_RACE, races: [bit] as never };
    }
    case OcgMessageType.ANNOUNCE_ATTRIB: {
      const bit = [1, 2, 4, 8, 16, 32, 64].find((one) => message.available & one) ?? 1;
      return { type: OcgResponseType.ANNOUNCE_ATTRIB, attributes: [bit] as never };
    }
    case OcgMessageType.ANNOUNCE_NUMBER:
      return { type: OcgResponseType.ANNOUNCE_NUMBER, value: 0 } as OcgResponse;
    case OcgMessageType.SORT_CARD:
    case OcgMessageType.SORT_CHAIN:
      return { type: OcgResponseType.SORT_CARD, order: null };
    default:
      // card names to declare and anything rarer: this branch ends here
      return null;
  }
}

/**
 * What `hand` reaches, trying up to `budget` branches. With `untilDeck`, it stops at the first branch that keeps
 * a card taken from the Deck (enough to know the hand starts something).
 */
export function probe(env: ProbeEnv, hand: number[], deck: number[], extra: number[], options: ProbeOptions = {}): ProbeResult {
  const steps = probeSteps(env, hand, deck, extra, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

interface ProbeOptions {
  budget?: number;
  depth?: number;
  untilDeck?: boolean;
}

// The same, pausing (yield) after every duel tried, so a caller can answer other requests in between
function* probeSteps(env: ProbeEnv, hand: number[], deck: number[], extra: number[], options: ProbeOptions): Generator<undefined, ProbeResult> {
  const budget = options.budget ?? 120;
  const depth = options.depth ?? 6;
  const value = (measure: Measure) => measure.deck * 2 + measure.extra;
  let best: { measure: Measure; steps: string[] } = { measure: { deck: 0, extra: 0, taken: [], firstTaker: null }, steps: [] };
  const seen = new Set<string>();
  // breadth first: short lines are found first, and each layer is cheap
  let frontier: { plan: number[]; steps: string[] }[] = [{ plan: [], steps: [] }];
  let tried = 0;
  while (frontier.length && tried < budget) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (tried >= budget) break;
      tried++;
      const result = play(env, hand, deck, extra, node.plan);
      yield;
      if (result.failed || seen.has(result.key)) continue;
      seen.add(result.key);
      if (value(result.measure) > value(best.measure)) best = { measure: result.measure, steps: node.steps };
      if (options.untilDeck && result.measure.deck > 0) return { ...best.measure, steps: best.steps.map(clean), tried, exhausted: false };
      if (node.plan.length >= depth) continue;
      result.options.forEach((label, index) => next.push({ plan: [...node.plan, index], steps: [...node.steps, label] }));
    }
    frontier = next;
  }
  return { ...best.measure, steps: best.steps.map(clean), tried, exhausted: frontier.length === 0 };
}

// "Activate Galaxy Wizard#1576888@4" -> "Activate Galaxy Wizard"
const clean = (label: string) => label.replace(/#\d+/, "").replace(/@\d+$/, "");

export interface CardEvidence {
  code: number;
  alone: ProbeResult;
  // cards that let it start when they are in the hand with it (its effect takes the first card from the Deck)
  partners: number[];
  // pairs checked with it
  checked: number;
}

/** A start: the hand keeps at least one new card from the Deck. */
export const starts = (result: ProbeResult) => result.deck > 0;

/**
 * Every Main Deck card alone, then every pair of cards that start nothing alone. Yields after each duel tried, so the
 * caller can keep answering other requests and stop when the deck changes.
 */
// yields undefined after every duel (a pause point) and the progress after every hand
export function* probeDeck(env: ProbeEnv, main: number[], extra: number[]): Generator<{ done: number; total: number; evidence: Map<number, CardEvidence> } | undefined> {
  const distinct = [...new Set(main)];
  const copies = (code: number) => main.filter((one) => one === code).length;
  const rest = (hand: number[]) => {
    const deck = [...main];
    for (const code of hand) deck.splice(deck.indexOf(code), 1);
    return deck;
  };
  const evidence = new Map<number, CardEvidence>();
  const lone: number[] = [];
  let done = 0;
  // pairs are only known once the singles are: estimate them as if every card failed alone
  let total = distinct.length + (distinct.length * (distinct.length + 1)) / 2;
  for (const code of distinct) {
    const alone = yield* probeSteps(env, [code], rest([code]), extra, { budget: 150, depth: 6 });
    evidence.set(code, { code, alone, partners: [], checked: 0 });
    if (!starts(alone)) lone.push(code);
    done++;
    yield { done, total, evidence };
  }
  const pairs: [number, number][] = [];
  lone.forEach((a, i) => lone.slice(i).forEach((b) => (a !== b || copies(a) > 1) && pairs.push([a, b])));
  total = done + pairs.length;
  for (const [a, b] of pairs) {
    const result = yield* probeSteps(env, [a, b], rest([a, b]), extra, { budget: 60, depth: 6, untilDeck: true });
    evidence.get(a)!.checked++;
    if (a !== b) evidence.get(b)!.checked++;
    if (starts(result)) {
      // the card whose effect took from the Deck is the one that starts; if neither did (an Extra Deck summon from both), both
      const taker = result.firstTaker === a || result.firstTaker === b ? result.firstTaker : null;
      // two copies of one card: a second copy is its partner
      if (a === b) evidence.get(a)!.partners.push(a);
      else {
        if (taker !== b) evidence.get(a)!.partners.push(b);
        if (taker !== a) evidence.get(b)!.partners.push(a);
      }
    }
    done++;
    yield { done, total, evidence };
  }
}
