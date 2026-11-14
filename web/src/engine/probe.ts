// The engine probe: what a hand can really do, decided by the card scripts EDOPro runs, not by anyone's tags.
// It deals an exact hand on top of the rest of the deck, then tries the actions the core offers in the first Main Phase,
// a few steps deep, replaying each branch from the start (the core cannot copy a duel). What it measures is net:
// cards that left the Deck and are still out of it, and Extra Deck summons. A search that has to put a card back
// (Seventh Tachyon from a hand with nothing else in it) gains nothing, and the probe sees that.
// No DOM or worker globals: the app's worker and the Node checks in tools/ both run it.

import {
  OcgDuelMode,
  OcgHintType,
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
import { isFirstTurnHandTrap, isHandTrap } from "./handtraps.ts";
import { interruptionsOf, nibiruStopper, type NibiruCheck, type Protection, type Interruption, type Piece, type QuickEffect } from "./interruptions.ts";

export interface ProbeEnv {
  core: OcgCoreSync;
  card: (code: number) => OcgCardData | null;
  script: (name: string) => string;
  name: (code: number) => string;
  // for counting interruptions: a card's effects usable on the opponent's turn, and its archetypes
  effects?: (code: number) => QuickEffect[];
  setcodes?: (code: number) => number[];
}

export interface ProbeResult {
  // the best the hand reached: new cards out of the Deck (not the ones it started with), and Extra Deck summons
  deck: number;
  extra: number;
  // what that took, as the core's own actions ("Normal Summon Galaxy Wizard", ...)
  steps: string[];
  // cards taken from the Deck on the way there, and the card whose effect took the first one
  taken: number[];
  // for each card taken, the card whose effect took it (0: none)
  takers?: number[];
  firstTaker: number | null;
  // branches tried, and whether the budget ran out before the search space did
  tried: number;
  exhausted: boolean;
}

interface Measure {
  deck: number;
  extra: number;
  taken: number[];
  // for each card taken, the card whose effect took it (the one resolving), 0 if none (a summon by its own rule)
  takers?: number[];
  firstTaker: number | null;
}

export interface Stop {
  // the branch point after the plan: what can be chosen there, the card each acts on, and what a pick is for
  options: string[];
  codes: number[];
  hint: number;
  measure: Measure;
  key: string;
  // your monsters and Spells/Traps now, and every choice so far as the duel screen would have taken it
  board: number[];
  ui: (number[] | null)[];
  // everything that can matter on the opponent's turn: field (with Xyz Materials), hand, GY
  pieces: Piece[];
  // monsters you have summoned, and what you had right after the 5th (when Nibiru can first be used)
  summons?: number;
  fifth?: Piece[];
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
// `against`: the opponent holds this hand trap and uses it the first time it can answer `at` (an effect's card name,
// "the summon of X", "after X"), so a search can look for the best way through it
export interface Against {
  trap: number;
  at: string;
}

export function play(env: ProbeEnv, hand: number[], deck: number[], extra: number[], plan: number[], against?: Against | Against[]): Stop {
  // the opponent may hold several hand traps, each used at its own moment
  const uses = !against ? [] : Array.isArray(against) ? against : [against];
  const { core } = env;
  const duel: OcgDuelHandle | null = core.createDuel({
    flags: OcgDuelMode.MODE_MR5 | OcgDuelMode.PSEUDO_SHUFFLE,
    seed: [1n, 2n, 3n, 4n],
    team1: { drawCountPerTurn: 1, startingDrawCount: hand.length, startingLP: 8000 },
    team2: { drawCountPerTurn: 1, startingDrawCount: uses.length, startingLP: 8000 },
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
    for (const use of uses) core.duelNewCard(duel, { team: 1, duelist: 0, code: use.trap, controller: 1, location: OcgLocation.DECK, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    core.startDuel(duel);
    let lastSummon = 0;
    let lastActed = 0;
    const used = uses.map(() => false);

    const extra0 = extra.length;
    const extraCodes = new Set(extra);
    const taken: number[] = [];
    const takers: number[] = [];
    let firstTaker: number | null = null;
    const chain: number[] = [];
    let solving: number | null = null;
    const path: string[] = [];
    const ui: (number[] | null)[] = [];
    let hint = 0;
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
      return { deck: gained, extra: extra0 - core.duelQueryCount(duel, 0, OcgLocation.EXTRA), taken: [...taken], takers: [...takers], firstTaker };
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
    const board = () =>
      [OcgLocation.MZONE, OcgLocation.SZONE].flatMap((location) =>
        core.duelQueryLocation(duel, { flags: QUERY_CODE, controller: 0, location }).flatMap((card) => (card?.code ? [card.code] : [])),
      );
    const pieces = (): Piece[] => {
      const out: Piece[] = [];
      for (const location of [OcgLocation.MZONE, OcgLocation.SZONE, OcgLocation.HAND, OcgLocation.GRAVE, OcgLocation.EXTRA])
        for (const card of core.duelQueryLocation(duel, { flags: QUERY_OUT, controller: 0, location }))
          if (card?.code) out.push({ code: card.code, location, materials: card.overlayCards?.length ?? 0 });
      return out;
    };
    let summons = 0;
    let fifth: Piece[] | undefined;
    const stop = (options: Option[]): Stop => ({ options: options.map((option) => option.label), codes: options.map((option) => option.code ?? 0), hint, measure: measure(), key: stateKey(), board: board(), ui: [...ui], pieces: pieces(), summons, fifth });
    const failed = (): Stop => ({ options: [], codes: [], hint: 0, measure: measure(), key: "failed:" + path.join(";"), board: [], ui: [], pieces: [], failed: true });

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
            lastSummon = 0;
            break;
          case OcgMessageType.SUMMONING:
          case OcgMessageType.SPSUMMONING:
            lastSummon = message.code;
            if (message.controller === 0) summons++;
            break;
          case OcgMessageType.SUMMONED:
          case OcgMessageType.SPSUMMONED:
            // the summon that makes 5 has happened: this is what you have when Nibiru can first be used
            if (summons >= 5 && !fifth) fifth = pieces();
            break;
          case OcgMessageType.MOVE:
            if (message.from.location === OcgLocation.DECK && message.from.controller === 0 && message.to.location !== OcgLocation.DECK && started && message.card) {
              taken.push(message.card);
              takers.push(solving ?? 0);
              if (firstTaker === null) firstTaker = solving ?? message.card;
            }
            break;
          case OcgMessageType.RETRY:
            return failed();
          case OcgMessageType.HINT:
            if (message.hint_type === OcgHintType.SELECTMSG && message.player === 0) hint = Number(message.hint);
            break;
          default:
            if (!isPrompt(message.type)) break;
            if (uses.length && "player" in message && message.player === 1) {
              response = opponentAnswer(message, (offered) => {
                const label = chain.length ? env.name(chain[chain.length - 1]) : lastSummon ? `the summon of ${env.name(lastSummon)}` : lastActed ? `after ${env.name(lastActed)}` : "the start of the turn";
                // the first hand trap not used yet whose moment this is
                for (let index = 0; index < uses.length; index++) {
                  const at = offered.findIndex((code) => code === uses[index].trap);
                  if (!used[index] && uses[index].at === label && at >= 0) {
                    used[index] = true;
                    return at;
                  }
                }
                return -1;
              }, chain[chain.length - 2] ?? lastSummon);
              if (!response) return failed();
              break;
            }
            if (message.type === OcgMessageType.SELECT_IDLECMD && message.player === 0) {
              started = true;
              hint = 0;
              const options = idleOptions(env, message);
              if (step >= plan.length) return stop(options);
              const pick = options[plan[step++]];
              if (!pick) return failed();
              path.push(pick.label);
              ui.push(pick.ui!);
              lastActed = pick.code ?? lastActed;
              response = pick.response;
            } else {
              const branch = deckPick(env, message);
              if (branch && started) {
                if (step >= plan.length) return stop(branch);
                const pick = branch[plan[step++]];
                if (!pick) return failed();
                path.push(pick.label);
                ui.push(pick.ui!);
                response = pick.response;
                hint = 0;
              } else {
                response = autoAnswer(message);
                // the duel screen asks for this one too: record the same answer the way it would take it
                const shown = response && uiPicks(message, response);
                if (shown !== undefined) ui.push(shown);
              }
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
  // the same choice as the duel screen numbers it, and the card it acts on
  ui?: number[] | null;
  code?: number;
}

// Main Phase actions worth trying: summons and activations (not Set, position changes or moving to another phase)
function idleOptions(env: ProbeEnv, message: Extract<OcgMessage, { type: OcgMessageType.SELECT_IDLECMD }>): Option[] {
  const options: Option[] = [];
  const seen = new Set<string>();
  const add = (verb: string, action: SelectIdleCMDAction, list: { code: number; location: number; description?: bigint }[], offset: number, keep = (_card: { code: number }) => true) =>
    list.forEach((card, index) => {
      if (!keep(card)) return;
      // two copies of a card in the hand offer the same thing: try one
      const label = `${verb} ${env.name(card.code)}${card.description !== undefined ? `#${card.description}` : ""}@${card.location}`;
      if (seen.has(label)) return;
      seen.add(label);
      options.push({ label, response: { type: OcgResponseType.SELECT_IDLECMD, action, index }, ui: [offset + index], code: card.code });
    });
  // the duel screen lists summons, Special Summons, position changes, Sets, then activations (worker.ts buildPrompt)
  const m = message;
  // Normal Summoning a hand trap only spends the turn's Normal Summon
  add("Normal Summon", SelectIdleCMDAction.SELECT_SUMMON, m.summons, 0, (card) => !isHandTrap(card.code));
  add("Special Summon", SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, m.special_summons, m.summons.length);
  add("Activate", SelectIdleCMDAction.SELECT_ACTIVATE, m.activates, m.summons.length + m.special_summons.length + m.pos_changes.length + m.monster_sets.length + m.spell_sets.length);
  return options;
}

// A single card picked from the Deck, Extra Deck or hand is a real decision (what to search or summon, what to discard
// or put back): branch on it. Picks from the field keep the first legal card.
const PICKED_FROM: number[] = [OcgLocation.DECK, OcgLocation.EXTRA, OcgLocation.HAND];
function deckPick(env: ProbeEnv, message: OcgMessage): Option[] | null {
  // a group picked one card at a time ("1 Photon and 1 Galaxy monster from your Deck"): branch on each card picked
  if (message.type === OcgMessageType.SELECT_UNSELECT_CARD && message.player === 0 && message.select_cards.length) {
    if (!message.select_cards.every((card) => PICKED_FROM.includes(card.location))) return null;
    const options: Option[] = [];
    const seen = new Set<number>();
    message.select_cards.forEach((card, index) => {
      if (seen.has(card.code)) return;
      seen.add(card.code);
      options.push({ label: `pick ${env.name(card.code)}`, response: { type: OcgResponseType.SELECT_UNSELECT_CARD, index } as OcgResponse, ui: [index], code: card.code });
    });
    if (message.can_finish) options.push({ label: "finish picking", response: { type: OcgResponseType.SELECT_UNSELECT_CARD, index: null } as OcgResponse, ui: null });
    return options.length > 1 ? options : null;
  }
  if (message.type !== OcgMessageType.SELECT_CARD || message.player !== 0 || message.min !== 1 || message.max !== 1) return null;
  if (!message.selects.length || !message.selects.every((card) => PICKED_FROM.includes(card.location))) return null;
  const options: Option[] = [];
  const seen = new Set<number>();
  message.selects.forEach((card, index) => {
    if (seen.has(card.code)) return;
    seen.add(card.code);
    options.push({ label: `pick ${env.name(card.code)}`, response: { type: OcgResponseType.SELECT_CARD, indicies: [index] }, ui: [index], code: card.code });
  });
  return options.length > 1 ? options : null;
}

// what the duel screen holds back with "Ignore hand traps" on (worker.ts SELECT_CHAIN)
const heldBack = (card: { code: number; location: number }) => card.location === OcgLocation.HAND && isHandTrap(card.code);

// The hand trap holder's side of a practice duel: the hand trap at the chosen moment (`now()` says if this is it),
// its target the card just activated or summoned, yes to everything else
function opponentAnswer(message: OcgMessage, pick: (offered: number[]) => number, target: number): OcgResponse | null {
  switch (message.type) {
    case OcgMessageType.SELECT_CHAIN: {
      const at = pick(message.selects.map((card) => card.code));
      if (at >= 0) return { type: OcgResponseType.SELECT_CHAIN, index: at };
      return { type: OcgResponseType.SELECT_CHAIN, index: message.forced ? 0 : null };
    }
    case OcgMessageType.SELECT_CARD: {
      const at = message.selects.findIndex((card) => card.code === target);
      return at >= 0 ? { type: OcgResponseType.SELECT_CARD, indicies: [at] } : autoAnswer(message);
    }
    case OcgMessageType.SELECT_EFFECTYN:
      return { type: OcgResponseType.SELECT_EFFECTYN, yes: true };
    case OcgMessageType.SELECT_YESNO:
      return { type: OcgResponseType.SELECT_YESNO, yes: true };
    case OcgMessageType.SELECT_IDLECMD:
      return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null };
    default:
      return autoAnswer(message);
  }
}

// The duel screen's numbering of the zones it offers (worker.ts freeZones): own then opponent's, Monster then S/T zones
function zoneList(player: number, mask: number) {
  const zones: { player: number; location: OcgLocation; sequence: number }[] = [];
  for (let side = 0; side < 2; side++) {
    const bits = (mask >>> (side * 16)) & 0xffff;
    const controller = side === 0 ? player : 1 - player;
    for (let sequence = 0; sequence < 7; sequence++) if (!(bits & (1 << sequence))) zones.push({ player: controller, location: OcgLocation.MZONE, sequence });
    for (let sequence = 0; sequence < 8; sequence++) if (!(bits & (0x100 << sequence))) zones.push({ player: controller, location: OcgLocation.SZONE, sequence });
  }
  return zones;
}

/**
 * The picks the duel screen would send for this answer (worker.ts buildPrompt, hand traps held back), so a line found
 * here replays there exactly. undefined: the screen answers this prompt by itself and records nothing.
 */
function uiPicks(message: OcgMessage, response: OcgResponse): number[] | null | undefined {
  const r = response as unknown as Record<string, unknown>;
  switch (message.type) {
    case OcgMessageType.SELECT_IDLECMD:
    case OcgMessageType.SELECT_BATTLECMD:
      return message.player === 0 ? null : undefined;
    case OcgMessageType.SELECT_EFFECTYN:
    case OcgMessageType.SELECT_YESNO:
      return [r.yes ? 0 : 1];
    case OcgMessageType.SELECT_OPTION:
      return [r.index as number];
    case OcgMessageType.SELECT_CHAIN: {
      const offered = message.selects.map((card, index) => ({ card, index })).filter(({ card }) => !heldBack(card));
      if (message.player !== 0 || (!offered.length && !message.forced)) return undefined;
      const list = offered.length ? offered : message.selects.map((card, index) => ({ card, index }));
      return r.index === null ? null : [list.findIndex((entry) => entry.index === r.index)];
    }
    case OcgMessageType.SELECT_CARD:
    case OcgMessageType.SELECT_TRIBUTE:
    case OcgMessageType.SELECT_SUM:
      return r.indicies as number[];
    case OcgMessageType.SELECT_UNSELECT_CARD:
      return r.index === null ? null : [r.index as number];
    case OcgMessageType.SELECT_PLACE:
    case OcgMessageType.SELECT_DISFIELD: {
      const zones = zoneList(message.player, message.field_mask);
      return (r.places as { player: number; location: number; sequence: number }[]).map((place) => zones.findIndex((zone) => zone.player === place.player && zone.location === place.location && zone.sequence === place.sequence));
    }
    case OcgMessageType.SELECT_POSITION: {
      const allowed: number[] = [OcgPosition.FACEUP_ATTACK, OcgPosition.FACEUP_DEFENSE, OcgPosition.FACEDOWN_DEFENSE, OcgPosition.FACEDOWN_ATTACK].filter((one) => message.positions & one);
      return [allowed.indexOf(r.position as number)];
    }
    case OcgMessageType.SELECT_COUNTER:
      return r.counters as number[];
    case OcgMessageType.ANNOUNCE_RACE:
    case OcgMessageType.ANNOUNCE_ATTRIB:
    case OcgMessageType.ANNOUNCE_NUMBER:
      return [0];
    default:
      return undefined;
  }
}

// Everything else gets the plain answer: yes to optional effects, the first legal cards, the first free zone.
export function autoAnswer(message: OcgMessage): OcgResponse | null {
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
      // every effect of ours goes off, except hand traps in the hand (they would only stop our own play)
      if (message.player !== 0) return { type: OcgResponseType.SELECT_CHAIN, index: message.forced ? 0 : null };
      const at = message.selects.findIndex((card) => !heldBack(card));
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

export interface ProbeOptions {
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
/** Hands for the caller to probe elsewhere (probe() on each), answered in the same order. */
export interface Probes {
  probes: { hand: number[]; deck: number[]; options: ProbeOptions }[];
}
export const isProbes = (value: unknown): value is Probes => !!value && typeof value === "object" && "probes" in value;

// With `batch`, hands are asked for a dozen at a time (to be probed side by side) instead of probed here one by one
export function* probeDeck(env: ProbeEnv, main: number[], extra: number[], batch = false): Generator<{ done: number; total: number; evidence: Map<number, CardEvidence> } | Probes | undefined, void, unknown> {
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
  // each hand probed: here, or a dozen at a time by the caller
  const results = new Map<string, ProbeResult>();
  const probed = function* (hands: number[][], options: ProbeOptions, at: number): Generator<Probes | undefined, ProbeResult, unknown> {
    const hand = hands[at];
    const key = hand.join(",");
    if (!results.has(key)) {
      if (!batch) results.set(key, yield* probeSteps(env, hand, rest(hand), extra, options));
      else {
        const group = hands.slice(at, at + 12);
        const answer = (yield { probes: group.map((one) => ({ hand: one, deck: rest(one), options })) }) as ProbeResult[] | undefined;
        if (!answer || answer.length !== group.length) throw new Error("The engine check was not given its hands");
        group.forEach((one, index) => results.set(one.join(","), answer[index]));
      }
    }
    return results.get(key)!;
  };
  const singles = distinct.map((code) => [code]);
  for (const [at, code] of distinct.entries()) {
    const alone = yield* probed(singles, { budget: 150, depth: 6 }, at);
    evidence.set(code, { code, alone, partners: [], checked: 0 });
    if (!starts(alone)) lone.push(code);
    done++;
    yield { done, total, evidence };
  }
  const pairs: [number, number][] = [];
  lone.forEach((a, i) => lone.slice(i).forEach((b) => (a !== b || copies(a) > 1) && pairs.push([a, b])));
  total = done + pairs.length;
  for (const [at, [a, b]] of pairs.entries()) {
    const result = yield* probed(pairs, { budget: 60, depth: 6, untilDeck: true }, at);
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
  // every card started alone: nothing to pair, and the check is done
  if (!pairs.length) yield { done, total: done, evidence };
}

// ---------------------------------------------------------------------------
// Route search: from a hand toward a full board, the boards of tests you marked as working. A beam search: from
// each position kept, try every choice, and keep the few most promising positions for the next step.

export interface Route {
  board: number[];
  // what that board can do on the opponent's turn
  interruptions: Interruption[];
  // how much of your closest full board this board holds (1 = all of it), and which of your boards that was
  coverage: number;
  target: number[] | null;
  full: boolean;
  steps: string[];
  // the line as the duel screen takes it: replays in the app as a saved test
  ui: (number[] | null)[];
  // each step as "Activate:<code>", "Normal:<code>", "Special:<code>" or "pick:<hint>:<code>": a plan that can be
  // followed in another duel (the computer opponent plays its turn this way)
  keys: string[];
  // filled in after the search: each hand trap at each moment it can be used against this line
  chokes?: Choke[];
  nibiru?: NibiruCheck;
  // what the line leaves in place for their turn (filled in by the worker, which reads the card texts)
  protection?: Protection[];
  deck: number;
  extra: number;
  tried: number;
}

export interface RouteOptions {
  // a full board: at least this many interruptions (the search stops at the first one)
  goal?: number;
  // your working boards: a board close to one of them is preferred
  targets: number[][];
  // the opponent holds a hand trap and uses it at a set moment: the search looks for the best way through
  against?: Against | Against[];
  // "verb:code" of actions in your working lines, preferred when choosing what to try
  prior?: Set<string>;
  budget?: number;
  width?: number;
  depth?: number;
  // the tries of each level are asked for together (yielded as { need }), to be played in parallel elsewhere and
  // handed back with next(stops); otherwise each is played here, one by one
  batch?: boolean;
  // for tools: each level of the search as it is kept
  trace?: (level: number, kept: { steps: string[]; value: number; options: string[]; plan: number[] }[]) => void;
}

const overlap = (board: number[], target: number[]) => {
  const left = [...board];
  let found = 0;
  for (const code of target) {
    const at = left.indexOf(code);
    if (at >= 0) {
      left.splice(at, 1);
      found++;
    }
  }
  return target.length ? found / target.length : 0;
};

// "Normal Summon X" -> "Normal", "Activate: Tribute this card X" -> "Activate"
export const verbOf = (label: string) => label.split(/[ :]/)[0];
// A step's key: "Activate#<effect>:<code>" names which of a card's effects (Galaxy Wizard's Level or its search);
// "Normal:<code>", "Special:<code>", "pick:<hint>:<code>". Without the effect, any effect of that card matches.
export const stepKey = (label: string, code: number) => {
  const verb = verbOf(label);
  const effect = verb === "Activate" ? /#(\d+)/.exec(label)?.[1] : undefined;
  return effect ? `${verb}#${effect}:${code}` : `${verb}:${code}`;
};
export const plainKey = (key: string) => key.replace(/#\d+/, "");

/** Pauses (yields) after every duel tried; returns the best line found. */
/** Tries for the caller to play: each a plan from the start, answered in the same order. */
export interface Need {
  need: number[][];
  against?: Against | Against[];
}
export const isNeed = (value: unknown): value is Need => !!value && typeof value === "object" && "need" in value;
/** Lines for the caller to follow against a hand trap (playAgainst), answered in the same order. */
export interface FollowJob {
  keys: string[];
  trap: number;
  at: number;
  fixed: Against[];
}
export interface Follow {
  follow: FollowJob[];
}
export const isFollow = (value: unknown): value is Follow => !!value && typeof value === "object" && "follow" in value;
// followed here, or asked for when the caller plays them elsewhere
function* follows(env: ProbeEnv, hand: number[], deck: number[], extra: number[], jobs: FollowJob[], batch?: boolean): Generator<Follow, FollowResult[], unknown> {
  if (!batch) return jobs.map((job) => playAgainst(env, hand, deck, extra, job.keys, job.trap, job.at, job.fixed));
  const answer = (yield { follow: jobs }) as FollowResult[] | undefined;
  if (!answer || answer.length !== jobs.length) throw new Error("The check was not given its lines");
  return answer;
}

/** Pauses (yields) after every duel tried; returns the best line found. */
export function* routeSearch(env: ProbeEnv, hand: number[], deck: number[], extra: number[], options: RouteOptions): Generator<{ tried: number; best: Route | null } | Need | undefined, Route, unknown> {
  const budget = options.budget ?? 2500;
  const width = options.width ?? 10;
  const depth = options.depth ?? 80;
  // your lines' steps name a card, not always which of its effects: compared without it
  const prior = new Set([...(options.prior ?? [])].map(plainKey));
  const goal = options.goal ?? 3;
  // only what the line built: cards still in the hand it started with are not part of the board
  // (hand traps held are counted by the optimiser's "combo + hand trap" odds, not here)
  const count = (stop: Stop): Interruption[] => {
    if (!env.effects || !env.setcodes) return [];
    const left = [...hand];
    const built = stop.pieces.filter((piece) => {
      if (piece.location !== OcgLocation.HAND) return true;
      const at = left.indexOf(piece.code);
      if (at < 0) return true;
      left.splice(at, 1);
      return false;
    });
    const spells = stop.pieces.filter((piece) => piece.location === OcgLocation.SZONE).length;
    return interruptionsOf(built, env.effects, env.setcodes, isFirstTurnHandTrap, Math.max(0, 5 - spells), env.card);
  };
  type Node = { plan: number[]; stop: Stop; steps: string[]; keys: string[]; liked: number; value: number; route: Route };
  const judge = (stop: Stop, steps: string[], liked: number, tried: number, keys: string[] = []): { value: number; route: Route } => {
    let coverage = 0;
    let target: number[] | null = null;
    for (const one of options.targets) {
      const covered = overlap(stop.board, one);
      if (covered > coverage) [coverage, target] = [covered, one];
    }
    const interruptions = count(stop);
    const negates = interruptions.filter((one) => one.kind === "negate").length;
    // at the 5th summon: only the field and the hand (a Trap Set this turn can't be used yet)
    const ready = stop.fifth ? count({ ...stop, pieces: stop.fifth.filter((piece) => piece.location !== OcgLocation.SZONE) }) : [];
    const stopper = nibiruStopper(ready);
    const nibiru: NibiruCheck = { summons: stop.summons ?? 0, proof: (stop.summons ?? 0) < 5 || !!stopper, by: stopper?.code };
    const route: Route = { board: stop.board, interruptions, coverage, target, full: interruptions.length >= goal, steps, ui: stop.ui, keys, deck: stop.measure.deck, extra: stop.measure.extra, tried, nibiru };
    // what the board can stop on their turn first (negates above removal); then closeness to your working boards;
    // then what the line has gathered to keep going; then how much it looks like your own lines
    const value = interruptions.length * 50 + negates * 10 + (nibiru.summons >= 5 && nibiru.proof ? 15 : 0) + coverage * 20 + stop.measure.deck * 4 + stop.measure.extra * 3 + stop.board.length * 2 + liked * 1.5;
    return { value, route };
  };
  let tried = 0;
  // every position played once, whichever round reaches it again
  const played = new Map<string, Stop>();
  const replay = (plan: number[]) => {
    const key = plan.join(",");
    let stop = played.get(key);
    if (!stop) {
      stop = play(env, hand, deck, extra, plan, options.against);
      played.set(key, stop);
      tried++;
    }
    return stop;
  };
  const first = replay([]);
  const root: Node = { plan: [], stop: first, steps: [], keys: [], liked: 0, ...judge(first, [], 0, tried) };
  let best = root;
  // a full board that Nibiru could break: kept, while a little more is spent looking for one it can't
  let fullFound: Node | null = null;
  let limit = budget;
  // a beam of the most promising positions; when it dies out with budget left and no full board, it starts again
  // wider (a choice that looks no better at first, like which card Orbital 7 adds, can be the one the line needs)
  for (let round = 0, keep = width; round < 3 && tried < budget; round++, keep *= 4) {
    const seen = new Set<string>([first.key]);
    let beam: Node[] = [root];
    for (let level = 0; level < depth && beam.length && tried < budget; level++) {
      const children: Node[] = [];
      if (options.batch) {
        // every new try of this level at once, as far as the budget goes
        const plans: number[][] = [];
        for (const node of beam)
          for (let index = 0; index < node.stop.options.length && tried + plans.length < budget; index++) {
            const plan = [...node.plan, index];
            if (!played.has(plan.join(","))) plans.push(plan);
          }
        if (plans.length) {
          const stops = (yield { need: plans, against: options.against }) as Stop[] | undefined;
          if (!stops || stops.length !== plans.length) throw new Error("The search was not given its tries");
          plans.forEach((plan, at) => played.set(plan.join(","), stops[at]));
          tried += plans.length;
        }
      }
      for (const node of beam) {
        for (let index = 0; index < node.stop.options.length; index++) {
          // past the budget, only tries already played are still looked at
          if (tried >= budget && !played.has([...node.plan, index].join(","))) break;
          const label = node.stop.options[index];
          const before = tried;
          const child = replay([...node.plan, index]);
          if (tried > before) yield;
          if (child.failed || seen.has(child.key)) continue;
          seen.add(child.key);
          // like your lines: the same action on the same card, or the same pick for the same purpose (add, not send)
          const verb = verbOf(label);
          const key = verb === "pick" ? `pick:${node.stop.hint}:${node.stop.codes[index]}` : stepKey(label, node.stop.codes[index]);
          const liked = node.liked + (prior.has(plainKey(key)) ? 3 : 0);
          const steps = [...node.steps, label.replace(/#\d+/, "").replace(/@\d+$/, "")];
          const keys = [...node.keys, key];
          const next: Node = { plan: [...node.plan, index], stop: child, steps, keys, liked, ...judge(child, steps, liked, tried, keys) };
          if (next.value > best.value) best = next;
          if (next.route.full && next.route.nibiru?.proof) return { ...next.route, tried };
          if (next.route.full && !fullFound) {
            fullFound = next;
            limit = Math.min(budget, tried + 600);
          }
          if (fullFound && tried >= limit) return { ...fullFound.route, tried };
          // a position with nothing left to do is a finished line: a candidate for the best, but no room in the beam
          if (child.options.length) children.push(next);
        }
        yield { tried, best: best.route };
      }
      // equal positions: the one with more left to do first
      const rank = (node: Node) => node.value + Math.min(node.stop.options.length, 10) * 0.5;
      children.sort((a, b) => rank(b) - rank(a));
      beam = children.slice(0, keep);
      options.trace?.(level, beam.map((node) => ({ steps: node.steps, value: node.value, options: node.stop.options, plan: node.plan })));
    }
    options.trace?.(-1, []);
  }
  return { ...(fullFound && !best.route.full ? fullFound : best).route, tried };
}

// ---------------------------------------------------------------------------
// Choke points: a line replayed with the opponent holding one hand trap, used at one of the moments the engine allows
// it. Your side follows the line as far as it still can (skipping what the hand trap took away), and the board it ends
// on is counted. The moment that costs the most is that hand trap's choke point.

export interface ChokeWindow {
  // what the hand trap answered: "Galaxy Defense Robot Orbital 7" (its effect), "the summon of Number 38", "after X"
  at: string;
  interruptions: number;
  board: number[];
  // searched again with the hand trap in play (the best way through found), not just the line followed
  replanned?: boolean;
}
export interface Choke {
  trap: number;
  // the line's board when the hand trap is never used
  clean: number;
  windows: ChokeWindow[];
}

export interface FollowResult {
  windows: string[];
  used: string | null;
  interruptions: number;
  board: number[];
}

export function playAgainst(env: ProbeEnv, hand: number[], deck: number[], extra: number[], keys: string[], trap: number, useAt: number, fixed: Against[] = []): FollowResult {
  const { core } = env;
  const duel = core.createDuel({
    flags: OcgDuelMode.MODE_MR5 | OcgDuelMode.PSEUDO_SHUFFLE,
    seed: [1n, 2n, 3n, 4n],
    team1: { drawCountPerTurn: 1, startingDrawCount: hand.length, startingLP: 8000 },
    team2: { drawCountPerTurn: 1, startingDrawCount: 1 + fixed.length, startingLP: 8000 },
    cardReader: (code) => env.card(code),
    scriptReader: (name) => env.script(name),
    errorHandler: () => {},
  });
  if (!duel) throw new Error("The probe could not create a duel");
  try {
    for (const file of ["constant.lua", "utility.lua"]) core.loadScript(duel, file, env.script(file));
    const add = (code: number, location: OcgLocation, team: 0 | 1) =>
      core.duelNewCard(duel, { team, duelist: 0, code, controller: team, location, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    for (const code of [...deck, ...[...hand].reverse()]) add(code, OcgLocation.DECK, 0);
    for (const code of extra) add(code, OcgLocation.EXTRA, 0);
    add(trap, OcgLocation.DECK, 1);
    for (const use of fixed) add(use.trap, OcgLocation.DECK, 1);
    const fixedUsed = fixed.map(() => false);
    core.startDuel(duel);

    const windows: string[] = [];
    let used: string | null = null;
    const chain: number[] = [];
    let lastSummon = 0;
    let next = 0; // the next step of the line to play
    let hint = 0;
    const finish = (): FollowResult => {
      const pieces: Piece[] = [];
      for (const location of [OcgLocation.MZONE, OcgLocation.SZONE, OcgLocation.HAND, OcgLocation.GRAVE, OcgLocation.EXTRA])
        for (const card of core.duelQueryLocation(duel, { flags: QUERY_OUT, controller: 0, location }))
          if (card?.code) pieces.push({ code: card.code, location, materials: card.overlayCards?.length ?? 0 });
      const left = [...hand];
      const built = pieces.filter((piece) => {
        if (piece.location !== OcgLocation.HAND) return true;
        const at = left.indexOf(piece.code);
        if (at < 0) return true;
        left.splice(at, 1);
        return false;
      });
      const spells = pieces.filter((piece) => piece.location === OcgLocation.SZONE).length;
      const found = env.effects && env.setcodes ? interruptionsOf(built, env.effects, env.setcodes, isFirstTurnHandTrap, Math.max(0, 5 - spells), env.card) : [];
      const board = pieces.filter((piece) => piece.location === OcgLocation.MZONE || piece.location === OcgLocation.SZONE).map((piece) => piece.code);
      return { windows, used, interruptions: found.length, board };
    };
    // the first step from `next` on that is on offer (what the hand trap took away is skipped)
    let lastActed = 0;
    const follow = (offered: { code?: number; key: (k: string) => boolean; exact?: (k: string) => boolean }[]): number => {
      for (let step = next; step < keys.length; step++) {
        let at = offered.findIndex((option) => (option.exact ?? option.key)(keys[step]));
        if (at < 0) at = offered.findIndex((option) => option.key(keys[step]));
        if (at >= 0) {
          next = step + 1;
          lastActed = offered[at].code ?? lastActed;
          return at;
        }
      }
      return -1;
    };
    for (let guard = 0; guard < 4000; guard++) {
      const status = core.duelProcess(duel);
      let response: OcgResponse | null = null;
      for (const message of core.duelGetMessage(duel)) {
        switch (message.type) {
          case OcgMessageType.CHAINING:
            chain.push(message.code);
            break;
          case OcgMessageType.CHAIN_END:
            chain.length = 0;
            lastSummon = 0;
            break;
          case OcgMessageType.SUMMONING:
          case OcgMessageType.SPSUMMONING:
            lastSummon = message.code;
            break;
          case OcgMessageType.NEW_PHASE:
            lastSummon = 0;
            break;
          case OcgMessageType.HINT:
            if (message.hint_type === OcgHintType.SELECTMSG && message.player === 0) hint = Number(message.hint);
            break;
          case OcgMessageType.RETRY:
            return finish();
          default: {
            if (!isPrompt(message.type)) break;
            if ("player" in message && message.player === 1) {
              // what it answers: an effect, a summon, or an open moment between your actions
              const moment = chain.length ? env.name(chain[chain.length - 1]) : lastSummon ? `the summon of ${env.name(lastSummon)}` : lastActed ? `after ${env.name(lastActed)}` : "the start of the turn";
              // a hand trap already placed at this moment goes first
              const placed = message.type === OcgMessageType.SELECT_CHAIN ? fixed.findIndex((use, index) => !fixedUsed[index] && use.at === moment && message.selects.some((card) => card.code === use.trap)) : -1;
              if (placed >= 0 && message.type === OcgMessageType.SELECT_CHAIN) {
                fixedUsed[placed] = true;
                response = { type: OcgResponseType.SELECT_CHAIN, index: message.selects.findIndex((card) => card.code === fixed[placed].trap) };
              } else if (message.type === OcgMessageType.SELECT_CHAIN) {
                const at = message.selects.findIndex((card) => card.code === trap);
                if (at < 0) response = { type: OcgResponseType.SELECT_CHAIN, index: message.forced ? 0 : null };
                else {
                  const label = moment;
                  windows.push(label);
                  const now = windows.length - 1 === useAt;
                  if (now) used = label;
                  response = { type: OcgResponseType.SELECT_CHAIN, index: now ? at : null };
                }
              } else if (message.type === OcgMessageType.SELECT_CARD) {
                // its target: the card that was just activated or summoned, if it can be
                const wanted = chain[chain.length - 2] ?? lastSummon;
                const at = message.selects.findIndex((card) => card.code === wanted);
                response = at >= 0 ? { type: OcgResponseType.SELECT_CARD, indicies: [at] } : autoAnswer(message);
              } else if (message.type === OcgMessageType.SELECT_EFFECTYN || message.type === OcgMessageType.SELECT_YESNO) {
                response = message.type === OcgMessageType.SELECT_EFFECTYN ? { type: OcgResponseType.SELECT_EFFECTYN, yes: true } : { type: OcgResponseType.SELECT_YESNO, yes: true };
              } else if (message.type === OcgMessageType.SELECT_IDLECMD) {
                response = { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null };
              } else response = autoAnswer(message);
            } else if (message.type === OcgMessageType.SELECT_IDLECMD) {
              hint = 0;
              const offered = idleOptions(env, message).map((option) => ({ ...option, key: (k: string) => plainKey(k) === `${verbOf(option.label)}:${option.code}`, exact: (k: string) => k === stepKey(option.label, option.code ?? 0) }));
              const at = follow(offered);
              if (at < 0) return finish();
              response = offered[at].response;
            } else {
              const branch = deckPick(env, message);
              const at = branch ? follow(branch.map((option) => ({ ...option, key: (k: string) => k === `pick:${hint}:${option.code}` || (k.startsWith("pick:") && k.endsWith(`:${option.code}`)) }))) : -1;
              response = branch && at >= 0 ? branch[at].response : autoAnswer(message);
              hint = 0;
            }
            if (!response) return finish();
          }
        }
      }
      if (response) core.duelSetResponse(duel, response);
      else if (status === OcgProcessResult.END) return finish();
    }
    return finish();
  } finally {
    core.destroyDuel(duel);
  }
}

// The hand traps checked by default: the ones every deck has to play through
export const CHOKE_TRAPS = [14558127, 10045474, 97268402, 59438930, 27204311, 94145021, 73642296, 24508238];

/**
 * Every moment each hand trap can be used against the line, and what you still end on. First the line is simply
 * followed past the hand trap; then the worst moments are searched again with the hand trap in the duel, so the
 * result is the best way through it the search can find (an extender, another searcher, a different order).
 * Pauses (yields) after every duel.
 */
export function* chokePoints(
  env: ProbeEnv, hand: number[], deck: number[], extra: number[], keys: string[], traps = CHOKE_TRAPS, options: { goal?: number; budget?: number; replans?: number; batch?: boolean } = {},
): Generator<unknown, Choke[], unknown> {
  const out: Choke[] = [];
  const batch = options.batch;
  for (const trap of traps) {
    if (!env.card(trap)) continue;
    const [clean] = yield* follows(env, hand, deck, extra, [{ keys, trap, at: -1, fixed: [] }], batch);
    yield;
    // one entry per moment, the worst outcome when the same moment comes up more than once
    const byMoment = new Map<string, ChokeWindow>();
    const moments = Array.from({ length: Math.min(clean.windows.length, 25) }, (_, at) => ({ keys, trap, at, fixed: [] }));
    const results = yield* follows(env, hand, deck, extra, moments, batch);
    for (let at = 0; at < moments.length; at++) {
      const result = results[at];
      const label = result.used ?? clean.windows[at];
      const seen = byMoment.get(label);
      if (!seen || result.interruptions < seen.interruptions) byMoment.set(label, { at: label, interruptions: result.interruptions, board: result.board });
    }
    // play around it: search again at the worst moment until the worst one has been searched
    const searched = new Set<string>();
    for (let round = 0; round < (options.replans ?? 3); round++) {
      const worst = [...byMoment.values()].filter((window) => !searched.has(window.at) && window.interruptions < clean.interruptions).sort((a, b) => a.interruptions - b.interruptions)[0];
      if (!worst) break;
      // stop once the worst moment left is one that has already been searched
      const lowest = Math.min(...[...byMoment.values()].map((window) => window.interruptions));
      if (worst.interruptions > lowest) break;
      searched.add(worst.at);
      const through = yield* routeSearch(env, hand, deck, extra, { targets: [], prior: new Set(keys), goal: options.goal ?? 3, budget: options.budget ?? 350, against: { trap, at: worst.at }, batch });
      if (through.interruptions.length > worst.interruptions) byMoment.set(worst.at, { at: worst.at, interruptions: through.interruptions.length, board: through.board, replanned: true });
      else worst.replanned = true;
    }
    out.push({ trap, clean: clean.interruptions, windows: [...byMoment.values()] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Several hand traps at once (Ash and Imperm, say). The opponent uses them one after another, each at its worst
// moment for you; after each one the search looks for your best way through before the next is placed. Every order
// is tried (Ash first or Imperm first) and the one that hurts most is kept.

export interface ComboStep {
  trap: number;
  at: string;
}
export interface ChokeCombo {
  traps: number[];
  // the order and moments that hurt most, and what you end on then
  steps: ComboStep[];
  interruptions: number;
  board: number[];
  // a hand trap of the set that never had a moment against this line
  unused: number[];
}

const orders = (list: number[]): number[][] =>
  list.length <= 1 ? [list] : list.flatMap((first, index) => orders([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [first, ...rest]));

/** Pauses (yields) after every duel tried. */
export function* chokeCombo(
  env: ProbeEnv, hand: number[], deck: number[], extra: number[], keys: string[], traps: number[], options: { goal?: number; budget?: number; batch?: boolean } = {},
): Generator<unknown, ChokeCombo, unknown> {
  const batch = options.batch;
  let best: ChokeCombo | null = null;
  for (const order of orders(traps)) {
    const fixed: Against[] = [];
    const unused: number[] = [];
    let line = keys;
    let interruptions = -1;
    let board: number[] = [];
    for (const trap of order) {
      // every moment this hand trap has against the line as it now stands (the others already placed)
      const [clean] = yield* follows(env, hand, deck, extra, [{ keys: line, trap, at: -1, fixed }], batch);
      yield;
      if (!clean.windows.length) {
        unused.push(trap);
        if (interruptions < 0) [interruptions, board] = [clean.interruptions, clean.board];
        continue;
      }
      let worst: { at: string; result: FollowResult } | null = null;
      const moments = Array.from({ length: Math.min(clean.windows.length, 20) }, (_, at) => ({ keys: line, trap, at, fixed: [...fixed] }));
      const results = yield* follows(env, hand, deck, extra, moments, batch);
      for (let at = 0; at < moments.length; at++) {
        const result = results[at];
        if (!worst || result.interruptions < worst.result.interruptions) worst = { at: result.used ?? clean.windows[at], result };
      }
      fixed.push({ trap, at: worst!.at });
      // your best way through everything placed so far
      const through = yield* routeSearch(env, hand, deck, extra, { targets: [], prior: new Set(line), goal: options.goal ?? 3, budget: options.budget ?? 250, against: [...fixed], batch });
      if (through.interruptions.length > worst!.result.interruptions) {
        [interruptions, board, line] = [through.interruptions.length, through.board, through.keys];
      } else [interruptions, board] = [worst!.result.interruptions, worst!.result.board];
    }
    const result: ChokeCombo = { traps, steps: [...fixed], interruptions: Math.max(0, interruptions), board, unused };
    if (!best || result.interruptions < best.interruptions) best = result;
  }
  return best ?? { traps, steps: [], interruptions: 0, board: [], unused: traps };
}
