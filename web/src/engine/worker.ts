/// <reference lib="webworker" />
// The duel runs here, off the page's thread, on the same core EDOPro uses
// (ocgcore) with the Project Ignis card database and scripts.

import createCore, {
  OcgDuelMode,
  OcgHintType,
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
import { CHOKE_TRAPS, autoAnswer, chokeCombo, chokePoints, isFollow, isNeed, isProbes, play, playAgainst, probe, probeDeck, routeSearch, type CardEvidence } from "./probe";
import type { FromHelper, ToHelper } from "./helper";
import { isHandTrap } from "./handtraps";
import { interruptionsOf, nibiruStopper, readEffects, readSetConstants, type NibiruCheck, type Protection, type QuickEffect } from "./interruptions";
import { isFirstTurnHandTrap } from "./handtraps";
import type { CardInfo, CardRef, CardSearch, CardView, Choice, DuelEvent, DuelView, FromWorker, PlayerView, Prompt, StartOptions, TestRecord, ToWorker } from "./protocol";

// Folder holding cards.cdb and the release / pre-release databases, and a listing of that folder.
const CDB_URL = import.meta.env.VITE_CDB_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/BabelCDB/master";
const CDB_LIST_URL = import.meta.env.VITE_CDB_LIST_URL ?? "https://api.github.com/repos/ProjectIgnis/BabelCDB/contents/";
const SCRIPTS_URL = import.meta.env.VITE_SCRIPTS_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/CardScripts/master";
const LFLIST_URL = import.meta.env.VITE_LFLIST_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/LFLists/master/0TCG.lflist.conf";
const STRINGS_URL = import.meta.env.VITE_STRINGS_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/Distribution/master/config/strings.conf";

const send = (message: FromWorker) => postMessage(message);

let core: OcgCoreSync;
const cards = new Map<number, OcgCardData>();
const names = new Map<number, string>();
const texts = new Map<number, string>();
const cardStrings = new Map<number, string[]>(); // effect descriptions, str1..str16
const systemStrings = new Map<number, string>();
const counterNames = new Map<number, string>();
// the TCG ban list: passcode -> copies allowed (0, 1 or 2); cards not listed allow 3
const banlist = { name: "", limits: {} as Record<number, number> };

async function loadBanlist() {
  try {
    const text = await (await fetch(LFLIST_URL)).text();
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("!")) banlist.name = line.slice(1).trim();
      const match = /^(\d+) (\d)/.exec(line);
      if (match) banlist.limits[Number(match[1])] = Number(match[2]);
    }
  } catch {
    // no ban list: everything at 3
  }
}

const TYPE_TOKEN_BIT = 0x4000;
const TYPE_SKILL_BIT = 0x8000000;
function infoOf(code: number): CardInfo | null {
  const card = cards.get(code);
  if (!card) return null;
  return { code, name: nameOf(code), type: card.type, level: card.level, attribute: card.attribute, race: Number(card.race), attack: card.attack, defense: card.defense, alias: card.alias };
}

// EDOPro's deck editor order: monsters (by type, then Level high to low), Spells, Traps; then by name
function sortKey(card: CardInfo): [number, number, string] {
  const group = card.type & 1 ? 0 : card.type & 2 ? 1 : 2;
  return [group, -card.level, card.name];
}

function search(query: CardSearch): { results: CardInfo[]; more: boolean } {
  const words = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const out: CardInfo[] = [];
  for (const card of cards.values()) {
    // one row per card name: alternate artworks and tokens are left out, as in EDOPro's search
    if (card.alias && Math.abs(card.alias - card.code) < 20) continue;
    if (card.type & (TYPE_TOKEN_BIT | TYPE_SKILL_BIT)) continue;
    if (query.kind === "monster" && !(card.type & 1)) continue;
    if (query.kind === "spell" && !(card.type & 2)) continue;
    if (query.kind === "trap" && !(card.type & 4)) continue;
    if (query.subtype && !(card.type & query.subtype)) continue;
    if (query.attribute && !(card.attribute & query.attribute)) continue;
    if (query.race && !(Number(card.race) & query.race)) continue;
    if (query.level !== undefined && card.level !== query.level) continue;
    const between = (value: number, range?: [number | null, number | null]) => !range || ((range[0] === null || value >= range[0]) && (range[1] === null || value <= range[1]));
    if (!between(card.attack, query.atk) || !between(card.defense, query.def)) continue;
    if (query.limit !== undefined && (banlist.limits[card.code] ?? 3) !== query.limit) continue;
    if (words.length) {
      const name = nameOf(card.code).toLowerCase();
      const text = (texts.get(card.code) ?? "").toLowerCase();
      if (!words.every((word) => name.includes(word) || text.includes(word))) continue;
    }
    out.push(infoOf(card.code)!);
  }
  // cards whose name matches come before cards that only mention it in their text
  const named = (card: CardInfo) => (words.length && words.every((word) => card.name.toLowerCase().includes(word)) ? 0 : 1);
  out.sort((a, b) => named(a) - named(b) || compareCards(a, b));
  return { results: out.slice(0, 300), more: out.length > 300 };
}

