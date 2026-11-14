// Decks kept on this device, and the formats they come in and go out as:
// .ydk (EDOPro), ydke:// links (EDOPro's "copy deck", YGOPRODeck) and YGO Omega deck codes.
import { parseYdk, type Deck } from "./deck";
import type { Tag } from "./optimiser";
import type { CardEvidence } from "./engine/probe";
import type { TestRecord } from "./engine/protocol";
import type { Interruption, Piece } from "./engine/interruptions";
import type { Choke, ChokeCombo } from "./engine/probe";

// A hand test kept with its deck: enough to replay it exactly, and what it ended on if you said it worked
export interface SavedTest extends TestRecord {
  id: string;
  date: number;
  worked?: boolean;
  // your monsters and Spells/Traps when you said it worked
  board?: number[];
  // the start the optimiser's Test button was testing
  testOf?: number;
  // what you had when you said it worked (field with Xyz Materials, hand, GY), and the interruptions it holds
  pieces?: Piece[];
  interruptions?: Interruption[];
}
// working tests are kept; of the rest, the newest few
const KEEP_OTHERS = 30;
export function keepTest(tests: SavedTest[] = [], test: SavedTest): SavedTest[] {
  const next = [test, ...tests.filter((one) => one.id !== test.id)].sort((a, b) => b.date - a.date);
  let others = 0;
  return next.filter((one) => one.worked || ++others <= KEEP_OTHERS);
}

export interface SavedDeck extends Deck {
  id: string;
  name: string;
  updated: number;
  // Deck Optimiser roles, by card (alternate artworks share the original's)
  tags?: Record<string, Tag>;
  // what the engine found each card starts, for the deck as it was (`signature`)
  engine?: { signature: string; evidence: CardEvidence[] };
  tests?: SavedTest[];
  // the line the route search found from each start's test hand, for the deck as it was (`signature`)
  routes?: Record<string, SavedRoute>;
  // a full board: at least this many interruptions (default 3)
  fullAt?: number;
  // the hand traps the opponent holds together when lines are checked (default Ash Blossom and Infinite Impermanence)
  opponentTraps?: number[];
  // save states from the duel menu: the duel's start and every choice up to that moment
  saves?: SavedState[];
  // the file it is kept as in a linked deck folder, and when the two were last the same
  file?: string;
  fileSynced?: number;
}

export interface SavedState {
  id: string;
  name: string;
  date: number;
  record: TestRecord;
}

export interface SavedRoute {
  board: number[];
  interruptions?: Interruption[];
  // the line as steps another search can follow ("Activate:<code>", "pick:<hint>:<code>")
  keys?: string[];
  // each hand trap used at each moment it can be against this line, and what the line ends on then
  chokes?: Choke[];
  // those hand traps together: the order and moments that hurt most
  combo?: ChokeCombo;
  coverage: number;
  full: boolean;
  // whether you had marked any full boards when it searched (without them it aims for the most resources)
  aimed: boolean;
  tried: number;
  date: number;
  signature: string;
  record: TestRecord;
}

// Changes whenever the cards the engine checks change (Main and Extra, any order)
export const deckSignature = (deck: Deck) => `${[...deck.main].sort((a, b) => a - b).join(",")}|${[...deck.extra].sort((a, b) => a - b).join(",")}`;

const KEY = "rka.decks";

export function loadDecks(): SavedDeck[] {
  try {
    const decks = JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedDeck[];
    return Array.isArray(decks) ? decks : [];
  } catch {
    return [];
  }
}

export function storeDecks(decks: SavedDeck[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(decks));
  } catch {
    // storage full or blocked: the decks stay for this visit only
  }
}

