/// <reference lib="webworker" />
// The duel runs here, off the page's thread, on the same core EDOPro uses
// (ocgcore) with the Project Ignis card database and scripts.

import createCore, {
  OcgDuelMode,
  OcgLocation,
  OcgMessageType,
  OcgOpCode,
  OcgPosition,
  OcgProcessResult,
  OcgQueryFlags,
  OcgResponseType,
  SelectBattleCMDAction,
  SelectIdleCMDAction,
  type OcgCardData,
  type OcgCoreSync,
  type OcgDuelHandle,
  type OcgMessage,
  type OcgResponse,
} from "ocgcore-wasm";
import coreWasmUrl from "ocgcore-wasm/lib/ocgcore.sync.wasm?url";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { CardRef, CardView, Choice, DuelEvent, DuelView, FromWorker, PlayerView, Prompt, StartOptions, ToWorker } from "./protocol";

// Folder holding cards.cdb and the release / pre-release databases, and a listing of that folder.
const CDB_URL = import.meta.env.VITE_CDB_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/BabelCDB/master";
const CDB_LIST_URL = import.meta.env.VITE_CDB_LIST_URL ?? "https://api.github.com/repos/ProjectIgnis/BabelCDB/contents/";
const SCRIPTS_URL = import.meta.env.VITE_SCRIPTS_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/CardScripts/master";
const STRINGS_URL = import.meta.env.VITE_STRINGS_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/Distribution/master/config/strings.conf";

const send = (message: FromWorker) => postMessage(message);

let core: OcgCoreSync;
const cards = new Map<number, OcgCardData>();
const names = new Map<number, string>();
const texts = new Map<number, string>();
const cardStrings = new Map<number, string[]>(); // effect descriptions, str1..str16
const systemStrings = new Map<number, string>();
const scripts = new Map<string, string | null>();

// cards.cdb first, then every newer set: release-*.cdb and prerelease-*.cdb (no Rush, Skill or unofficial cards).
async function databaseFiles(): Promise<string[]> {
  const files = ["cards.cdb"];
  try {
    const listing = (await (await fetch(CDB_LIST_URL)).json()) as { name: string }[];
    for (const { name } of listing) {
      if (/^(release|prerelease)-.*\.cdb$/.test(name) && !/rush|skill|unofficial/.test(name)) files.push(name);
    }
  } catch {
    // offline or rate limited: the main database alone still covers almost every deck
  }
  return files;
}

async function loadCards() {
  send({ type: "progress", text: "Loading card database" });
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  const files = await databaseFiles();
  const buffers = await Promise.all(files.map(async (file) => {
    const response = await fetch(`${CDB_URL}/${file}`);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }));
  for (const buffer of buffers) {
    if (!buffer) continue;
    const db = new SQL.Database(buffer);
    // sql.js returns numbers; setcode and race need all 64 bits, so read them as text
    const rows = db.exec(
      "select d.id,d.alias,cast(d.setcode as text),d.type,d.level,d.attribute,cast(d.race as text),d.atk,d.def,t.name,t.desc," +
        "t.str1,t.str2,t.str3,t.str4,t.str5,t.str6,t.str7,t.str8,t.str9,t.str10,t.str11,t.str12,t.str13,t.str14,t.str15,t.str16 " +
        "from datas d join texts t on t.id=d.id",
    );
    for (const row of rows[0]?.values ?? []) {
      const [id, alias, setcode, type, level, attribute, race, atk, def, name, desc] = row as [number, number, string, number, number, number, string, number, number, string, string];
      if (cards.has(id)) continue;
      const set = BigInt.asUintN(64, BigInt(setcode));
      const setcodes: number[] = [];
      for (let i = 0n; i < 4n; i++) {
        const code = Number((set >> (16n * i)) & 0xffffn);
        if (code) setcodes.push(code);
      }
      const isLink = (type & 0x4000000) !== 0;
      cards.set(id, {
        code: id,
        alias,
        setcodes,
        type,
        level: level & 0xff,
        attribute,
        race: BigInt.asUintN(64, BigInt(race)),
        attack: atk,
        defense: isLink ? 0 : def,
        lscale: (level >> 24) & 0xff,
        rscale: (level >> 16) & 0xff,
        link_marker: isLink ? def : 0,
      });
      names.set(id, name);
      texts.set(id, desc ?? "");
      const strings = row.slice(11) as (string | null)[];
      if (strings.some(Boolean)) cardStrings.set(id, strings.map((text) => text ?? ""));
    }
    db.close();
  }
  // EDOPro's own wording for system prompts
  try {
    const conf = await (await fetch(STRINGS_URL)).text();
    for (const line of conf.split(/\r?\n/)) {
      const match = /^!system (\d+) (.*)$/.exec(line);
      if (match) systemStrings.set(Number(match[1]), match[2]);
    }
  } catch {
    // prompts fall back to plain labels
  }
}

