// What an end board can do on the opponent's turn, read from the card scripts EDOPro runs.
// An interruption is an effect usable on the opponent's turn (a Quick Effect, a Trap, a Quick-Play Spell) that negates
// or removes: Number 38 negating, Photon Change Dragon banishing. Searching or summoning on their turn is not one,
// neither is anything only usable in battle. Costs are checked where they show (Xyz Materials to detach), and so are
// simple conditions on your own field (Tachyon Transmigration needs a "Galaxy-Eyes" monster; from the hand, a
// "Galaxy-Eyes Tachyon Dragon").

export type Kind = "negate" | "removal" | "other";
// what a negate stops: monster effects (Number 90), Spells (Number 38), Spells and Traps, every face-up card on the
// field (Photon Howling), or anything (Tachyon Transmigration)
export type Scope = "monster" | "spell" | "trap" | "spell/trap" | "board" | "any";

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
  scope?: Scope;
  // once per turn by name (SetCountLimit(1,id)): a second copy adds nothing
  oncePerName?: boolean;
  // Special Summons from the Extra Deck an Xyz Monster this many Ranks above one you control (Eternal Galaxy)
  rankUp?: { by: number; sets: number[] };
  // which of the card's effects (its description string): "0", "1" ...
  description?: string;
  // what it leaves in place through the opponent's turn (Galaxy-Eyes Cipher X Dragon: they cannot target)
  protects?: boolean;
}