// The latest role picked for a card, used for that card in every other deck until told otherwise
const TAGS = "rka.tags";
export function loadTagDefaults(): Record<string, Tag> {
  try {
    return JSON.parse(localStorage.getItem(TAGS) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
export function storeTagDefault(code: number, tag: Tag) {
  try {
    localStorage.setItem(TAGS, JSON.stringify({ ...loadTagDefaults(), [code]: tag }));
  } catch {
    // the tag still lives on the deck
  }
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export function toYdk(deck: Deck): string {
  return ["#created by RKAPro", "#main", ...deck.main, "#extra", ...deck.extra, "!side", ...deck.side, ""].join("\n");
}

// ---- ydke:// : base64 of little-endian 32-bit passcodes, main!extra!side! ----
function fromBase64(text: string): Uint8Array {
  const clean = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(clean + "===".slice((clean.length + 3) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}
const readCodes = (bytes: Uint8Array, from = 0, count = (bytes.length - from) / 4) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, i) => view.getUint32(from + i * 4, true));
};
const writeCodes = (codes: number[]) => {
  const bytes = new Uint8Array(codes.length * 4);
  const view = new DataView(bytes.buffer);
  codes.forEach((code, i) => view.setUint32(i * 4, code, true));
  return bytes;
};

export function parseYdke(link: string): Deck {
  const [main = "", extra = "", side = ""] = link.trim().slice("ydke://".length).split("!");
  const part = (text: string) => (text ? readCodes(fromBase64(text)) : []);
  return { main: part(main), extra: part(extra), side: part(side) };
}

export function toYdke(deck: Deck): string {
  return `ydke://${toBase64(writeCodes(deck.main))}!${toBase64(writeCodes(deck.extra))}!${toBase64(writeCodes(deck.side))}!`;
}

// ---- YGO Omega: base64(raw deflate([main+extra count][side count][32-bit passcodes...])) ----
// Main and Extra come as one list; the caller splits them by card type.
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function parseOmega(code: string): Promise<{ mainAndExtra: number[]; side: number[] }> {
  const raw = await inflate(fromBase64(code));
  const [count, side] = raw;
  // codes taken from replays carry a few more bytes after the list
  if (raw.length < 2 + 4 * (count + side)) throw new Error("This Omega code is cut short");
  const all = readCodes(raw, 2, count + side);
  return { mainAndExtra: all.slice(0, count), side: all.slice(count) };
}

export async function toOmega(deck: Deck): Promise<string> {
  const codes = [...deck.main, ...deck.extra, ...deck.side];
  const raw = new Uint8Array(2 + codes.length * 4);
  raw[0] = deck.main.length + deck.extra.length;
  raw[1] = deck.side.length;
  raw.set(writeCodes(codes), 2);
  return toBase64(await deflate(raw));
}

// ---- card lists by name: "Main: 3 Mulcharmy Fuwalos", "3x Ash Blossom", "Ash Blossom & Joyous Spring x3",
// with or without Main / Extra / Side headings (YGOPRODeck, Master Duel and Neuron text exports, forum posts) ----
export interface ListEntry {
  section: "main" | "extra" | "side" | null;
  count: number;
  name: string;
}
export function parseList(text: string): ListEntry[] {
  const entries: ListEntry[] = [];
  let section: ListEntry["section"] = null;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+/g, " ").trim();
    if (!line || /^(#created|\/\/)/i.test(line)) continue;
    // a heading, alone or in front of the first card: "Main Deck (40):", "Extra:", "Side Deck", "#main"
    // (a heading needs ":", "-", "Deck" or nothing after it, so "Extra Veiler" stays a card)
    const heading = /^[#!]?(main|extra|side)(?:\s*deck)?(?:\s*\(\d+\))?\s*(?::|-|$)\s*(.*)$/i.exec(line) ?? /^[#!]?(main|extra|side)\s+deck\b\s*(.*)$/i.exec(line);
    if (heading) {
      section = heading[1].toLowerCase() as ListEntry["section"];
      line = heading[2].trim();
      if (!line) continue;
    }
    // Master Duel / Neuron group headings carry no cards: "Monster (20)", "Spell Cards", "Traps: 5"
    if (/^(monsters?|spells?|traps?|extra deck monsters?)( cards?)?\s*(\(\d+\)|:\s*\d*)?$/i.test(line)) continue;
    // "3 Ash Blossom", "3x Ash Blossom", "Ash Blossom x3", "Ash Blossom (x3)", "Ash Blossom (3)"
    const front = /^(\d+)\s*[x×*]?\s+(.+)$/i.exec(line);
    const back = /^(.+?)\s*(?:[x×*]\s*(\d+)|\((?:x\s*)?(\d+)\))$/i.exec(line);
    const number = front ? Number(front[1]) : back ? Number(back[2] ?? back[3]) : 0;
    const named = (front ? front[2] : back ? back[1] : "").replace(/^[-*•]\s*/, "").trim();
    if (number > 0 && named) {
      if (number <= 3) entries.push({ section, count: number, name: named });
    } else if (/[a-z]/i.test(line)) entries.push({ section, count: 1, name: line.replace(/^[-*•]\s*/, "") });
  }
  return entries;
}
const looksLikeList = (text: string) => text.split(/\r?\n/).filter((line) => /[a-z]{3}/i.test(line)).length >= 2 || /^(main|extra|side)/i.test(text.trim());

// What was pasted or opened, without asking which format it is.
export type Imported = { deck: Deck } | { unsplit: { mainAndExtra: number[]; side: number[] } } | { list: ListEntry[] };
export async function importDeck(text: string, fileName = ""): Promise<Imported> {
  const value = text.trim();
  if (fileName.toLowerCase().endsWith(".ydk") || /^#(main|created)/im.test(value)) return { deck: parseYdk(value) };
  if (/^ydke:\/\//i.test(value)) return { deck: parseYdke(value) };
  if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) return { unsplit: await parseOmega(value) };
  if (looksLikeList(value)) {
    const list = parseList(value);
    if (list.length) return { list };
  }
  throw new Error("Not a deck: paste a .ydk file, a ydke:// link, a YGO Omega code or a card list (\"3 Ash Blossom & Joyous Spring\")");
}

// Fusion, Synchro, Xyz and Link Monsters go to the Extra Deck
export const EXTRA_TYPES = 0x40 | 0x2000 | 0x800000 | 0x4000000;

// ---- shareable replays: a saved test in a link, compressed after "#replay=" (never sent to any server) ----
const toBase64Url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function replayLink(record: TestRecord): Promise<string> {
  const { options, picks, steps, startHand } = record;
  const text = JSON.stringify({ v: 1, options, picks, steps: steps.map((step) => [step.text, step.idle ? 1 : 0]), startHand });
  const packed = await deflate(new TextEncoder().encode(text));
  return `${location.origin}${location.pathname}#replay=${toBase64Url(packed)}`;
}
export async function readReplayLink(hash: string): Promise<TestRecord | null> {
  const match = /#replay=([A-Za-z0-9_-]+)/.exec(hash);
  if (!match) return null;
  const data = JSON.parse(new TextDecoder().decode(await inflate(fromBase64(match[1])))) as {
    options: TestRecord["options"];
    picks: TestRecord["picks"];
    steps: [string, number][];
    startHand: number[];
  };
  return { options: data.options, picks: data.picks, steps: data.steps.map(([text, idle]) => ({ text, idle: !!idle })), startHand: data.startHand };
}