// Other simulators (YGO Omega) number alternate artworks themselves, a few above the real passcode.
// A code the database does not know is read as the closest real card just below it.
function knownCode(code: number): number {
  if (cards.has(code)) return code;
  for (let offset = 1; offset < 10; offset++) {
    const card = cards.get(code - offset);
    if (card) return card.alias && cards.has(card.alias) ? card.alias : code - offset;
  }
  return code;
}

// The core asks for scripts synchronously, which a worker can do with a blocking request.
// null: the file does not exist (404). undefined: the download failed, so it is tried again next time.
function fetchText(url: string): string | null | undefined {
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = new XMLHttpRequest();
    request.open("GET", url, false);
    try {
      request.send();
    } catch {
      continue;
    }
    if (request.status === 200) return request.responseText;
    if (request.status === 404) return null;
  }
  return undefined;
}

async function fetchTextAsync(url: string): Promise<string | null | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      if (response.status === 404) return null;
    } catch {
      // network hiccup: try again
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  return undefined;
}

const scriptFolders = (name: string) => (/^c\d+\.lua$/.test(name) ? ["official", "pre-release", "unofficial"] : [""]);
const scriptUrl = (folder: string, name: string) => `${SCRIPTS_URL}/${folder ? folder + "/" : ""}${name}`;

function readScript(path: string): string | null {
  const name = path.split("/").pop()!;
  if (scripts.has(name)) return scripts.get(name)!;
  let source: string | null = null;
  let failed = false;
  for (const folder of scriptFolders(name)) {
    const text = fetchText(scriptUrl(folder, name));
    if (text === undefined) failed = true;
    else if (text !== null) {
      source = text;
      break;
    }
  }
  // alternate artworks share the script of the card they are an artwork of
  if (source === null && name.startsWith("c")) {
    const alias = cards.get(Number(name.slice(1, -4)))?.alias;
    if (alias) source = readScript(`c${alias}.lua`);
  }
  if (source !== null || !failed) scripts.set(name, source);
  return source;
}

// Downloads every script a deck needs at once, before the duel, instead of one by one as the core asks.
// Returns the cards whose script could not be downloaded.
async function prefetchScripts(codes: number[]): Promise<number[]> {
  const missing: number[] = [];
  const one = async (code: number): Promise<boolean> => {
    const name = `c${code}.lua`;
    if (scripts.has(name)) return true;
    for (const folder of scriptFolders(name)) {
      const text = await fetchTextAsync(scriptUrl(folder, name));
      if (text === undefined) return false;
      if (text !== null) {
        scripts.set(name, text);
        return true;
      }
    }
    const alias = cards.get(code)?.alias;
    if (alias) return one(alias);
    // a card without a script (a Normal Monster) is fine
    scripts.set(name, null);
    return true;
  };
  const unique = [...new Set(codes)];
  // a few at a time, so a phone on mobile data is not flooded
  for (let i = 0; i < unique.length; i += 12) {
    const batch = unique.slice(i, i + 12);
    const results = await Promise.all(batch.map(one));
    results.forEach((ok, index) => ok || missing.push(batch[index]));
  }
  return missing;
}

// ---------------------------------------------------------------------------
// The running duel

const PHASES: Record<number, string> = { 1: "Draw", 2: "Standby", 4: "Main 1", 8: "Battle", 16: "Battle", 32: "Damage", 64: "Damage", 128: "Battle", 256: "Main 2", 512: "End" };
// What the core is asked about each card. Never TYPE: ocgcore-wasm's reader does not handle that field and does not
// skip it, so everything after it comes back shifted. The card's type is read from the database instead.
const QUERY = (OcgQueryFlags.CODE | OcgQueryFlags.POSITION | OcgQueryFlags.LEVEL | OcgQueryFlags.RANK | OcgQueryFlags.ATTACK | OcgQueryFlags.DEFENSE | OcgQueryFlags.LINK) as OcgQueryFlags;

