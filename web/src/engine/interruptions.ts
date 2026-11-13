// What an end board can do on the opponent's turn, read from the card scripts EDOPro runs.
// An interruption is an effect usable on the opponent's turn (a Quick Effect, a Trap, a Quick-Play Spell) that negates
// or removes: Number 38 negating, Photon Change Dragon banishing. Searching or summoning on their turn is not one,
// neither is anything only usable in battle. Costs are checked where they show (Xyz Materials to detach), and so are
// simple conditions on your own field (Tachyon Transmigration needs a "Galaxy-Eyes" monster; from the hand, a
// "Galaxy-Eyes Tachyon Dragon").

export type Kind = "negate" | "removal" | "other";

export interface QuickEffect {
  kind: Kind;
  // where the card has to be: location bits (2 hand, 4 Monster Zone, 8 Spell & Trap Zone, 16 GY, 32 banished)
  where: number;
  // Xyz Materials it detaches
  detach: number;
  // face-up cards you must control: any of these archetypes or passcodes
  needs: { sets: number[]; codes: number[] };
  // a Trap that can also be activated from the hand, and what that needs
  fromHand?: { sets: number[]; codes: number[] };
  // activated as a card (a Trap or Quick-Play Spell): Set first, unless it can go from the hand
  activate: boolean;
}

const LOCATIONS: Record<string, number> = { LOCATION_HAND: 2, LOCATION_MZONE: 4, LOCATION_SZONE: 8, LOCATION_ONFIELD: 12, LOCATION_GRAVE: 16, LOCATION_REMOVED: 32, LOCATION_FZONE: 8, LOCATION_PZONE: 8 };
// effects that only matter in battle
const BATTLE = /EVENT_(PRE_DAMAGE_CALCULATE|PRE_BATTLE_DAMAGE|BATTLE_|ATTACK_ANNOUNCE|BE_BATTLE_TARGET|DAMAGE_STEP)|PHASE_DAMAGE/;

function kindOf(category: string): Kind {
  if (/CATEGORY_(NEGATE|DISABLE)\b/.test(category)) return "negate";
  if (/CATEGORY_(REMOVE|DESTROY|TODECK|TOGRAVE|CONTROL|RELEASE|POSITION|TOEXTRA)\b/.test(category)) return "removal";
  if (/CATEGORY_TOHAND\b/.test(category) && !/CATEGORY_SEARCH\b/.test(category)) return "removal";
  return "other";
}

