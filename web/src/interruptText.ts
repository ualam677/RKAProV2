// How an interruption is put into words: what kind of negate it is, and the card it brings out if it is a rank-up.
import type { Interruption, NibiruCheck, Protection } from "./engine/interruptions";

const NEGATES = { monster: "monster negate", spell: "Spell negate", trap: "Trap negate", "spell/trap": "Spell/Trap negate", board: "board negate", any: "omni-negate" } as const;
const SHORT = { monster: "MON NEG", spell: "SPELL NEG", trap: "TRAP NEG", "spell/trap": "S/T NEG", board: "BOARD NEG", any: "OMNI NEG" } as const;
const WHERE = { field: "", set: "Set it", hand: "from the hand", gy: "in the GY" } as const;

/** "monster negate", "omni-negate", "removal" */
export const whatItDoes = (one: Interruption) => (one.kind === "removal" ? "removal" : one.scope ? NEGATES[one.scope] : "negate");
/** On a small card: "MON NEG", "OMNI NEG", "REMOVE" */
export const shortWhat = (one: Interruption) => (one.kind === "removal" ? "REMOVE" : one.scope ? SHORT[one.scope] : "NEGATE");
/** "Eternal Galaxy → Number 90: Galaxy-Eyes Photon Lord (monster negate, Set it)" */
export const describeInterruption = (one: Interruption, nameOf: (code: number) => string) =>
  `${nameOf(one.code)}${one.via ? ` → ${nameOf(one.via)}` : ""} (${[whatItDoes(one), WHERE[one.from]].filter(Boolean).join(", ")})`;
/** "Galaxy-Eyes Cipher X Dragon: your opponent cannot target LIGHT monsters you control ..." */
export const describeProtection = (one: Protection, nameOf: (code: number) => string) => `${nameOf(one.code)}: ${one.text || "protects your cards on their turn"}`;
/** "Nibiru-proof: Number 90 ready by your 5th summon", "Not Nibiru-proof ...", "4 summons: Nibiru can't be used" */
export const describeNibiru = (check: NibiruCheck, nameOf: (code: number) => string) =>
  check.summons < 5
    ? `Nibiru-proof: only ${check.summons} summon${check.summons === 1 ? "" : "s"}, so Nibiru can't be used`
    : check.proof
      ? `Nibiru-proof: ${check.by ? nameOf(check.by) : "a negate"} ready by your 5th summon`
      : "Not Nibiru-proof: no monster negate or omni-negate ready by your 5th summon";