let duel: OcgDuelHandle | null = null;
let lp = [8000, 8000];
let turn = 0;
let turnPlayer = 0;
let phase = "";
let ended = false;
let prompt: Prompt | null = null;
let events: DuelEvent[] = [];
// cards in the current chain, link 1 first
let chain: (CardRef & { code: number })[] = [];
// turns the player's picks into the core's response for the prompt on screen
let respond: ((picks: number[] | null) => OcgResponse | null) | null = null;

const nameOf = (code: number) => names.get(code) ?? (code ? `#${code}` : "");

// An effect description is either "card code * 16 + string number" or a system string.
function describe(description: bigint): string {
  const value = Number(description);
  if (value < 10000) return systemStrings.get(value) ?? "";
  return cardStrings.get(Math.floor(value / 16))?.[value % 16] ?? "";
}

// system strings leave the card name and its place as %ls, filled in order
function fill(text: string, ...values: string[]): string {
  let next = 0;
  return text.replace(/%ls/g, () => values[next++] ?? "");
}

function placeName(location: number): string {
  if (location & OcgLocation.OVERLAY) return "Xyz Material";
  const names: Record<number, string> = {
    [OcgLocation.DECK]: "Deck",
    [OcgLocation.HAND]: "Hand",
    [OcgLocation.MZONE]: "Monster Zone",
    [OcgLocation.SZONE]: "Spell & Trap Zone",
    [OcgLocation.GRAVE]: "GY",
    [OcgLocation.REMOVED]: "Banished",
    [OcgLocation.EXTRA]: "Extra Deck",
  };
  return names[location] ?? "Field";
}

function system(id: number, fallback: string): string {
  return systemStrings.get(id) ?? fallback;
}

function cardChoice(label: string, card: { code: number; controller: number; location: number; sequence: number }): Choice {
  return { label, card: { controller: card.controller, location: card.location, sequence: card.sequence, code: card.code, name: nameOf(card.code), type: cards.get(card.code)?.type ?? 0 } };
}

function zoneName(zone: CardRef): string {
  if (zone.location === OcgLocation.MZONE) return zone.sequence > 4 ? "Extra Monster Zone" : `Monster Zone ${zone.sequence + 1}`;
  if (zone.sequence === 5) return "Field Zone";
  return zone.sequence > 5 ? "Pendulum Zone" : `Spell & Trap Zone ${zone.sequence + 1}`;
}

// field_mask has a bit set for every zone that is NOT available
function freeZones(player: number, mask: number): Choice[] {
  const zones: Choice[] = [];
  for (let side = 0; side < 2; side++) {
    const bits = (mask >>> (side * 16)) & 0xffff;
    const controller = side === 0 ? player : 1 - player;
    for (let sequence = 0; sequence < 7; sequence++) {
      if (!(bits & (1 << sequence))) zones.push({ label: "", zone: { controller, location: OcgLocation.MZONE, sequence } });
    }
    for (let sequence = 0; sequence < 8; sequence++) {
      if (!(bits & (0x100 << sequence))) zones.push({ label: "", zone: { controller, location: OcgLocation.SZONE, sequence } });
    }
  }
  for (const zone of zones) zone.label = `${zone.zone!.controller === player ? "" : "Opponent's "}${zoneName(zone.zone!)}`;
  return zones;
}

