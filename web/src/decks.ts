// Decks kept on this device, and the formats they come in and go out as:
// .ydk (EDOPro), ydke:// links (EDOPro's "copy deck", YGOPRODeck) and YGO Omega deck codes.
import { parseYdk, type Deck } from "./deck";
import type { Tag } from "./optimiser";
import type { CardEvidence } from "./engine/probe";
import type { TestRecord } from "./engine/protocol";
import type { Interruption } from "./engine/interruptions";

// A hand test kept with its deck: enough to replay it exactly, and what it ended on if you said it worked
export interface SavedTest extends TestRecord {
  id: string;
  date: number;
  worked?: boolean;
  // your monsters and Spells/Traps when you said it worked
  board?: number[];
  // the start the optimiser's Test button was testing
  testOf?: number;
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
}

export interface SavedRoute {
  board: number[];
  interruptions?: Interruption[];
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

// What was pasted or opened, without asking which format it is.
export type Imported = { deck: Deck } | { unsplit: { mainAndExtra: number[]; side: number[] } };
export async function importDeck(text: string, fileName = ""): Promise<Imported> {
  const value = text.trim();
  if (fileName.toLowerCase().endsWith(".ydk") || /^#(main|created)/im.test(value)) return { deck: parseYdk(value) };
  if (/^ydke:\/\//i.test(value)) return { deck: parseYdke(value) };
  if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) return { unsplit: await parseOmega(value) };
  throw new Error("Not a deck: paste a .ydk file, a ydke:// link or a YGO Omega code");
}

// Fusion, Synchro, Xyz and Link Monsters go to the Extra Deck
export const EXTRA_TYPES = 0x40 | 0x2000 | 0x800000 | 0x4000000;