// what a negate's condition and operation ask about the effect it stops
function scopeOf(condition: string, all: string): Scope {
  if (/IsNegatable[\s\S]*?LOCATION_ONFIELD\s*,\s*LOCATION_ONFIELD/.test(all)) return "board";
  const monster = /IsMonsterEffect\(|IsActiveType\(TYPE_MONSTER\)/.test(condition);
  const spell = /IsSpellEffect\(|IsActiveType\(TYPE_SPELL\)/.test(condition);
  const trap = /IsTrapEffect\(|IsActiveType\(TYPE_TRAP\)/.test(condition);
  const both = /IsSpellTrapEffect\(|EFFECT_TYPE_ACTIVATE|TYPE_SPELL\s*\+\s*TYPE_TRAP|TYPE_SPELL\s*\|\s*TYPE_TRAP/.test(condition);
  if (monster && (both || (spell && trap))) return "any";
  if (monster && !spell && !trap) return "monster";
  if (both || (spell && trap)) return "spell/trap";
  if (spell) return "spell";
  if (trap) return "trap";
  return "any";
}
// effects an operation leaves in place that protect your cards, lasting into the opponent's turn
const PROTECTION = /EFFECT_(CANNOT_BE_EFFECT_TARGET|INDESTRUCTABLE_EFFECT|INDESTRUCTABLE_BATTLE|IMMUNE_EFFECT|CANNOT_BE_BATTLE_TARGET|CANNOT_INACTIVATE|CANNOT_DISEFFECT|CANNOT_DISABLE|CANNOT_REMOVE|CANNOT_RELEASE|CANNOT_TO_DECK|CANNOT_TO_GRAVE)\b/;
const INTO_THEIR_TURN = /RESET_OPPO_TURN|PHASE_END\s*,\s*2\b|RESET_SELF_TURN|IsTurnPlayer\(tp\)\s*and\s*2\b/;

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
  type Draft = { type: string; category: string; range: string; code: string; cost: string; condition?: string; target?: string; operation?: string; countlimit?: string; description?: string };
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
    match = /(\w+):Set(Type|Category|Range|Code|Cost|Condition|Target|Operation|CountLimit|Description)\((.*)\)\s*$/.exec(line.trim());
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
  // a function named in the script (s.condition), or written in place (function(e,tp,...) return ... end)
  const fn = (text: string | undefined) => (text?.includes("function(") ? text : bodyOf(source, /s\.\w+/.exec(text ?? "")?.[0]));
  for (const draft of registered) {
    const quick = /EFFECT_TYPE_QUICK_[OF]/.test(draft.type);
    const activate = /EFFECT_TYPE_ACTIVATE/.test(draft.type) && (isTrap || isQuickPlay);
    const description = /Stringid\(\s*id\s*,\s*(\d+)\)/.exec(draft.description ?? "")?.[1];
    // used this turn, it keeps your cards safe on theirs (Cipher X: they cannot target your LIGHT monsters)
    const operation = fn(draft.operation);
    if (!quick && !activate) {
      if (PROTECTION.test(operation) && INTO_THEIR_TURN.test(operation)) effects.push({ kind: "other", where: 0, detach: 0, needs: { sets: [], codes: [] }, activate: false, description, protects: true });
      continue;
    }
    if (BATTLE.test(draft.code)) continue;
    if (BATTLE_ONLY.test(bodyOf(source, /s\.\w+/.exec(draft.condition ?? "")?.[0]))) continue;
    let where = 0;
    for (const [name, bits] of Object.entries(LOCATIONS)) if (draft.range.includes(name)) where |= bits;
    if (activate) where |= 8;
    if (!where) continue;
    const detach = Number(/DetachFromSelf\((\d+)/.exec(draft.cost)?.[1] ?? /dxmcostgen\((\d+)/.exec(draft.cost)?.[1] ?? /RemoveOverlayCard\(tp,(\d+)/.exec(draft.cost)?.[1] ?? 0);
    const kind = kindOf(draft.category);
    const conditionText = fn(draft.condition);
    // a rank-up from the Extra Deck on their turn: the Xyz Monster it brings out is what interrupts
    let rankUp: QuickEffect["rankUp"];
    const by = /(?:rk|GetRank\(\))\s*\+\s*(\d+)/.exec(source)?.[1];
    if (kind === "other" && /CATEGORY_SPECIAL_SUMMON/.test(draft.category) && by && /LOCATION_EXTRA/.test(source)) {
      const filter = source.split(/\nfunction /).find((one) => /IsRank\(/.test(one)) ?? "";
      rankUp = { by: Number(by), sets: [...filter.matchAll(/SET_\w+/g)].flatMap((match) => (sets.has(match[0]) ? [sets.get(match[0])!] : [])) };
    }
    effects.push({
      kind,
      scope: kind === "negate" ? scopeOf(conditionText, conditionText + fn(draft.target) + operation) : undefined,
      oncePerName: /^\s*1\s*,\s*(id|\{\s*id)/.test(draft.countlimit ?? ""),
      rankUp,
      description,
      protects: PROTECTION.test(operation) && INTO_THEIR_TURN.test(operation),
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

/**
 * Nibiru: the opponent can use it once you have summoned 5 monsters in the turn. A line is safe from it if, by your 5th
 * summon, a negate that stops a monster effect (a monster negate or an omni-negate) is ready on the field or usable
 * from the hand. A Trap Set this turn can't be activated yet; a rank-up doesn't count (it needs the Trap).
 */
export interface NibiruCheck {
  // monsters you summon in the line
  summons: number;
  // fewer than 5 summons, or a negate ready by the 5th
  proof: boolean;
  // the card that negates it
  by?: number;
}
export const nibiruStopper = (ready: Interruption[]) =>
  ready.find((one) => one.kind === "negate" && !one.via && one.from !== "set" && (one.scope === "monster" || one.scope === "any" || !one.scope));

/** Something a line leaves in place for the opponent's turn: the card, and its words for it. */
export interface Protection {
  code: number;
  text: string;
}

export interface Piece {
  code: number;
  // 2 hand, 4 Monster Zone, 8 Spell & Trap Zone, 16 GY
  location: number;
  materials: number;
}

export interface Interruption {
  code: number;
  kind: "negate" | "removal";
  scope?: Scope;
  // the card it brings out that does the interrupting (Eternal Galaxy: Number 90)
  via?: number;
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
  // Rank and kind of a card, for rank-ups from the Extra Deck (pieces at location 64)
  cardOf?: (code: number) => { type: number; level: number } | null,
): Interruption[] {
  // a card whose effect is once per turn by name counts once however many copies there are
  const counted = new Set<number>();
  const fresh = (code: number, effect: QuickEffect) => !(effect.oncePerName && counted.has(code));
  const take = (code: number, effect: QuickEffect) => effect.oncePerName && counted.add(code);
  const faceUp = pieces.filter((piece) => piece.location === 4 || piece.location === 8);
  const met = (needs: { sets: number[]; codes: number[] }) =>
    (needs.sets.length === 0 && needs.codes.length === 0) ||
    faceUp.some((piece) => needs.codes.includes(piece.code) || needs.sets.some((set) => inSet(setcodesOf(piece.code), set)));
  const found: Interruption[] = [];
  let zones = freeSpellZones;
  for (const piece of pieces) {
    if (piece.location === 64) continue;
    const usable = effectsOf(piece.code).filter((effect) => effect.kind !== "other" && piece.materials >= effect.detach && met(effect.needs) && fresh(piece.code, effect));
    const best = (list: QuickEffect[]) => list.find((effect) => effect.kind === "negate") ?? list[0];
    if (piece.location === 4 || piece.location === 8) {
      const effect = best(usable.filter((one) => one.where & piece.location));
      if (effect) (take(piece.code, effect), found.push({ code: piece.code, kind: effect.kind as Interruption["kind"], scope: effect.scope, from: "field" }));
    } else if (piece.location === 16) {
      const effect = best(usable.filter((one) => one.where & 16));
      if (effect) (take(piece.code, effect), found.push({ code: piece.code, kind: effect.kind as Interruption["kind"], scope: effect.scope, from: "gy" }));
    } else if (piece.location === 2) {
      // a hand trap that is a Trap (Infinite Impermanence) is Set like any other going first
      if (handTrap(piece.code) && !effectsOf(piece.code).some((effect) => effect.activate)) {
        found.push({ code: piece.code, kind: "negate", scope: effectsOf(piece.code).find((effect) => effect.kind === "negate")?.scope, from: "hand" });
        continue;
      }
      const fromHand = best(usable.filter((one) => (one.where & 2 && !one.activate) || (one.fromHand && met(one.fromHand))));
      if (fromHand) {
        take(piece.code, fromHand);
        found.push({ code: piece.code, kind: fromHand.kind as Interruption["kind"], scope: fromHand.scope, from: "hand" });
        continue;
      }
      // a Trap or Quick-Play Spell you can Set now and use on their turn
      const set = best(usable.filter((one) => one.activate));
      if (set && zones > 0) {
        zones--;
        take(piece.code, set);
        found.push({ code: piece.code, kind: set.kind as Interruption["kind"], scope: set.scope, from: "set" });
      }
    }
  }
  // rank-ups on their turn (Eternal Galaxy): one of your Xyz Monsters into an Extra Deck monster with a negate or removal
  if (cardOf) {
    const XYZ = 0x800000;
    const extra = pieces.filter((piece) => piece.location === 64);
    const used = new Set<Piece>();
    for (const piece of pieces) {
      if (piece.location !== 2 && piece.location !== 8) continue;
      const effect = effectsOf(piece.code).find((one) => one.rankUp && met(one.needs) && (piece.location === 8 || one.activate || one.where & 2));
      if (!effect?.rankUp) continue;
      if (piece.location === 2 && effect.activate && !(effect.fromHand && met(effect.fromHand)) && zones <= 0) continue;
      let best: { via: Piece; interruption: QuickEffect } | null = null;
      for (const target of pieces) {
        const card = target.location === 4 ? cardOf(target.code) : null;
        if (!card || !(card.type & XYZ)) continue;
        for (const candidate of extra) {
          const into = cardOf(candidate.code);
          if (used.has(candidate) || !into || !(into.type & XYZ) || into.level !== card.level + effect.rankUp.by) continue;
          if (effect.rankUp.sets.length && !effect.rankUp.sets.some((set) => inSet(setcodesOf(candidate.code), set))) continue;
          // the target becomes material and its materials move over
          const materials = target.materials + 1;
          const stops = effectsOf(candidate.code).filter((one) => one.kind !== "other" && one.where & 4 && materials >= one.detach && fresh(candidate.code, one));
          const pick = stops.find((one) => one.kind === "negate") ?? stops[0];
          if (pick && (!best || (pick.kind === "negate" && best.interruption.kind !== "negate"))) best = { via: candidate, interruption: pick };
        }
      }
      if (!best) continue;
      if (piece.location === 2 && effect.activate && !(effect.fromHand && met(effect.fromHand))) zones--;
      used.add(best.via);
      take(best.via.code, best.interruption);
      found.push({ code: piece.code, kind: best.interruption.kind as Interruption["kind"], scope: best.interruption.scope, via: best.via.code, from: piece.location === 8 ? "field" : effect.activate && !(effect.fromHand && met(effect.fromHand)) ? "set" : "hand" });
    }
  }
  return found;
}

/** What each of a card's effects does, by its description (Stringid index): negate, removal or other. */
export function readKinds(source: string): Map<string, Kind> {
  const kinds = new Map<string, Kind>();
  const drafts = new Map<string, { category: string; description: string }>();
  for (const line of source.split("\n")) {
    let match = /local\s+(\w+)\s*=\s*Effect\.CreateEffect/.exec(line);
    if (match) {
      drafts.set(match[1], { category: "", description: "" });
      continue;
    }
    match = /local\s+(\w+)\s*=\s*(\w+):Clone\(\)/.exec(line);
    if (match && drafts.has(match[2])) {
      drafts.set(match[1], { ...drafts.get(match[2])! });
      continue;
    }
    match = /(\w+):Set(Category|Description)\((.*)\)\s*$/.exec(line.trim());
    if (match && drafts.has(match[1])) {
      drafts.get(match[1])![match[2] === "Category" ? "category" : "description"] = match[3];
      continue;
    }
    match = /RegisterEffect\((\w+)/.exec(line);
    const draft = match ? drafts.get(match[1]) : undefined;
    const index = draft && /Stringid\(\s*id\s*,\s*(\d+)\)/.exec(draft.description)?.[1];
    if (draft && index !== undefined && !kinds.has(index)) kinds.set(index, kindOf(draft.category));
  }
  return kinds;
}

/** What the engine found the end of a line can do on the opponent's turn (the board audit), beside the count above. */
export interface BoardAudit {
  // the replay reached the saved board; if not, nothing below can be trusted
  trusted: boolean;
  // every effect that can matter on their turn: the card, what it does, its kind, where it was and when. `confirmed`:
  // the engine offered it on this board; otherwise it was read from the script (its condition may not hold)
  effects: { code: number; text: string; kind: Kind; location: number; at: string[]; confirmed?: boolean }[];
  // protection read from the scripts: the card, what it stops, whether the engine saw it hold
  protections?: { code: number; text: string; confirmed: boolean }[];
  // your monsters their targeting couldn't pick, your cards their "destroy" left standing
  untargetable: number[];
  indestructible: number[];
}

// ==== Everything a card's script says it can do on the opponent's turn (read, not played): Quick Effects, Traps,
// triggers that can happen then (destroyed, sent to the GY, their summon), and protection that is always on ====

/** One effect read from a script, for the board audit to list beside what the engine confirmed. */
export interface ScriptEffect {
  // its description (Stringid index) when it has one: the engine names offered effects the same way
  description?: string;
  kind: Kind;
  how: "quick" | "trigger" | "protection";
  // where the card has to be: location bits (2 hand, 4 Monster Zone, 8 Spell & Trap Zone, 16 GY, 32 banished)
  where: number;
  // a trigger: what sets it off, in plain words; protection: what it stops
  when?: string;
  protects?: string;
  // protection given to your other cards too, not only this one
  others?: boolean;
  // it has a condition the script checks on the spot (materials, a card you control): may not hold on this board
  conditional?: boolean;
}

// protection codes, in plain words
const GUARDS: [RegExp, string][] = [
  [/EFFECT_CANNOT_BE_EFFECT_TARGET\b/, "can't be targeted by card effects"],
  [/EFFECT_INDESTRUCTABLE_EFFECT\b/, "can't be destroyed by card effects"],
  [/EFFECT_INDESTRUCTABLE_BATTLE\b/, "can't be destroyed by battle"],
  [/EFFECT_INDESTRUCTABLE_COUNT\b/, "survives being destroyed once"],
  [/EFFECT_DESTROY_REPLACE\b/, "can avoid being destroyed (a replacement effect)"],
  [/EFFECT_IMMUNE_EFFECT\b/, "unaffected by card effects"],
  [/EFFECT_CANNOT_BE_BATTLE_TARGET\b/, "can't be attacked"],
  [/EFFECT_CANNOT_REMOVE\b/, "can't be banished"],
  [/EFFECT_CANNOT_TO_GRAVE\b/, "can't be sent to the GY"],
  [/EFFECT_CANNOT_TO_DECK\b/, "can't be returned to the Deck"],
  [/EFFECT_CANNOT_TO_HAND\b/, "can't be returned to the hand"],
  [/EFFECT_CANNOT_RELEASE\b/, "can't be Tributed"],
  [/EFFECT_CANNOT_INACTIVATE\b|EFFECT_CANNOT_DISEFFECT\b/, "its effects can't be negated"],
];
// triggers that can happen on the opponent's turn, in plain words
const EVENTS: [RegExp, string, boolean?][] = [
  [/EVENT_DESTROYED\b/, "when it's destroyed"],
  [/EVENT_BATTLE_DESTROYED\b/, "when it's destroyed by battle"],
  [/EVENT_TO_GRAVE\b/, "when it's sent to the GY"],
  [/EVENT_LEAVE_FIELD\b/, "when it leaves the field"],
  [/EVENT_REMOVE\b/, "when it's banished"],
  [/EVENT_TO_HAND\b/, "when it's returned to the hand"],
  [/EVENT_BE_BATTLE_TARGET\b|EVENT_ATTACK_ANNOUNCE\b/, "when they attack"],
  // these only count when the effect watches the field (their summon, their activation), not this card's own
  [/EVENT_SPSUMMON_SUCCESS\b|EVENT_SUMMON_SUCCESS\b|EVENT_FLIP_SUMMON_SUCCESS\b/, "when they summon", true],
  [/EVENT_CHAINING\b/, "when they activate a card or effect", true],
  [/EVENT_PHASE\s*\+\s*PHASE_STANDBY\b/, "in the Standby Phase", true],
  [/EVENT_PHASE\s*\+\s*PHASE_END\b/, "in the End Phase", true],
];

/** Every effect a card's script gives it that can matter on the opponent's turn. */
export function readBoardEffects(source: string, cardType: number): ScriptEffect[] {
  type Draft = { type: string; category: string; range: string; code: string; condition: string; description: string; reset: string };
  const drafts = new Map<string, Draft>();
  const registered: Draft[] = [];
  for (const line of source.split("\n")) {
    let match = /local\s+(\w+)\s*=\s*Effect\.CreateEffect/.exec(line);
    if (match) {
      drafts.set(match[1], { type: "", category: "", range: "", code: "", condition: "", description: "", reset: "" });
      continue;
    }
    match = /local\s+(\w+)\s*=\s*(\w+):Clone\(\)/.exec(line);
    if (match && drafts.has(match[2])) {
      drafts.set(match[1], { ...drafts.get(match[2])! });
      continue;
    }
    match = /(\w+):Set(Type|Category|Range|Code|Condition|Description|Reset)\((.*)\)\s*$/.exec(line.trim());
    if (match && drafts.has(match[1])) {
      drafts.get(match[1])![match[2].toLowerCase() as keyof Draft] = match[3];
      continue;
    }
    match = /RegisterEffect\((\w+)/.exec(line);
    if (match && drafts.has(match[1])) registered.push({ ...drafts.get(match[1])! });
  }
  const isTrap = (cardType & 4) !== 0;
  const isQuickPlay = (cardType & 2) !== 0 && (cardType & 0x10000) !== 0;
  const out: ScriptEffect[] = [];
  for (const draft of registered) {
    const description = /Stringid\(\s*id\s*,\s*(\d+)\)/.exec(draft.description)?.[1];
    let where = 0;
    for (const [name, bits] of Object.entries(LOCATIONS)) if (draft.range.includes(name)) where |= bits;
    const conditional = !!draft.condition;
    // always-on protection: no activation, nothing that wears off
    const guard = GUARDS.find(([code]) => code.test(draft.code));
    if (guard && !/EFFECT_TYPE_(ACTIVATE|QUICK|TRIGGER|IGNITION)/.test(draft.type) && !draft.reset) {
      out.push({ description, kind: "other", how: "protection", where: where || 4 | 8, protects: guard[1], others: /EFFECT_TYPE_FIELD/.test(draft.type), conditional });
      continue;
    }
    const quick = /EFFECT_TYPE_QUICK_[OF]/.test(draft.type) || (/EFFECT_TYPE_ACTIVATE/.test(draft.type) && (isTrap || isQuickPlay));
    if (quick) {
      if (BATTLE.test(draft.code)) continue;
      if (/EFFECT_TYPE_ACTIVATE/.test(draft.type)) where |= 8;
      if (!where) continue;
      out.push({ description, kind: kindOf(draft.category), how: "quick", where, conditional });
      continue;
    }
    if (/EFFECT_TYPE_TRIGGER_[OF]/.test(draft.type)) {
      const event = EVENTS.find(([code]) => code.test(draft.code));
      if (!event) continue;
      // "when they summon": an effect watching the field (FIELD type), not this card's own summon (SINGLE)
      if (event[2] && /EFFECT_TYPE_SINGLE/.test(draft.type)) continue;
      // a card's own leaving: it's on the field until then
      out.push({ description, kind: kindOf(draft.category), how: "trigger", where: where || 4 | 8, when: event[1], conditional });
    }
  }
  return out;
}