const TYPE_TOKEN = 0x4000;
// Which card names may be declared: the core sends a small stack program, evaluated per card
// the way EDOPro's client does it (types, races and attributes match on any shared bit).
function declarable(card: OcgCardData, opcodes: bigint[]): boolean {
  const stack: bigint[] = [];
  let aliases = false;
  let tokens = false;
  const pop = () => stack.pop() ?? 0n;
  const two = (op: (a: bigint, b: bigint) => bigint) => {
    const b = pop();
    const a = pop();
    stack.push(op(a, b));
  };
  const flag = (value: boolean) => (value ? 1n : 0n);
  for (const opcode of opcodes) {
    switch (opcode) {
      case OcgOpCode.ADD: two((a, b) => a + b); break;
      case OcgOpCode.SUB: two((a, b) => a - b); break;
      case OcgOpCode.MUL: two((a, b) => a * b); break;
      case OcgOpCode.DIV: two((a, b) => (b === 0n ? 0n : a / b)); break;
      case OcgOpCode.AND: two((a, b) => flag(a !== 0n && b !== 0n)); break;
      case OcgOpCode.OR: two((a, b) => flag(a !== 0n || b !== 0n)); break;
      case OcgOpCode.NEG: stack.push(-pop()); break;
      case OcgOpCode.NOT: stack.push(flag(pop() === 0n)); break;
      case OcgOpCode.BAND: two((a, b) => a & b); break;
      case OcgOpCode.BOR: two((a, b) => a | b); break;
      case OcgOpCode.BNOT: stack.push(~pop()); break;
      case OcgOpCode.BXOR: two((a, b) => a ^ b); break;
      case OcgOpCode.LSHIFT: two((a, b) => a << b); break;
      case OcgOpCode.RSHIFT: two((a, b) => a >> b); break;
      case OcgOpCode.ALLOW_ALIASES: aliases = true; break;
      case OcgOpCode.ALLOW_TOKENS: tokens = true; break;
      case OcgOpCode.ISCODE: stack.push(flag(BigInt(card.code) === pop())); break;
      case OcgOpCode.ISSETCARD: {
        const set = Number(pop());
        stack.push(flag(card.setcodes.some((code) => (code & 0xfff) === (set & 0xfff) && (code & set) === set)));
        break;
      }
      case OcgOpCode.ISTYPE: stack.push(flag((BigInt(card.type) & pop()) !== 0n)); break;
      case OcgOpCode.ISRACE: stack.push(flag((BigInt(card.race) & pop()) !== 0n)); break;
      case OcgOpCode.ISATTRIBUTE: stack.push(flag((BigInt(card.attribute) & pop()) !== 0n)); break;
      case OcgOpCode.GETCODE: stack.push(BigInt(card.code)); break;
      case OcgOpCode.GETTYPE: stack.push(BigInt(card.type)); break;
      case OcgOpCode.GETRACE: stack.push(BigInt(card.race)); break;
      case OcgOpCode.GETATTRIBUTE: stack.push(BigInt(card.attribute)); break;
      default: stack.push(opcode);
    }
  }
  if (stack.length !== 1 || stack[0] === 0n) return false;
  // alternate artworks are the same name; tokens are not cards
  if (!aliases && card.alias && Math.abs(card.alias - card.code) < 20) return false;
  if (!tokens && card.type & TYPE_TOKEN) return false;
  return true;
}