// A card name as typed in a deck list: exact first, then ignoring case and punctuation, then the closest name holding
// every word. Alternate artworks and tokens never match.
const plain = (text: string) => text.toLowerCase().replace(/["'`´’“”]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
let byPlainName: Map<string, number> | null = null;
function cardByName(asked: string): CardInfo | null {
  if (!byPlainName) {
    byPlainName = new Map();
    for (const card of cards.values()) {
      if ((card.alias && Math.abs(card.alias - card.code) < 20) || card.type & (TYPE_TOKEN_BIT | TYPE_SKILL_BIT)) continue;
      const key = plain(nameOf(card.code));
      if (!byPlainName.has(key)) byPlainName.set(key, card.code);
    }
  }
  const key = plain(asked);
  if (!key) return null;
  const exact = byPlainName.get(key);
  if (exact) return infoOf(exact);
  const words = key.split(" ");
  let best: [number, number] | null = null;
  for (const [name, code] of byPlainName) {
    if (!words.every((word) => name.includes(word))) continue;
    // the shortest name holding every word is the closest ("ash blossom" -> Ash Blossom & Joyous Spring)
    if (!best || name.length < best[1]) best = [code, name.length];
  }
  return best ? infoOf(best[0]) : null;
}

function compareCards(a: CardInfo, b: CardInfo) {
  const [ga, la, na] = sortKey(a);
  const [gb, lb, nb] = sortKey(b);
  return ga - gb || la - lb || na.localeCompare(nb);
}
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
      const counter = /^!counter (0x[0-9a-fA-F]+) (.*)$/.exec(line);
      if (counter) counterNames.set(Number(counter[1]), counter[2]);
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
const QUERY = (OcgQueryFlags.CODE | OcgQueryFlags.POSITION | OcgQueryFlags.LEVEL | OcgQueryFlags.RANK | OcgQueryFlags.ATTACK | OcgQueryFlags.DEFENSE | OcgQueryFlags.LINK | OcgQueryFlags.OVERLAY_CARD | OcgQueryFlags.COUNTERS) as OcgQueryFlags;

let duel: OcgDuelHandle | null = null;
let lp = [8000, 8000];
let turn = 0;
let turnPlayer = 0;
let phase = "";
let ended = false;
let prompt: Prompt | null = null;
let events: DuelEvent[] = [];
let ignoreHandTraps = false;
// the computer opponent: whether there is one, whether it fights your turn, and what it has done this turn
let opponentOn = false;
let opponentHandTraps = false;
// on your turn, only these hand traps (empty: any it holds)
let opponentTraps: number[] = [];
let goSecond = false;
const aiUsed = new Set<string>();
let aiBattled = false;
let aiActed = false;
let aiRetries = 0;
// the combo the opponent planned for this turn ("Activate:<code>", "pick:<hint>:<code>", ...) and how far it got
let aiPlan: string[] = [];
let aiStep = 0;
let winner: number | null = null;
// what the next selection is for ("Select the card to add to your hand"), sent by the core just before it
let selectHint = "";
const hinted = (fallback: string) => {
  const text = selectHint || fallback;
  selectHint = "";
  return text;
};
// cards in the current chain, link 1 first
let chain: (CardRef & { code: number })[] = [];
// turns the player's picks into the core's response for the prompt on screen
let respond: ((picks: number[] | null) => OcgResponse | null) | null = null;

const nameOf = (code: number) => names.get(code) ?? (code ? `#${code}` : "");

// An effect description is either "card code * 16 + string number" or a system string.
// EDOPro's scripts number a card's own wording as passcode << 20 | string number (utility.lua aux.Stringid);
// older ones as passcode * 16 + string number. An alternate artwork reads the original's strings.
function cardString(code: number, index: number): string {
  const strings = cardStrings.get(code) ?? cardStrings.get(cards.get(code)?.alias ?? 0);
  return strings?.[index] ?? "";
}
function describe(description: bigint): string {
  const value = Number(description);
  if (value < 10000) return systemStrings.get(value) ?? "";
  const wide = cardString(Number(description >> 20n), Number(description & 0xfffffn));
  return wide || cardString(Math.floor(value / 16), value % 16);
}
// the card a description belongs to (0 for system wording)
function describedCard(description: bigint): number {
  const value = Number(description);
  if (value < 10000) return 0;
  const code = Number(description >> 20n);
  return cards.has(code) ? code : Math.floor(value / 16);
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

function cardChoice(label: string, card: { code: number; controller: number; location: number; sequence: number; overlay_sequence?: number }): Choice {
  // an Xyz Material comes as the Monster Zone of its Xyz Monster plus a material number: mark it as a material
  // (LOCATION_OVERLAY, as EDOPro does) so the page lists it by name instead of lighting up the monster
  const location = card.overlay_sequence !== undefined ? card.location | OcgLocation.OVERLAY : card.location;
  return { label: location & OcgLocation.OVERLAY ? `${label} (material of ${zoneName({ controller: card.controller, location: OcgLocation.MZONE, sequence: card.sequence })})` : label, card: { controller: card.controller, location, sequence: card.sequence, code: card.code, name: nameOf(card.code), type: cards.get(card.code)?.type ?? 0 } };
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
  // the computer opponent answers everything asked of its side
  if (opponentOn && "player" in message && message.player === 1) {
    const response = aiAnswer(message);
    aiActed = true;
    if (response) return answer(response);
    send({ type: "error", text: "The opponent couldn't answer a prompt; its turn ends here." });
    ended = true;
    return false;
  }
  aiActed = false;
  switch (message.type) {
    case OcgMessageType.SELECT_IDLECMD: {
      lastSummon = 0;
      // going second: your turn 1 is the opponent's to open, so it passes at once
      if (goSecond && turn === 1 && message.player === 0) return answer({ type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null });
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
      // say how: an Extra Deck monster is Xyz / Synchro / Link / Fusion Summoned; the same card offered twice is a
      // second way to summon it (another procedure), so the buttons are never two identical "Special Summon"s
      const seenSummons = new Map<string, number>();
      message.special_summons.forEach((card, index) => {
        const type = cards.get(card.code)?.type ?? 0;
        const how =
          card.location === OcgLocation.EXTRA
            ? type & 0x800000 ? "Xyz Summon" : type & 0x2000 ? "Synchro Summon" : type & 0x4000000 ? "Link Summon" : type & 0x40 ? "Fusion Summon" : system(1152, "Special Summon")
            : system(1152, "Special Summon");
        const key = `${card.location}:${card.sequence}:${card.code}`;
        const count = (seenSummons.get(key) ?? 0) + 1;
        seenSummons.set(key, count);
        // offered more than once: say what each way uses, from the card's own text (the scripts register the usual
        // materials first, then each "you can also ... Summon this card by using ..." way)
        const twice = message.special_summons.filter((other) => other.location === card.location && other.sequence === card.sequence && other.code === card.code).length > 1;
        // the core doesn't say which way each one is: a way whose materials aren't on the field can't be it, and the
        // same way offered twice is shown once
        const label = twice ? summonWay(card.code, how, usualReady(card.code) ? count : Math.max(2, count)) : how;
        const again = twice && choices.some((choice) => choice.label === label && choice.card?.code === card.code && choice.card.location === card.location);
        choices.push(again ? { ...cardChoice(label, card), hidden: true } : cardChoice(label, card));
        actions.push([SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, index]);
      });
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
    case OcgMessageType.SELECT_OPTION: {
      // say whose effect it is and which card it is about: "Add Galaxy Summoner to your hand", not "Option 1"
      const source = solvingCode ? nameOf(solvingCode) : "";
      const about = lastPicked.length ? lastPicked.map(nameOf).join(", ") : "";
      const label = (option: bigint, index: number) => {
        const value = Number(option);
        if (about && value === 573) return `Add ${about} to your hand`;
        if (about && value === 574) return `Send ${about} to the GY`;
        const text = describe(option);
        // "Special Summon it in Defense Position (Photon Emperor)": which card "it" is
        if (text) return text.includes("%ls") ? fill(text, about || source) : about && /\b(it|them)\b/.test(text) ? `${text} (${about})` : text;
        // no wording anywhere: the card and which of its effects
        const owner = describedCard(option) ? nameOf(describedCard(option)) : source;
        return owner ? `${owner}: effect ${index + 1}` : `Choice ${index + 1}`;
      };
      return one(
        source ? `${source}: choose one` : "Choose one",
        message.options.map((option, index) => ({ label: label(option, index) })),
        null,
        (index) => ({ type: OcgResponseType.SELECT_OPTION, index: index! }),
      );
    }
    case OcgMessageType.SELECT_CHAIN: {
      // with hand traps switched off, known hand traps in the hand are never offered (other hand effects are)
      const offered = message.selects
        .map((card, index) => ({ card, index }))
        // on your own turn only: on the opponent's turn hand traps are what you are there to use
        .filter(({ card }) => !(ignoreHandTraps && turnPlayer === 0 && card.location === OcgLocation.HAND && isHandTrap(card.code, cards.get(card.code)?.alias)));
      if (offered.length === 0 && !message.forced) return answer({ type: OcgResponseType.SELECT_CHAIN, index: null });
      // the side with nobody on it never chains
      if (message.player !== 0) return answer({ type: OcgResponseType.SELECT_CHAIN, index: message.forced ? 0 : null });
      const list = offered.length ? offered : message.selects.map((card, index) => ({ card, index }));
      return one(
        // what you would be responding to, and when
        chain.length
          ? `Respond to ${nameOf(chain[chain.length - 1].code)}?`
          : lastSummon
            ? `Respond to the summon of ${nameOf(lastSummon)}?`
            : `${turnPlayer === 0 ? "Your" : "Opponent's"} ${phaseTitle(phase)}: activate an effect?`,
        list.map(({ card }) => {
          const text = describe(card.description);
          return cardChoice(text ? `${nameOf(card.code)}: ${text}` : nameOf(card.code), card);
        }),
        message.forced ? null : "Don't chain",
        (pick) => ({ type: OcgResponseType.SELECT_CHAIN, index: pick === null ? null : list[pick].index }),
      );
    }
    case OcgMessageType.SELECT_CARD:
    case OcgMessageType.SELECT_TRIBUTE: {
      const tribute = message.type === OcgMessageType.SELECT_TRIBUTE;
      const cancel = message.can_cancel;
      prompt = {
        kind: "multi",
        title: hinted(tribute ? system(500, "Select the monsters to Tribute") : "Select"),
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
        `${hinted("Select")} (${count})`,
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
      prompt = { kind: "multi", title: hinted("Select a zone"), choices: zones, min: count, max: count, cancel: false };
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
    case OcgMessageType.SELECT_SUM: {
      const both = (amount: number): [number, number] => [amount & 0xffff, (amount >>> 16) & 0xffff];
      const sum = { target: message.amount, exact: message.select_max === 0, values: message.selects.map((card) => both(card.amount)), must: message.selects_must.map((card) => both(card.amount)) };
      const must = message.selects_must.map((card) => nameOf(card.code));
      prompt = {
        kind: "multi",
        title: `${hinted("Select")}: total ${message.amount}${must.length ? ` (with ${must.join(", ")})` : ""}`,
        choices: message.selects.map((card) => cardChoice(nameOf(card.code), card)),
        // the core sends 0 for "no limit" on how many cards
        min: Math.max(1, message.min - must.length),
        max: message.max > 0 ? Math.max(1, message.max - must.length) : 99,
        cancel: false,
        sum,
      };
      respond = (picks) => picks && { type: OcgResponseType.SELECT_SUM, indicies: picks };
      return true;
    }
    case OcgMessageType.SELECT_COUNTER: {
      const name = counterNames.get(message.counter_type) ?? "counter";
      prompt = {
        kind: "counter",
        title: `Remove ${message.count} ${name}${message.count > 1 ? "s" : ""}`,
        choices: message.cards.map((card) => cardChoice(nameOf(card.code), card)),
        available: message.cards.map((card) => card.count),
        total: message.count,
      };
      respond = (picks) => picks && { type: OcgResponseType.SELECT_COUNTER, counters: picks };
      return true;
    }
    case OcgMessageType.ANNOUNCE_RACE:
    case OcgMessageType.ANNOUNCE_ATTRIB: {
      const race = message.type === OcgMessageType.ANNOUNCE_RACE;
      const bits: bigint[] = [];
      const available = BigInt(message.available);
      for (let bit = 0; bit < (race ? 30 : 7); bit++) if (available & (1n << BigInt(bit))) bits.push(1n << BigInt(bit));
      // EDOPro's names: Attributes are system strings 1010+, Types 1020+, one per bit
      const label = (bit: bigint) => system((race ? 1020 : 1010) + bit.toString(2).length - 1, `#${bit}`);
      prompt = {
        kind: "multi",
        title: hinted(race ? `Declare ${message.count > 1 ? `${message.count} Types` : "a Type"}` : `Declare ${message.count > 1 ? `${message.count} Attributes` : "an Attribute"}`),
        choices: bits.map((bit) => ({ label: label(bit) })),
        min: message.count,
        max: message.count,
        cancel: false,
      };
      respond = (picks) =>
        picks &&
        (race
          ? { type: OcgResponseType.ANNOUNCE_RACE, races: picks.map((pick) => bits[pick]) as never }
          : { type: OcgResponseType.ANNOUNCE_ATTRIB, attributes: picks.map((pick) => Number(bits[pick])) as never });
      return true;
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
    const facedown = controller === 1 && (position & (OcgPosition.FACEDOWN_ATTACK | OcgPosition.FACEDOWN_DEFENSE)) !== 0 && location !== OcgLocation.GRAVE;
    const secret = !revealAll && (hidden || facedown);
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
      overlay: info.overlayCards ?? [],
      counters: Object.entries(info.counters ?? {})
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => ({ name: counterNames.get(Number(kind)) ?? "Counter", count })),
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

// The computer opponent: plain and predictable, so a replay plays the same. On its turn it activates everything it
// can, Special Summons, Normal Summons, then attacks with everything; on yours it only chains hand traps if told to.
let aiPlanned = false;
// At the start of its Main Phase the opponent works out a combo for its hand with the route search, as if its hand were
// a fresh opening (your board is not part of the plan), then follows it. Once your interruptions throw it off the
// plan, it goes back to using whatever it can.
function aiMakePlan() {
  aiPlanned = true;
  const codesIn = (location: OcgLocation) =>
    core.duelQueryLocation(duel!, { flags: OcgQueryFlags.CODE as OcgQueryFlags, controller: 1, location }).flatMap((card) => (card?.code ? [card.code] : []));
  const hand = codesIn(OcgLocation.HAND);
  if (!hand.length) return;
  if (!quiet) {
    events.push({ kind: "message", code: 0, name: "", controller: 1, location: 0, sequence: 0, text: "Opponent is planning its turn…" });
    sendView();
  }
  const env = { core, card: (code: number) => cards.get(code) ?? null, script: (name: string) => readScript(name) ?? "", name: nameOf, effects: effectsOf, setcodes: (code: number) => cards.get(code)?.setcodes ?? [] };
  const steps = routeSearch(env, hand, codesIn(OcgLocation.DECK), codesIn(OcgLocation.EXTRA), { goal: 3, targets: [], budget: 350 });
  let next = steps.next();
  while (!next.done) next = steps.next();
  aiPlan = next.value.keys;
  aiStep = 0;
}
// the plan's next step, if it is on offer: the index of the matching option
function aiFollow(kind: "idle" | "pick", options: { code: number; tag?: string }[]): number {
  const step = aiPlan[aiStep];
  if (!step) return -1;
  const [head, ...rest] = step.split(":");
  const [verb, effect] = head.split("#");
  const code = Number(rest[rest.length - 1]);
  const wanted = verb === "pick" ? "pick" : verb === "Normal" ? "n" : verb === "Special" ? "s" : "a";
  if ((kind === "pick") !== (wanted === "pick")) return -1;
  const matches = (option: { code: number; tag?: string }) => option.code === code && (kind === "pick" || option.tag === wanted);
  // the same effect of the card as in the plan (Galaxy Wizard's search, not its Level), else any of its effects
  let at = effect ? options.findIndex((option) => matches(option) && (option as { effect?: string }).effect === effect) : -1;
  if (at < 0) at = options.findIndex(matches);
  if (at >= 0) aiStep++;
  // off the plan (something was negated or banished): from here on it plays by what it can
  else aiPlan = [];
  return at;
}

function aiAnswer(message: OcgMessage): OcgResponse | null {
  switch (message.type) {
    case OcgMessageType.SELECT_IDLECMD: {
      if (turnPlayer === 1 && !aiPlanned) aiMakePlan();
      {
        const offered = [
          ...message.activates.map((card, index) => ({ code: card.code, tag: "a", effect: String(card.description), action: SelectIdleCMDAction.SELECT_ACTIVATE, index })),
          ...message.special_summons.map((card, index) => ({ code: card.code, tag: "s", action: SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, index })),
          ...message.summons.map((card, index) => ({ code: card.code, tag: "n", action: SelectIdleCMDAction.SELECT_SUMMON, index })),
        ];
        const at = aiFollow("idle", offered);
        if (at >= 0) return { type: OcgResponseType.SELECT_IDLECMD, action: offered[at].action, index: offered[at].index };
      }
      const candidates: [SelectIdleCMDAction, { code: number; location: number; sequence: number }[], string][] = [
        [SelectIdleCMDAction.SELECT_ACTIVATE, message.activates, "a"],
        [SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, message.special_summons, "s"],
        [SelectIdleCMDAction.SELECT_SUMMON, message.summons, "n"],
      ];
      if (aiUsed.size < 60)
        for (const [action, list, tag] of candidates)
          for (let index = 0; index < list.length; index++) {
            const card = list[index];
            // Normal Summoning a hand trap only wastes the Normal Summon
            if (tag === "n" && isHandTrap(card.code, cards.get(card.code)?.alias)) continue;
            const key = `${tag}:${card.code}:${card.location}:${card.sequence}:${"description" in card ? String(card.description) : ""}`;
            if (aiUsed.has(key)) continue;
            aiUsed.add(key);
            return { type: OcgResponseType.SELECT_IDLECMD, action, index };
          }
      // no attacking on the duel's first real turn (its turn 2 when you go second)
      if (message.to_bp && !aiBattled && turn > (goSecond ? 2 : 1)) {
        aiBattled = true;
        return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_BP, index: null };
      }
      return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null };
    }
    case OcgMessageType.SELECT_BATTLECMD:
      if (message.attacks.length) return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.SELECT_BATTLE, index: 0 };
      return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_EP, index: null };
    case OcgMessageType.SELECT_CHAIN: {
      if (message.forced) return { type: OcgResponseType.SELECT_CHAIN, index: 0 };
      // on your turn: its hand traps, if allowed; on its own turn: every effect once
      const usable = message.selects
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => (turnPlayer === 1 ? !aiUsed.has(`c:${card.code}:${String(card.description)}`) : opponentHandTraps && card.location === OcgLocation.HAND && (!opponentTraps.length || opponentTraps.includes(knownCode(card.code)))));
      const pick = usable[0];
      if (!pick) return { type: OcgResponseType.SELECT_CHAIN, index: null };
      aiUsed.add(`c:${pick.card.code}:${String(pick.card.description)}`);
      return { type: OcgResponseType.SELECT_CHAIN, index: pick.index };
    }
    case OcgMessageType.SELECT_EFFECTYN:
      return { type: OcgResponseType.SELECT_EFFECTYN, yes: true };
    case OcgMessageType.SELECT_YESNO:
      return { type: OcgResponseType.SELECT_YESNO, yes: true };
    case OcgMessageType.SELECT_CARD:
    case OcgMessageType.SELECT_UNSELECT_CARD: {
      // the plan's pick (what to search, what to send), if it is among the cards offered
      const list = message.type === OcgMessageType.SELECT_CARD ? message.selects : message.select_cards;
      const single = message.type === OcgMessageType.SELECT_UNSELECT_CARD || (message.min === 1 && message.max === 1);
      if (single && aiPlan.length && aiPlan[aiStep]?.startsWith("pick:")) {
        const at = aiFollow("pick", list.map((card) => ({ code: card.code })));
        if (at >= 0)
          return message.type === OcgMessageType.SELECT_CARD
            ? { type: OcgResponseType.SELECT_CARD, indicies: [at] }
            : ({ type: OcgResponseType.SELECT_UNSELECT_CARD, index: at } as OcgResponse);
      }
      return autoAnswer(message);
    }
    case OcgMessageType.ANNOUNCE_CARD: {
      const opcodes = message.opcodes.map((opcode) => BigInt(opcode));
      const card = [...cards.values()].find((one) => declarable(one, opcodes));
      return card ? { type: OcgResponseType.ANNOUNCE_CARD, card: card.code } : null;
    }
    default:
      return autoAnswer(message);
  }
}

// the test being played, as it will be saved; `quiet` holds the views back while a recorded test is fast-forwarded
let record: TestRecord | null = null;
// "Main 1" -> "Main Phase 1", "Battle" -> "Battle Phase"
const phaseTitle = (name: string) => (name.startsWith("Main") ? `Main Phase ${name.slice(5)}` : name ? `${name} Phase` : "turn");
// the monster summoned last, until the next action: a chance to respond right after it is about that summon
let lastSummon = 0;
// "Xyz Summon: 3 Level 8 monsters", "Xyz Summon using a "Galaxy-Eyes" Xyz Monster you control"
// Whether the card's usual materials ("3 Level 8 monsters") are face-up on your field now. Xyz and Link Monsters have
// no Level, so they never count. Materials the text puts some other way are taken as possible.
function usualReady(code: number): boolean {
  const text = texts.get(code) ?? texts.get(cards.get(code)?.alias ?? 0) ?? "";
  const usual = /^(\d+)\+? Level (\d+) monsters?$/i.exec(text.split(/\r?\n/)[0].trim());
  if (!usual) return true;
  const [need, level] = [Number(usual[1]), Number(usual[2])];
  const ready = cardsIn(0, OcgLocation.MZONE).filter((one) => one && one.code && one.position & 0x5 && !((cards.get(one.code)?.type ?? 0) & (0x800000 | 0x4000000)) && one.level === level).length;
  return ready >= need;
}

function summonWay(code: number, how: string, nth: number): string {
  const text = texts.get(code) ?? texts.get(cards.get(code)?.alias ?? 0) ?? "";
  const materials = text.split(/\r?\n/)[0].trim();
  const others = [...text.matchAll(/you can also (?:Xyz |Synchro |Link |Fusion |Special )?Summon (?:this card|"[^"]+") by using (.+?)(?: as (?:the )?materials?)?(?:\.|,| \()/gi)].map((match) => match[1].trim());
  if (nth === 1) return materials && materials.length < 80 ? `${how}: ${materials}` : how;
  const other = others[nth - 2];
  return other ? `${how} using ${other}` : `${how} (another way)`;
}

// the card whose effect is resolving, and the cards last picked (an option is often about them)
let solvingCode = 0;
let lastPicked: number[] = [];
// the core's last "Select a card to ..." hint, and the one for the prompt on screen
let lastHint = 0;
let promptHint = 0;
let quiet = false;
// collecting every moment of a replay (for a video) instead of sending it to the screen
let collect: DuelView[] | null = null;
// a replay being watched shows every card, both hands and Extra Decks included
let revealAll = false;

// "Normal Summon Galaxy Wizard", "Select a card to add to your hand: Galaxy Defense Robot Orbital 7"
function describePick(shown: Prompt, picks: number[] | null): string {
  if (picks === null) return shown.kind === "choice" && shown.cancel ? shown.cancel : "Cancel";
  if (shown.kind === "counter") return `${shown.title}: ${picks.map((count, index) => (count ? `${count} from ${shown.choices[index]?.card?.name}` : "")).filter(Boolean).join(", ")}`;
  if (shown.kind === "announce") return `${shown.title}: ${shown.options[picks[0]]?.name ?? ""}`;
  const chosen = picks.map((pick) => shown.choices[pick]).filter(Boolean).map((choice) => (choice.card ? (choice.label && choice.label !== choice.card.name ? `${choice.label} ${choice.card.name}` : choice.card.name) : choice.label));
  return shown.kind === "choice" && shown.idle ? chosen.join(", ") : `${shown.title ? `${shown.title}: ` : ""}${chosen.join(", ")}`;
}

function sendView() {
  if (quiet) {
    events = [];
    return;
  }
  const field = core.duelQueryField(duel!);
  const players: [PlayerView, PlayerView] = [playerView(0, field.players[0].deck_size), playerView(1, field.players[1].deck_size)];
  for (const controller of [0, 1]) {
    field.players[controller].monsters.forEach((zone, sequence) => {
      const card = players[controller].monsters[sequence];
      if (card && zone) card.materials = zone.materials;
    });
  }
  const view: DuelView = { events, turn, turnPlayer, phase, players, prompt, ended, winner };
  events = [];
  if (collect) collect.push(view);
  else send({ type: "view", view });
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
          aiUsed.clear();
          aiBattled = false;
          aiPlan = [];
          aiStep = 0;
          aiPlanned = false;
          break;
        case OcgMessageType.NEW_PHASE:
          phase = PHASES[message.phase] ?? "";
          lastSummon = 0;
          // every phase is shown, yours and the opponent's, so you know when you are being asked to respond
          if ((opponentOn || turnPlayer === 0) && !(goSecond && turn === 1))
            events.push({ kind: "phase", code: 0, name: "", controller: turnPlayer, location: 0, sequence: 0, text: `${turnPlayer === 0 ? "Your" : "Opponent's"} ${phaseTitle(phase)}` });
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
          lastSummon = message.code;
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
          solvingCode = link?.code ?? 0;
          if (link) events.push({ kind: "resolve", ...link, name: nameOf(link.code), chain: message.chain_size });
          break;
        }
        case OcgMessageType.DRAW:
          if (message.player === 0)
            for (const card of message.drawn)
              events.push({ kind: "draw", code: card.code, name: nameOf(card.code), controller: 0, location: OcgLocation.HAND, sequence: -1 });
          break;
        case OcgMessageType.HINT:
          if (message.hint_type === OcgHintType.SELECTMSG && message.player === 0) {
            selectHint = describe(message.hint);
            lastHint = Number(message.hint);
          }
          else if (message.hint_type === OcgHintType.MESSAGE && message.player === 0) {
            const text = describe(message.hint);
            if (text) events.push({ kind: "message", code: 0, name: "", controller: 0, location: 0, sequence: 0, text });
          }
          break;
        case OcgMessageType.CHAIN_NEGATED:
        case OcgMessageType.CHAIN_DISABLED: {
          const link = chain[message.chain_size - 1];
          if (link)
            events.push({
              kind: "negated",
              ...link,
              name: nameOf(link.code),
              chain: message.chain_size,
              text: message.type === OcgMessageType.CHAIN_NEGATED ? "Activation negated" : "Effect negated",
            });
          break;
        }
        case OcgMessageType.CONFIRM_CARDS:
        case OcgMessageType.CONFIRM_DECKTOP:
          for (const card of message.cards)
            if (card.code) events.push({ kind: "reveal", code: card.code, name: nameOf(card.code), controller: card.controller, location: card.location, sequence: card.sequence });
          break;
        case OcgMessageType.TOSS_COIN:
          events.push({ kind: "coin", code: 0, name: "", controller: 0, location: 0, sequence: 0, text: `Coin: ${message.results.map((heads) => (heads ? "Heads" : "Tails")).join(", ")}` });
          break;
        case OcgMessageType.TOSS_DICE:
          events.push({ kind: "dice", code: 0, name: "", controller: 0, location: 0, sequence: 0, text: `Die: ${message.results.join(", ")}` });
          break;
        case OcgMessageType.ATTACK:
          // the attacker, read from the field (the message only says where it is)
          const attacker = cardsIn(message.card.controller as 0 | 1, message.card.location as OcgLocation)[message.card.sequence]?.code ?? 0;
          events.push({
            kind: "attack",
            code: attacker,
            name: nameOf(attacker),
            controller: message.card.controller,
            location: message.card.location,
            sequence: message.card.sequence,
            target: message.target ? { controller: message.target.controller, location: message.target.location, sequence: message.target.sequence } : undefined,
          });
          break;
        case OcgMessageType.WIN:
          winner = message.player;
          ended = true;
          break;
        case OcgMessageType.CHAIN_END:
          chain = [];
          solvingCode = 0;
          lastPicked = [];
          lastSummon = 0;
          break;
        case OcgMessageType.MOVE:
          // a card found in the deck and added to the player's hand (searches)
          if (message.from.location === OcgLocation.DECK && message.to.location === OcgLocation.HAND && message.to.controller === 0 && message.card)
            events.push({ kind: "added", code: message.card, name: nameOf(message.card), controller: 0, location: OcgLocation.HAND, sequence: message.to.sequence });
          break;
        case OcgMessageType.RETRY:
          // the opponent tries something else (its Main Phase choices are remembered as used); a few times at most
          if (aiActed) {
            if (++aiRetries > 8) {
              send({ type: "error", text: "The opponent got stuck; its turn ends here." });
              ended = true;
            }
          } else send({ type: "error", text: "The duel core did not accept that choice." });
          break;
        default:
          if (isPrompt(message.type)) {
            const shows = buildPrompt(message);
            if (prompt) promptHint = lastHint;
            lastHint = 0;
            if (shows && !prompt) ended = true;
          }
      }
    }
    if (status === OcgProcessResult.END) ended = true;
    // show this moment before anything else happens
    if (events.length && !prompt) sendView();
  }
  sendView();
}

async function start(options: StartOptions) {
  const missing = await prefetchScripts([...options.main, ...options.extra, ...(options.opponent?.main ?? []), ...(options.opponent?.extra ?? [])].map(knownCode));
  if (missing.length)
    send({ type: "error", text: `Could not download the card scripts for ${missing.map(nameOf).join(", ")}. Check the connection and tap New hand.` });
  if (duel) core.destroyDuel(duel);
  lp = [8000, 8000];
  turn = 0;
  turnPlayer = 0;
  phase = "";
  ended = false;
  winner = null;
  selectHint = "";
  events = [];
  ignoreHandTraps = options.ignoreHandTraps;
  lastPicked = [];
  solvingCode = 0;
  opponentOn = !!options.opponent?.main.length;
  opponentHandTraps = !!options.opponentHandTraps;
  opponentTraps = (options.opponentTraps ?? []).map(knownCode);
  goSecond = opponentOn && !!options.goSecond;
  aiUsed.clear();
  aiBattled = false;
  aiRetries = 0;
  chain = [];
  duel = core.createDuel({
    // the page shuffles the deck itself, so the cards asked for can be put on top
    flags: OcgDuelMode.MODE_MR5 | OcgDuelMode.PSEUDO_SHUFFLE,
    seed: [BigInt(options.seed), 2n, 3n, 4n],
    team1: { drawCountPerTurn: 1, startingDrawCount: options.hand, startingLP: 8000 },
    // going second: it opens with 4 and draws its 5th on what is its first turn
    team2: { drawCountPerTurn: 1, startingDrawCount: opponentOn ? (options.goSecond ? 4 : 5) : 0, startingLP: 8000 },
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
  if (options.opponent) {
    const theirs = (code: number, location: OcgLocation) =>
      core.duelNewCard(handle, { team: 1, duelist: 0, code, controller: 1, location, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    for (const code of [...options.opponent.main].reverse()) theirs(knownCode(code), OcgLocation.DECK);
    for (const code of options.opponent.extra) theirs(knownCode(code), OcgLocation.EXTRA);
  }
  core.startDuel(handle);
  // the duel's settings only (a "start" request also carries its type, which must not travel with a saved test)
  const { type: _type, ...settings } = options as StartOptions & { type?: string };
  record = { options: settings, picks: [], steps: [], startHand: [] };
  advance();
  record.startHand = cardsIn(0, OcgLocation.HAND).flatMap((card) => (card ? [card.code] : []));
  // the page keeps the duel's start straight away, so a state can be saved before the first choice
  if (!quiet && !collect) send({ type: "record", record });
}

// Makes a choice on the prompt on screen, records it, and plays on. False if the core's prompt doesn't take it.
function choose(picks: number[] | null): boolean {
  const shown = prompt;
  const response = duel && respond ? respond(picks) : null;
  if (!response || !shown) return false;
  // remember which cards were picked, for a following "add it or send it?" choice
  if (picks && (shown.kind === "multi" || shown.kind === "choice")) {
    const codes = picks.flatMap((pick) => (shown.choices[pick]?.card?.code ? [shown.choices[pick].card!.code] : []));
    if (codes.length) lastPicked = codes;
  }
  record?.picks.push(picks);
  // the card acted on or picked: what the route search learns your lines from
  const acted = picks?.length === 1 && "choices" in shown ? shown.choices[picks[0]]?.card?.code : undefined;
  record?.steps.push({ text: describePick(shown, picks), idle: shown.kind === "choice" && !!shown.idle, code: acted, hint: promptHint || undefined, turn });
  core.duelSetResponse(duel!, response);
  advance();
  if (record && !quiet && !collect) send({ type: "record", record });
  return true;
}

// ---------------------------------------------------------------------------
// The engine probe runs between other requests: one small duel, then a pause so searches and the duel keep answering.
let probeJob = 0;
async function runProbe(id: number, main: number[], extra: number[]) {
  probeJob = id;
  // one code per card name: alternate artworks probe as the card they are
  const canonical = (code: number) => {
    const known = knownCode(code);
    const card = cards.get(known);
    return card?.alias && Math.abs(card.alias - known) < 20 && cards.has(card.alias) ? card.alias : known;
  };
  const mainCodes = main.map(canonical).filter((code) => cards.has(code));
  const extraCodes = extra.map(canonical).filter((code) => cards.has(code));
  await prefetchScripts([...mainCodes, ...extraCodes]);
  const env = { core, card: (code: number) => cards.get(code) ?? null, script: (name: string) => readScript(name) ?? "", name: nameOf };
  let last = 0;
  let finished: { done: number; total: number; evidence: Map<number, CardEvidence> } | null = null;
  await drive(probeDeck(env, mainCodes, extraCodes, true), env, [], [], extraCodes, () => probeJob === id, (value) => {
    if (!value || typeof value !== "object" || !("evidence" in value)) return;
    const progress = value as { done: number; total: number; evidence: Map<number, CardEvidence> };
    if (progress.done >= progress.total) finished = progress;
    else if (performance.now() - last > 200) {
      send({ type: "probe", id, done: progress.done, total: progress.total });
      last = performance.now();
    }
  });
  const result = finished as { done: number; total: number; evidence: Map<number, CardEvidence> } | null;
  if (result && probeJob === id) send({ type: "probe", id, done: result.done, total: result.total, evidence: [...result.evidence.values()] });
}

// ---------------------------------------------------------------------------
// Helpers: a few more copies of the core, each in its own worker, play a search's tries side by side. Phones get two
// (memory), computers up to four. Without them (a browser that can't start a worker from a worker) tries play here.
const HELPERS = Math.max(0, Math.min((navigator.hardwareConcurrency || 2) - 1, /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4 ? 2 : 4));
let helpers: Promise<Worker[]> | null = null;
const helperSent = new Set<string>();
let helperJob = 0;
function startHelpers(): Promise<Worker[]> {
  helpers ??= (async () => {
    if (typeof Worker === "undefined" || !HELPERS) return [];
    const list = cards.size ? [...cards] : [];
    const started = await Promise.all(
      Array.from({ length: HELPERS }, () =>
        new Promise<Worker | null>((resolve) => {
          try {
            const helper = new Worker(new URL("./helper.ts", import.meta.url), { type: "module" });
            const timer = setTimeout(() => (helper.terminate(), resolve(null)), 60000);
            helper.onmessage = (event: MessageEvent<FromHelper>) => event.data.type === "ready" && (clearTimeout(timer), resolve(helper));
            helper.onerror = () => (clearTimeout(timer), resolve(null));
            helper.postMessage({ type: "init", cards: list, names: [...names], scripts: [...scripts], scriptsUrl: SCRIPTS_URL } satisfies ToHelper);
          } catch {
            resolve(null);
          }
        }),
      ),
    );
    for (const name of scripts.keys()) helperSent.add(name);
    return started.filter((one): one is Worker => !!one);
  })();
  return helpers;
}
// Spreads work over the helpers a few at a time (whoever is free takes the next few); answers come back in order.
// Without helpers it is done here, with a pause after each so the duel keeps answering.
type Env = Parameters<typeof play>[0];
async function spread<T, R>(items: T[], local: (item: T) => R, ask: (id: number, items: T[]) => ToHelper, read: (answer: FromHelper) => R[] | undefined): Promise<R[]> {
  const pool = await startHelpers();
  if (!pool.length) {
    const out: R[] = [];
    for (const item of items) {
      out.push(local(item));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return out;
  }
  // scripts fetched here since the helpers started go to them first
  const fresh = [...scripts].filter(([name]) => !helperSent.has(name));
  if (fresh.length) {
    for (const helper of pool) helper.postMessage({ type: "scripts", scripts: fresh } satisfies ToHelper);
    for (const [name] of fresh) helperSent.add(name);
  }
  const out: R[] = new Array(items.length);
  const chunk = Math.max(1, Math.min(8, Math.ceil(items.length / (pool.length * 3))));
  let next = 0;
  await Promise.all(
    pool.map(async (helper) => {
      while (next < items.length) {
        const from = next;
        next += chunk;
        const id = ++helperJob;
        const answer = await new Promise<FromHelper>((resolve) => {
          const listener = (event: MessageEvent<FromHelper>) => {
            if ("id" in event.data && event.data.id === id) (helper.removeEventListener("message", listener), resolve(event.data));
          };
          helper.addEventListener("message", listener);
          helper.postMessage(ask(id, items.slice(from, from + chunk)));
        });
        if (answer.type === "error") throw new Error(answer.text);
        read(answer)?.forEach((result, at) => (out[from + at] = result));
      }
    }),
  );
  return out;
}

// Runs a search to its end, playing the tries it asks for on the helpers. `alive` says whether it is still wanted;
// `progress` sees everything else it yields.
async function drive<R>(steps: Generator<unknown, R, unknown>, env: Env, hand: number[], deck: number[], extra: number[], alive: () => boolean, progress?: (value: unknown) => void): Promise<R | null> {
  let answer: unknown;
  let pause = performance.now();
  for (;;) {
    if (!alive()) return null;
    const next = steps.next(answer);
    answer = undefined;
    if (next.done) return next.value;
    const value = next.value;
    if (isNeed(value)) {
      answer = await spread(value.need, (plan) => play(env, hand, deck, extra, plan, value.against), (id, plans) => ({ type: "plays", id, hand, deck, extra, against: value.against, plans }), (one) => (one.type === "plays" ? one.stops : undefined));
    } else if (isProbes(value)) {
      answer = await spread(value.probes, (one) => probe(env, one.hand, one.deck, extra, one.options), (id, probes) => ({ type: "probes", id, extra, probes }), (one) => (one.type === "probes" ? one.results : undefined));
    } else if (isFollow(value)) {
      answer = await spread(value.follow, (job) => playAgainst(env, hand, deck, extra, job.keys, job.trap, job.at, job.fixed), (id, jobs) => ({ type: "follows", id, hand, deck, extra, jobs }), (one) => (one.type === "follows" ? one.results : undefined));
    } else {
      progress?.(value);
      // a breath now and then for the duel and searches
      if (performance.now() - pause > 30) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        pause = performance.now();
      }
    }
  }
}

// What a card does that matters for building a deck, from its text, in a few words each: conditions that clash with
// other cards, the Normal Summon, once per turn, locks, and which hand traps can stop it (or can't).
function traitsOf(code: number): string[] {
  const text = (texts.get(code) ?? "").replace(/\s+/g, " ");
  const type = cards.get(code)?.type ?? 0;
  const out: string[] = [];
  if (/while you control no monsters|If you control no monsters/i.test(text)) out.push("needs an empty field");
  if (/Normal Summon[^.]*in addition to your Normal Summon/i.test(text)) out.push("gives an extra Normal Summon");
  if (/Must (first )?be Special Summoned|Special Summon(ed)? (this card )?\(from your hand\)/i.test(text)) out.push("summons itself by its own rule: can't be negated");
  if (/You can only (use|activate) (each|this|1)[^.]*(once per turn|per turn)/i.test(text)) out.push("once per turn by name");
  const lock = /you cannot (Special Summon[^.]*?except [^.,]+)/i.exec(text)?.[1];
  if (lock) out.push(`locks you: cannot ${lock.replace(/ for the rest of this turn/i, "")}`);
  const weak: string[] = [];
  // each effect on its own: its condition and what it does
  // (a Spell or Trap's activation is its effect; "You can only use ... once per turn" is a limit, not an effect)
  const effects = type & 1 ? text.split(/(?<=\.) (?=[A-Z(●])/).filter((one) => /You can|Quick Effect|:/.test(one) && !/^\(?You can only/.test(one)) : [text];
  if (effects.some((one) => /\bDeck\b/.test(one) && /(add|Special Summon|send|take)/i.test(one))) weak.push("Ash");
  if (/add [^.]*to your hand/i.test(text)) weak.push("Droll after it");
  // a monster effect used while it's face-up on the field (not one from the hand or the GY)
  const fromElsewhere = /this card (from|in) your (hand|GY)|this card is sent to the GY|this card is in your GY|this card from your hand/i;
  if (type & 1 && effects.some((one) => /You can|Quick Effect/.test(one) && !fromElsewhere.test(one))) weak.push("Veiler / Imperm on the field");
  if (weak.length) out.push(`stopped by ${weak.join(", ")}`);
  if (/(in your GY|from your GY|is sent to the GY|this card in your GY)/i.test(text)) out.push("has a GY effect: out of Veiler / Imperm's reach");
  return out;
}

// What a line leaves in place for the opponent's turn: an effect it used whose operation protects your cards until
// then (Galaxy-Eyes Cipher X Dragon: they cannot target your LIGHT monsters), in the card's own words.
function protectionOf(used: { code: number; effect?: string }[]): Protection[] {
  const out: Protection[] = [];
  for (const { code, effect } of used) {
    if (out.some((one) => one.code === code)) continue;
    const protects = effectsOf(code).filter((one) => one.protects && (effect === undefined || one.description === undefined || one.description === effect));
    if (!protects.length) continue;
    // the sentence of the card text that says it: "your opponent cannot target LIGHT monsters you control ..."
    const sentences = (texts.get(code) ?? "").split(/(?<=\.)\s+|\n|●/);
    const said = sentences.find((one) => /cannot (be )?target|cannot be destroyed|unaffected|cannot be (Tributed|banished|negated|returned)|cannot activate|cannot be targeted/i.test(one)) ?? "";
    out.push({ code, text: (said.includes(";") ? said.slice(said.lastIndexOf(";") + 1) : said).trim().replace(/\.$/, "") });
  }
  return out;
}
// which effect a step's key names: "Activate#<description>:<code>" (code<<20 | n, or the older code*16 + n)
const usedOf = (keys: string[]) =>
  keys.flatMap((key) => {
    const match = /^Activate(?:#(\d+))?:(\d+)$/.exec(key);
    if (!match) return [];
    const code = Number(match[2]);
    if (!match[1]) return [{ code }];
    const description = BigInt(match[1]);
    const effect = description >> 20n === BigInt(code) ? description & 0xfffffn : description - BigInt(code) * 16n;
    return [{ code, effect: String(effect) }];
  });

// Route search, between other requests like the probe. The line found comes back as a test the duel screen replays:
// the same deck order, seed and settings the search played with, and its choices as the screen takes them.
let routeJob = 0;
// what each card can do on the opponent's turn, read once from its script
const quickEffects = new Map<number, QuickEffect[]>();
let setConstants: Map<string, number> | null = null;
function effectsOf(code: number): QuickEffect[] {
  setConstants ??= readSetConstants(readScript("archetype_setcode_constants.lua") ?? "", readScript("constant.lua") ?? "");
  if (!quickEffects.has(code)) quickEffects.set(code, readEffects(readScript(`c${code}.lua`) ?? "", cards.get(code)?.type ?? 0, setConstants));
  return quickEffects.get(code)!;
}
async function runRoute(id: number, main: number[], extra: number[], hand: number[], targets: number[][], prior: string[], goal: number) {
  routeJob = id;
  const canonical = (code: number) => {
    const known = knownCode(code);
    const card = cards.get(known);
    return card?.alias && Math.abs(card.alias - known) < 20 && cards.has(card.alias) ? card.alias : known;
  };
  const handCodes = hand.map(canonical);
  const deck = main.map(canonical).filter((code) => cards.has(code));
  for (const code of handCodes) deck.splice(deck.indexOf(code), 1);
  const extraCodes = extra.map(canonical).filter((code) => cards.has(code));
  await prefetchScripts([...handCodes, ...deck, ...extraCodes]);
  const env = { core, card: (code: number) => cards.get(code) ?? null, script: (name: string) => readScript(name) ?? "", name: nameOf, effects: effectsOf, setcodes: (code: number) => cards.get(code)?.setcodes ?? [] };
  const steps = routeSearch(env, handCodes, deck, extraCodes, { goal, targets: targets.map((board) => board.map(canonical)), prior: new Set(prior), batch: true });
  let last = 0;
  const route = await drive(steps, env, handCodes, deck, extraCodes, () => routeJob === id, (value) => {
    if (value && typeof value === "object" && "tried" in value && performance.now() - last > 250) {
      send({ type: "route", id, tried: (value as { tried: number }).tried });
      last = performance.now();
    }
  });
  if (!route) return;
  const options: StartOptions = { main: [...handCodes, ...[...deck].reverse()], extra: extraCodes, hand: handCodes.length, chosen: [], ignoreHandTraps: true, seed: 1 };
  const record: TestRecord = { options, picks: route.ui, steps: route.steps.map((text) => ({ text, idle: !text.startsWith("pick ") && !text.startsWith("finish") })), startHand: handCodes };
  send({ type: "route", id, tried: route.tried, done: { route: { ...route, protection: protectionOf(usedOf(route.keys)) }, record } });
}

// Choke points for one line, between other requests like the probe and the route search
let chokeJob = 0;
async function runChoke(id: number, main: number[], extra: number[], hand: number[], keys: string[], goal: number, combo: number[] = [], traps: number[] = CHOKE_TRAPS) {
  chokeJob = id;
  const canonical = (code: number) => {
    const known = knownCode(code);
    const card = cards.get(known);
    return card?.alias && Math.abs(card.alias - known) < 20 && cards.has(card.alias) ? card.alias : known;
  };
  const handCodes = hand.map(canonical);
  const deck = main.map(canonical).filter((code) => cards.has(code));
  for (const code of handCodes) deck.splice(deck.indexOf(code), 1);
  const extraCodes = extra.map(canonical).filter((code) => cards.has(code));
  const trapCodes = [...new Set(traps.map(canonical))].filter((code) => cards.has(code));
  await prefetchScripts([...handCodes, ...deck, ...extraCodes, ...trapCodes]);
  const env = { core, card: (code: number) => cards.get(code) ?? null, script: (name: string) => readScript(name) ?? "", name: nameOf, effects: effectsOf, setcodes: (code: number) => cards.get(code)?.setcodes ?? [] };
  const alive = () => chokeJob === id;
  const singles = await drive(chokePoints(env, handCodes, deck, extraCodes, keys, trapCodes, { goal, budget: 250, replans: 2, batch: true }), env, handCodes, deck, extraCodes, alive);
  if (!singles) return;
  // then the hand traps the opponent holds together, if more than one
  if (combo.length < 2) return send({ type: "choke", id, done: singles });
  const together = await drive(chokeCombo(env, handCodes, deck, extraCodes, keys, combo.map(canonical), { goal, budget: 250, batch: true }), env, handCodes, deck, extraCodes, alive);
  if (together) send({ type: "choke", id, done: singles, combo: together });
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
      await loadBanlist();
      send({ type: "ready", cards: cards.size, banlist });
    } else if (message.type === "start") {
      await start(message);
    } else if (message.type === "answer") {
      choose(message.picks);
    } else if (message.type === "views") {
      const { picks, type: _type, id, reveal, ...options } = message;
      collect = [];
      revealAll = !!reveal;
      try {
        await start(options);
        const marks = [collect.length];
        for (const pick of picks) {
          if (!choose(pick)) break;
          marks.push(collect.length);
        }
        send({ type: "views", id, views: collect, marks });
      } finally {
        collect = null;
        revealAll = false;
      }
    } else if (message.type === "jump") {
      const { picks, type: _type, ...options } = message;
      quiet = true;
      try {
        await start(options);
        for (const pick of picks) if (!choose(pick)) break;
      } finally {
        quiet = false;
      }
      events = [];
      sendView();
      if (record) send({ type: "record", record });
    } else if (message.type === "search") {
      send({ type: "search", id: message.id, ...search(message.search) });
    } else if (message.type === "info") {
      const found = message.codes.flatMap((asked) => {
        const card = infoOf(knownCode(asked));
        return card ? [{ ...card, asked }] : [];
      });
      send({ type: "info", cards: found });
    } else if (message.type === "probe") {
      void runProbe(message.id, message.main, message.extra).catch((error) => send({ type: "error", text: `Engine check stopped: ${error instanceof Error ? error.message : error}` }));
    } else if (message.type === "route") {
      void runRoute(message.id, message.main, message.extra, message.hand, message.targets, message.prior, message.goal).catch((error) =>
        send({ type: "error", text: `Route search stopped: ${error instanceof Error ? error.message : error}` }),
      );
    } else if (message.type === "cut") {
      // each line as recorded, then with one copy of the card gone from the deck (from the hand, if the line held it)
      const canonical = (code: number) => {
        const known = knownCode(code);
        const card = cards.get(known);
        return card?.alias && Math.abs(card.alias - known) < 20 && cards.has(card.alias) ? card.alias : known;
      };
      const cut = canonical(message.cut);
      const main = message.main.map(canonical).filter((code) => cards.has(code));
      const extra = message.extra.map(canonical).filter((code) => cards.has(code));
      await prefetchScripts([...main, ...extra, 14558127]);
      const env = { core, card: (code: number) => cards.get(code) ?? null, script: (name: string) => readScript(name) ?? "", name: nameOf, effects: effectsOf, setcodes: (code: number) => cards.get(code)?.setcodes ?? [] };
      const without = (list: number[], code: number) => {
        const at = list.indexOf(code);
        return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)];
      };
      const run = (hand: number[], deckCards: number[], keys: string[]) => {
        let deck = [...deckCards];
        for (const code of hand) deck = without(deck, code);
        // the hand trap is never used: this is the line's board on its own (Ash only stands in for the opponent)
        return playAgainst(env, hand, deck, extra, keys, 14558127, -1);
      };
      const lines = message.lines.map((line) => {
        const hand = line.hand.map(canonical);
        const before = run(hand, main, line.keys);
        // the card cut: gone from the hand if the line held it, else from the deck
        const after = hand.includes(cut) ? run(without(hand, cut), without(main, cut), line.keys) : run(hand, without(main, cut), line.keys);
        return { start: line.start, before: before.interruptions, after: after.interruptions, board: after.board };
      });
      send({ type: "cut", id: message.id, cut: message.cut, lines });
    } else if (message.type === "traits") {
      send({ type: "traits", traits: message.codes.map((code) => [code, traitsOf(knownCode(code))]) });
    } else if (message.type === "names") {
      send({ type: "names", id: message.id, cards: message.names.map(cardByName) });
    } else if (message.type === "interruptions") {
      const canonical = (code: number) => {
        const known = knownCode(code);
        const card = cards.get(known);
        return card?.alias && Math.abs(card.alias - known) < 20 && cards.has(card.alias) ? card.alias : known;
      };
      const pieces = message.pieces.map((piece) => ({ ...piece, code: canonical(piece.code) }));
      await prefetchScripts(pieces.map((piece) => piece.code));
      const left = message.startHand.map(canonical);
      const built = pieces.filter((piece) => {
        if (piece.location !== OcgLocation.HAND) return true;
        const at = left.indexOf(piece.code);
        if (at < 0) return true;
        left.splice(at, 1);
        return false;
      });
      const spells = pieces.filter((piece) => piece.location === OcgLocation.SZONE).length;
      const list = interruptionsOf(built, effectsOf, (code) => cards.get(code)?.setcodes ?? [], isFirstTurnHandTrap, Math.max(0, 5 - spells), (code) => cards.get(code) ?? null);
      const used = (message.used ?? []).map((one) => ({ ...one, code: canonical(one.code) }));
      await prefetchScripts(used.map((one) => one.code));
      // Nibiru: what was ready right after your 5th summon (the field and the hand; a Trap Set this turn can't be used)
      let nibiru: NibiruCheck | undefined;
      if (message.summons !== undefined) {
        const fifth = (message.fifth ?? []).map((piece) => ({ ...piece, code: canonical(piece.code) })).filter((piece) => piece.location !== OcgLocation.SZONE);
        await prefetchScripts(fifth.map((piece) => piece.code));
        const held = message.startHand.map(canonical);
        const ready = fifth.filter((piece) => {
          if (piece.location !== OcgLocation.HAND) return true;
          const at = held.indexOf(piece.code);
          if (at < 0) return true;
          held.splice(at, 1);
          return false;
        });
        const stopper = message.summons >= 5 ? nibiruStopper(interruptionsOf(ready, effectsOf, (code) => cards.get(code)?.setcodes ?? [], isFirstTurnHandTrap, 0)) : undefined;
        nibiru = { summons: message.summons, proof: message.summons < 5 || !!stopper, by: stopper?.code };
      }
      send({ type: "interruptions", id: message.id, list, protection: protectionOf(used), nibiru });
    } else if (message.type === "choke") {
      void runChoke(message.id, message.main, message.extra, message.hand, message.keys, message.goal, message.combo, message.traps).catch((error) =>
        send({ type: "error", text: `Hand trap check stopped: ${error instanceof Error ? error.message : error}` }),
      );
    } else if (message.type === "text") {
      // YGO Omega's own artwork numbers read as the card they are
      const known = knownCode(message.code);
      send({ type: "text", card: { code: message.code, name: nameOf(known), line: cardLine(known), text: texts.get(known) ?? "" } });
    }
  } catch (error) {
    send({ type: "error", text: error instanceof Error ? error.message : String(error) });
  }
};