/** Archetype constants (SET_GALAXY_EYES = 0x107b) from the scripts' constant files. */
export function readSetConstants(...sources: string[]): Map<string, number> {
  const constants = new Map<string, number>();
  for (const source of sources) for (const match of source.matchAll(/^\s*(SET_\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/gm)) constants.set(match[1], Number(match[2]));
  return constants;
}

// What a condition function asks of your field: archetypes and passcodes it checks your Monster Zone / field for
// the body of a script function like s.condition
function bodyOf(source: string, name: string | undefined): string {
  if (!name) return "";
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const end = source.indexOf("\nend", at);
  return source.slice(at, end < 0 ? undefined : end);
}
// a condition that only holds in battle (Galaxy-Eyes Photon Dragon banishing during the Battle Phase)
const BATTLE_ONLY = /IsBattlePhase|PHASE_BATTLE|IsDamageStep|IsDamageCalculated|GetAttacker\(|GetAttackTarget\(|GetBattleTarget|GetBattleMonster/;

function fieldNeeds(source: string, name: string | undefined, sets: Map<string, number>) {
  const needs = { sets: [] as number[], codes: [] as number[] };
  if (!name) return needs;
  const text = bodyOf(source, name);
  // only conditions about your own field; anything else (the chain, the opponent) the engine decides on the spot
  if (!/IsExistingMatchingCard[\s\S]*?LOCATION_(MZONE|ONFIELD)/.test(text)) return needs;
  for (const match of text.matchAll(/IsSetCard\s*,\s*(SET_\w+)/g)) if (sets.has(match[1])) needs.sets.push(sets.get(match[1])!);
  for (const match of text.matchAll(/IsCode\s*,\s*(\d+)/g)) needs.codes.push(Number(match[1]));
  return needs;
}

/** Every effect of a card that could be used on the opponent's turn, read from its script. */
export function readEffects(source: string, cardType: number, sets: Map<string, number>): QuickEffect[] {
  type Draft = { type: string; category: string; range: string; code: string; cost: string; condition?: string };
  const drafts = new Map<string, Draft>();
  const registered: Draft[] = [];
  for (const line of source.split("\n")) {
    let match = /local\s+(\w+)\s*=\s*Effect\.CreateEffect/.exec(line);
    if (match) {
      drafts.set(match[1], { type: "", category: "", range: "", code: "", cost: "" });
      continue;
    }
    match = /local\s+(\w+)\s*=\s*(\w+):Clone\(\)/.exec(line);
    if (match && drafts.has(match[2])) {
      drafts.set(match[1], { ...drafts.get(match[2])! });
      continue;
    }
    match = /(\w+):Set(Type|Category|Range|Code|Cost|Condition)\((.*)\)\s*$/.exec(line.trim());
    if (match && drafts.has(match[1])) {
      const draft = drafts.get(match[1])!;
      const field = match[2].toLowerCase() as keyof Draft;
      draft[field] = match[3];
      continue;
    }
    match = /RegisterEffect\((\w+)/.exec(line);
    if (match && drafts.has(match[1])) registered.push({ ...drafts.get(match[1])! });
  }
  const actInHand = registered.find((draft) => draft.code.includes("EFFECT_TRAP_ACT_IN_HAND"));
  const isTrap = (cardType & 4) !== 0;
  const isQuickPlay = (cardType & 2) !== 0 && (cardType & 0x10000) !== 0;
  const effects: QuickEffect[] = [];
  for (const draft of registered) {
    const quick = /EFFECT_TYPE_QUICK_[OF]/.test(draft.type);
    const activate = /EFFECT_TYPE_ACTIVATE/.test(draft.type) && (isTrap || isQuickPlay);
    if (!quick && !activate) continue;
    if (BATTLE.test(draft.code)) continue;
    if (BATTLE_ONLY.test(bodyOf(source, /s\.\w+/.exec(draft.condition ?? "")?.[0]))) continue;
    let where = 0;
    for (const [name, bits] of Object.entries(LOCATIONS)) if (draft.range.includes(name)) where |= bits;
    if (activate) where |= 8;
    if (!where) continue;
    const detach = Number(/DetachFromSelf\((\d+)/.exec(draft.cost)?.[1] ?? /dxmcostgen\((\d+)/.exec(draft.cost)?.[1] ?? /RemoveOverlayCard\(tp,(\d+)/.exec(draft.cost)?.[1] ?? 0);
    effects.push({
      kind: kindOf(draft.category),
      where,
      detach,
      needs: fieldNeeds(source, /s\.\w+/.exec(draft.condition ?? "")?.[0], sets),
      fromHand: activate && isTrap && actInHand ? fieldNeeds(source, /s\.\w+/.exec(actInHand.condition ?? "")?.[0], sets) : undefined,
      activate,
    });
  }
  return effects;
}

/** ocgcore's IsSetCard: the same archetype number, and every sub-archetype bit of the one asked for */
const inSet = (setcodes: number[], set: number) => setcodes.some((code) => (code & 0xfff) === (set & 0xfff) && (code & set) === set);

export interface Piece {
  code: number;
  // 2 hand, 4 Monster Zone, 8 Spell & Trap Zone, 16 GY
  location: number;
  materials: number;
}

export interface Interruption {
  code: number;
  kind: "negate" | "removal";
  // "field", "hand", "set" (a Trap from the hand you can Set this turn), "gy"
  from: "field" | "hand" | "set" | "gy";
}

/**
 * The interruptions a position holds going into the opponent's turn: each card counts once, for its best effect.
 * `handTrap(code)`: known hand traps in the hand count as one each. `freeSpellZones`: room to Set Traps from the hand.
 */
export function interruptionsOf(
  pieces: Piece[],
  effectsOf: (code: number) => QuickEffect[],
  setcodesOf: (code: number) => number[],
  handTrap: (code: number) => boolean,
  freeSpellZones: number,
): Interruption[] {
  const faceUp = pieces.filter((piece) => piece.location === 4 || piece.location === 8);
  const met = (needs: { sets: number[]; codes: number[] }) =>
    (needs.sets.length === 0 && needs.codes.length === 0) ||
    faceUp.some((piece) => needs.codes.includes(piece.code) || needs.sets.some((set) => inSet(setcodesOf(piece.code), set)));
  const found: Interruption[] = [];
  let zones = freeSpellZones;
  for (const piece of pieces) {
    const usable = effectsOf(piece.code).filter((effect) => effect.kind !== "other" && piece.materials >= effect.detach && met(effect.needs));
    const best = (list: QuickEffect[]) => list.find((effect) => effect.kind === "negate") ?? list[0];
    if (piece.location === 4 || piece.location === 8) {
      const effect = best(usable.filter((one) => one.where & piece.location));
      if (effect) found.push({ code: piece.code, kind: effect.kind as Interruption["kind"], from: "field" });
    } else if (piece.location === 16) {
      const effect = best(usable.filter((one) => one.where & 16));
      if (effect) found.push({ code: piece.code, kind: effect.kind as Interruption["kind"], from: "gy" });
    } else if (piece.location === 2) {
      // a hand trap that is a Trap (Infinite Impermanence) is Set like any other going first
      if (handTrap(piece.code) && !effectsOf(piece.code).some((effect) => effect.activate)) {
        found.push({ code: piece.code, kind: "negate", from: "hand" });
        continue;
      }
      const fromHand = best(usable.filter((one) => (one.where & 2 && !one.activate) || (one.fromHand && met(one.fromHand))));
      if (fromHand) {
        found.push({ code: piece.code, kind: fromHand.kind as Interruption["kind"], from: "hand" });
        continue;
      }
      // a Trap or Quick-Play Spell you can Set now and use on their turn
      const set = best(usable.filter((one) => one.activate));
      if (set && zones > 0) {
        zones--;
        found.push({ code: piece.code, kind: set.kind as Interruption["kind"], from: "set" });
      }
    }
  }
  return found;
}