// Builds what the player sees for a core prompt. Returns false when the prompt needs no player (answered here).
function buildPrompt(message: OcgMessage): boolean {
  const answer = (response: OcgResponse) => {
    core.duelSetResponse(duel!, response);
    return false;
  };
  const one = (title: string, choices: Choice[], cancel: string | null, make: (index: number | null) => OcgResponse, idle = false) => {
    prompt = { kind: "choice", idle, title, choices, cancel };
    respond = (picks) => (picks === null ? (cancel === null ? null : make(null)) : make(picks[0]));
    return true;
  };
  switch (message.type) {
    case OcgMessageType.SELECT_IDLECMD: {
      // nobody is sitting on the other side yet: its turn ends at once
      if (message.player !== 0) return answer({ type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null });
      const choices: Choice[] = [];
      const actions: [SelectIdleCMDAction, number | null][] = [];
      const add = (label: string, action: SelectIdleCMDAction, list: { code: number; controller: number; location: number; sequence: number }[]) =>
        list.forEach((card, index) => {
          choices.push(cardChoice(label, card));
          actions.push([action, index]);
        });
      add(system(1151, "Normal Summon"), SelectIdleCMDAction.SELECT_SUMMON, message.summons);
      add(system(1152, "Special Summon"), SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, message.special_summons);
      add(system(1155, "Change position"), SelectIdleCMDAction.SELECT_POS_CHANGE, message.pos_changes);
      add(system(1153, "Set"), SelectIdleCMDAction.SELECT_MONSTER_SET, message.monster_sets);
      add(system(1153, "Set"), SelectIdleCMDAction.SELECT_SPELL_SET, message.spell_sets);
      message.activates.forEach((card, index) => {
        const text = describe(card.description);
        choices.push(cardChoice(text ? `${system(1150, "Activate")}: ${text}` : system(1150, "Activate"), card));
        actions.push([SelectIdleCMDAction.SELECT_ACTIVATE, index]);
      });
      if (message.to_bp) {
        choices.push({ label: "Battle Phase", phase: true });
        actions.push([SelectIdleCMDAction.TO_BP, null]);
      }
      if (message.to_ep) {
        choices.push({ label: "End Turn", phase: true });
        actions.push([SelectIdleCMDAction.TO_EP, null]);
      }
      return one("", choices, null, (index) => ({ type: OcgResponseType.SELECT_IDLECMD, action: actions[index!][0], index: actions[index!][1] }), true);
    }
    case OcgMessageType.SELECT_BATTLECMD: {
      if (message.player !== 0) return answer({ type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_EP, index: null });
      const choices: Choice[] = [];
      const actions: [SelectBattleCMDAction, number | null][] = [];
      message.attacks.forEach((card, index) => {
        choices.push(cardChoice(system(1157, "Attack"), card));
        actions.push([SelectBattleCMDAction.SELECT_BATTLE, index]);
      });
      message.chains.forEach((card, index) => {
        const text = describe(card.description);
        choices.push(cardChoice(text ? `${system(1150, "Activate")}: ${text}` : system(1150, "Activate"), card));
        actions.push([SelectBattleCMDAction.SELECT_CHAIN, index]);
      });
      if (message.to_m2) {
        choices.push({ label: "Main Phase 2", phase: true });
        actions.push([SelectBattleCMDAction.TO_M2, null]);
      }
      if (message.to_ep) {
        choices.push({ label: "End Turn", phase: true });
        actions.push([SelectBattleCMDAction.TO_EP, null]);
      }
      return one("", choices, null, (index) => ({ type: OcgResponseType.SELECT_BATTLECMD, action: actions[index!][0], index: actions[index!][1] }), true);
    }
    case OcgMessageType.SELECT_EFFECTYN: {
      // EDOPro's own wording, e.g. 'Activate the Trigger Effect of "%ls" from [%ls]?', with the blanks filled in
      const text = fill(describe(message.description), nameOf(message.code), placeName(message.location));
      return one(text || `Activate the effect of "${nameOf(message.code)}"?`, [{ label: "Yes" }, { label: "No" }], null, (index) => ({ type: OcgResponseType.SELECT_EFFECTYN, yes: index === 0 }));
    }
    case OcgMessageType.SELECT_YESNO:
      return one(describe(message.description) || "Confirm?", [{ label: "Yes" }, { label: "No" }], null, (index) => ({ type: OcgResponseType.SELECT_YESNO, yes: index === 0 }));
    case OcgMessageType.SELECT_OPTION:
      return one(
        "Select an option",
        message.options.map((option, index) => ({ label: describe(option) || `Option ${index + 1}` })),
        null,
        (index) => ({ type: OcgResponseType.SELECT_OPTION, index: index! }),
      );
    case OcgMessageType.SELECT_CHAIN: {
      if (message.selects.length === 0) return answer({ type: OcgResponseType.SELECT_CHAIN, index: null });
      // the side with nobody on it never chains
      if (message.player !== 0) return answer({ type: OcgResponseType.SELECT_CHAIN, index: message.forced ? 0 : null });
      return one(
        "Chain an effect?",
        message.selects.map((card) => {
          const text = describe(card.description);
          return cardChoice(text ? `${nameOf(card.code)}: ${text}` : nameOf(card.code), card);
        }),
        message.forced ? null : "Don't chain",
        (index) => ({ type: OcgResponseType.SELECT_CHAIN, index }),
      );
    }
    case OcgMessageType.SELECT_CARD:
    case OcgMessageType.SELECT_TRIBUTE: {
      const tribute = message.type === OcgMessageType.SELECT_TRIBUTE;
      const cancel = message.can_cancel;
      prompt = {
        kind: "multi",
        title: tribute ? "Select the monsters to Tribute" : "Select",
        choices: message.selects.map((card) => cardChoice(nameOf(card.code), card)),
        min: message.min,
        max: message.max,
        cancel,
      };
      respond = (picks) => {
        if (picks === null && !cancel) return null;
        return tribute ? { type: OcgResponseType.SELECT_TRIBUTE, indicies: picks } : { type: OcgResponseType.SELECT_CARD, indicies: picks };
      };
      return true;
    }
    case OcgMessageType.SELECT_UNSELECT_CARD: {
      const finish = message.can_finish || message.can_cancel;
      // the response index runs over the cards that can be picked, then the ones already picked
      const choices = [
        ...message.select_cards.map((card) => ({ ...cardChoice(nameOf(card.code), card), pick: true })),
        ...message.unselect_cards.map((card) => ({ ...cardChoice(nameOf(card.code), card), pick: true, picked: true })),
      ];
      const count = message.min === message.max ? `${message.min}` : `${message.min}-${message.max}`;
      return one(
        `Select ${count}`,
        choices,
        finish ? (message.can_finish ? "Done" : "Cancel") : null,
        (index) => ({ type: OcgResponseType.SELECT_UNSELECT_CARD, index }),
      );
    }
    case OcgMessageType.SELECT_PLACE:
    case OcgMessageType.SELECT_DISFIELD: {
      const zones = freeZones(message.player, message.field_mask);
      const count = Math.max(1, message.count);
      const type = message.type === OcgMessageType.SELECT_PLACE ? OcgResponseType.SELECT_PLACE : OcgResponseType.SELECT_DISFIELD;
      prompt = { kind: "multi", title: "Select a zone", choices: zones, min: count, max: count, cancel: false };
      respond = (picks) =>
        picks && {
          type,
          places: picks.map((pick) => ({ player: zones[pick].zone!.controller, location: zones[pick].zone!.location, sequence: zones[pick].zone!.sequence })),
        } as OcgResponse;
      return true;
    }
    case OcgMessageType.SELECT_POSITION: {
      const all: [number, string][] = [
        [OcgPosition.FACEUP_ATTACK, "Attack Position"],
        [OcgPosition.FACEUP_DEFENSE, "Defense Position"],
        [OcgPosition.FACEDOWN_DEFENSE, "Set (face-down Defense)"],
        [OcgPosition.FACEDOWN_ATTACK, "Face-down Attack"],
      ];
      const allowed = all.filter(([position]) => message.positions & position);
      return one(
        `Select the battle position of "${nameOf(message.code)}"`,
        allowed.map(([, label]) => ({ label })),
        null,
        (index) => ({ type: OcgResponseType.SELECT_POSITION, position: allowed[index!][0] as OcgPosition }),
      );
    }
    case OcgMessageType.ANNOUNCE_NUMBER:
      return one(
        "Declare a number",
        message.options.map((option) => ({ label: String(option) })),
        null,
        (index) => ({ type: OcgResponseType.ANNOUNCE_NUMBER, value: index! }) as OcgResponse,
      );
    case OcgMessageType.ANNOUNCE_CARD: {
      const opcodes = message.opcodes.map((opcode) => BigInt(opcode));
      const options = [...cards.values()]
        .filter((card) => declarable(card, opcodes))
        .map((card) => ({ code: card.code, name: nameOf(card.code) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      prompt = { kind: "announce", title: "Declare a card name", choices: [], options };
      respond = (picks) => (picks && options[picks[0]] ? { type: OcgResponseType.ANNOUNCE_CARD, card: options[picks[0]].code } : null);
      return true;
    }
    case OcgMessageType.SORT_CARD:
    case OcgMessageType.SORT_CHAIN:
      return answer({ type: OcgResponseType.SORT_CARD, order: null });
    default:
      send({ type: "error", text: `This prompt is not supported yet: ${OcgMessageType[message.type]}` });
      prompt = null;
      respond = null;
      return true;
  }
}

function cardsIn(controller: 0 | 1, location: OcgLocation, hidden = false): (CardView | null)[] {
  return core.duelQueryLocation(duel!, { flags: QUERY, controller, location }).map((info, sequence) => {
    if (!info) return null;
    const position = info.position ?? OcgPosition.FACEDOWN_DEFENSE;
    const secret = hidden || (controller === 1 && (position & (OcgPosition.FACEDOWN_ATTACK | OcgPosition.FACEDOWN_DEFENSE)) !== 0 && location !== OcgLocation.GRAVE);
    const code = secret ? 0 : (info.code ?? 0);
    const type = cards.get(code)?.type ?? 0;
    // Level, Rank and Link rating as they are now, after effects that change them
    const level = !code ? 0 : type & 0x4000000 ? (info.link?.rating ?? 0) : type & 0x800000 ? (info.rank ?? 0) : (info.level ?? cards.get(code)?.level ?? 0);
    return {
      controller,
      location,
      sequence,
      code,
      name: nameOf(code),
      type,
      attack: info.attack ?? 0,
      defense: info.defense ?? 0,
      level,
      position,
      materials: 0,
    };
  });
}

function playerView(controller: 0 | 1, deck: number): PlayerView {
  const present = (list: (CardView | null)[]) => list.filter((card): card is CardView => card !== null);
  return {
    lp: lp[controller],
    deck,
    hand: present(cardsIn(controller, OcgLocation.HAND, controller === 1)),
    monsters: cardsIn(controller, OcgLocation.MZONE),
    spells: cardsIn(controller, OcgLocation.SZONE),
    grave: present(cardsIn(controller, OcgLocation.GRAVE)),
    banished: present(cardsIn(controller, OcgLocation.REMOVED)),
    extra: present(cardsIn(controller, OcgLocation.EXTRA, controller === 1)),
  };
}

function sendView() {
  const field = core.duelQueryField(duel!);
  const players: [PlayerView, PlayerView] = [playerView(0, field.players[0].deck_size), playerView(1, field.players[1].deck_size)];
  for (const controller of [0, 1]) {
    field.players[controller].monsters.forEach((zone, sequence) => {
      const card = players[controller].monsters[sequence];
      if (card && zone) card.materials = zone.materials;
    });
  }
  const view: DuelView = { events, turn, turnPlayer, phase, players, prompt, ended };
  events = [];
  send({ type: "view", view });
}

const isPrompt = (type: number) => (type >= 10 && type <= 26 && type !== 17) || type === 132 || (type >= 140 && type <= 143);

// Runs the core until it needs the player, then shows the result. Summons, activations and resolutions
// are sent as they happen, so the page can show each one before the duel moves on.
function advance() {
  prompt = null;
  respond = null;
  for (let guard = 0; guard < 5000 && !prompt && !ended; guard++) {
    const status = core.duelProcess(duel!);
    for (const message of core.duelGetMessage(duel!)) {
      switch (message.type) {
        case OcgMessageType.NEW_TURN:
          turn++;
          turnPlayer = message.player;
          break;
        case OcgMessageType.NEW_PHASE:
          phase = PHASES[message.phase] ?? "";
          break;
        case OcgMessageType.DAMAGE:
        case OcgMessageType.PAY_LPCOST:
          lp[message.player] = Math.max(0, lp[message.player] - message.amount);
          break;
        case OcgMessageType.RECOVER:
          lp[message.player] += message.amount;
          break;
        case OcgMessageType.LPUPDATE:
          lp[message.player] = message.lp;
          break;
        case OcgMessageType.SUMMONING:
        case OcgMessageType.SPSUMMONING:
        case OcgMessageType.FLIPSUMMONING:
          events.push({ kind: "summon", code: message.code, name: nameOf(message.code), controller: message.controller, location: message.location, sequence: message.sequence });
          break;
        case OcgMessageType.CHAINING: {
          const ref = { controller: message.controller, location: message.location, sequence: message.sequence };
          chain[message.chain_size - 1] = { ...ref, code: message.code };
          events.push({ kind: "activate", code: message.code, name: nameOf(message.code), ...ref, chain: message.chain_size, text: describe(message.description) });
          break;
        }
        case OcgMessageType.CHAIN_SOLVING: {
          // a hand trap has already gone to the GY as its cost; the card is still named from its activation
          const link = chain[message.chain_size - 1];
          if (link) events.push({ kind: "resolve", ...link, name: nameOf(link.code), chain: message.chain_size });
          break;
        }
        case OcgMessageType.CHAIN_END:
          chain = [];
          break;
        case OcgMessageType.MOVE:
          // a card found in the deck and added to the player's hand (searches)
          if (message.from.location === OcgLocation.DECK && message.to.location === OcgLocation.HAND && message.to.controller === 0 && message.card)
            events.push({ kind: "added", code: message.card, name: nameOf(message.card), controller: 0, location: OcgLocation.HAND, sequence: message.to.sequence });
          break;
        case OcgMessageType.RETRY:
          send({ type: "error", text: "The duel core did not accept that choice." });
          break;
        default:
          if (isPrompt(message.type) && buildPrompt(message) && !prompt) ended = true;
      }
    }
    if (status === OcgProcessResult.END) ended = true;
    // show this moment before anything else happens
    if (events.length && !prompt) sendView();
  }
  sendView();
}

async function start(options: StartOptions) {
  const missing = await prefetchScripts([...options.main, ...options.extra].map(knownCode));
  if (missing.length)
    send({ type: "error", text: `Could not download the card scripts for ${missing.map(nameOf).join(", ")}. Check the connection and tap New hand.` });
  if (duel) core.destroyDuel(duel);
  lp = [8000, 8000];
  turn = 0;
  turnPlayer = 0;
  phase = "";
  ended = false;
  events = [];
  chain = [];
  duel = core.createDuel({
    // the page shuffles the deck itself, so the cards asked for can be put on top
    flags: OcgDuelMode.MODE_MR5 | OcgDuelMode.PSEUDO_SHUFFLE,
    seed: [BigInt(options.seed), 2n, 3n, 4n],
    team1: { drawCountPerTurn: 1, startingDrawCount: options.hand, startingLP: 8000 },
    team2: { drawCountPerTurn: 1, startingDrawCount: 0, startingLP: 8000 },
    cardReader: (code) => cards.get(code) ?? null,
    scriptReader: (name) => readScript(name) ?? "",
    errorHandler: (_type, text) => {
      if (!/not found/.test(text)) send({ type: "error", text: `Card script error: ${text}` });
    },
  });
  if (!duel) throw new Error("The duel could not be created");
  const handle = duel;
  for (const file of ["constant.lua", "utility.lua"]) core.loadScript(handle, file, readScript(file) ?? "");
  const add = (code: number, location: OcgLocation) =>
    core.duelNewCard(handle, { team: 0, duelist: 0, code, controller: 0, location, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
  // chosen cards move to the top of the deck, in order; the last card added ends up on top
  const main = [...options.main];
  let placed = 0;
  for (const wanted of options.chosen) {
    const at = main.indexOf(wanted, placed);
    if (at < 0) continue;
    main.splice(placed, 0, ...main.splice(at, 1));
    placed++;
  }
  for (const code of [...main].reverse()) add(knownCode(code), OcgLocation.DECK);
  for (const code of options.extra) add(knownCode(code), OcgLocation.EXTRA);
  core.startDuel(handle);
  advance();
}

function cardLine(code: number): string {
  const card = cards.get(code);
  if (!card) return "";
  if (card.type & 2) return "Spell";
  if (card.type & 4) return "Trap";
  const link = (card.type & 0x4000000) !== 0;
  const kind = card.type & 0x800000 ? "Rank" : link ? "Link" : "Level";
  return `${kind} ${card.level}  ·  ATK ${card.attack < 0 ? "?" : card.attack}${link ? "" : ` / DEF ${card.defense < 0 ? "?" : card.defense}`}`;
}

onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      await loadCards();
      send({ type: "progress", text: "Starting duel engine" });
      const wasmBinary = await (await fetch(coreWasmUrl)).arrayBuffer();
      core = await createCore({ sync: true, wasmBinary });
      send({ type: "ready", cards: cards.size });
    } else if (message.type === "start") {
      await start(message);
    } else if (message.type === "answer") {
      const response = duel && respond ? respond(message.picks) : null;
      if (response) {
        core.duelSetResponse(duel!, response);
        advance();
      }
    } else if (message.type === "text") {
      send({ type: "text", card: { code: message.code, name: nameOf(message.code), line: cardLine(message.code), text: texts.get(message.code) ?? "" } });
    }
  } catch (error) {
    send({ type: "error", text: error instanceof Error ? error.message : String(error) });
  }
};
