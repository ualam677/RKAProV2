// A saved test as a video: every moment of its replay drawn on a canvas (both fields, the hands, LP, and a caption for
// what just happened), each held as long as the duel screen holds it, recorded with the browser's own video encoder.
// Works on phones too, where screen recording from a page is not available.
import { SOURCES } from "./CardArt";
import { cueTime } from "./Duel";
import type { CardView, DuelEvent, DuelView } from "./engine/protocol";

const W = 720;
const H = 1280;
const CARD_W = 104;
const CARD_H = 152;

const COLOURS: [number, string][] = [
  [0x4000000, "#1d4f9c"], // Link
  [0x800000, "#26272b"], // Xyz
  [0x2000, "#d8d8d8"], // Synchro
  [0x40, "#7b4ea8"], // Fusion
  [0x80, "#3e78c9"], // Ritual
  [0x4, "#b8457c"], // Trap
  [0x2, "#1f8f7a"], // Spell
  [0x1, "#c98a3f"], // Monster
];
const colourOf = (type: number) => COLOURS.find(([bit]) => type & bit)?.[1] ?? "#3a4458";

// card pictures, when the picture server allows a canvas to use them; names otherwise
const art = new Map<number, HTMLImageElement | null>();
function loadArt(code: number): Promise<void> {
  if (!code || art.has(code)) return Promise.resolve();
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => (art.set(code, image), resolve());
    image.onerror = () => (art.set(code, null), resolve());
    image.src = SOURCES[0](code);
    window.setTimeout(() => (art.has(code) || art.set(code, null), resolve()), 4000);
  });
}

function caption(events: DuelEvent[]): string {
  const last = (kind: DuelEvent["kind"]) => events.filter((event) => event.kind === kind).pop();
  const activate = last("activate"), resolve = last("resolve"), summon = last("summon"), phase = last("phase"), negated = last("negated");
  const added = events.filter((event) => event.kind === "added");
  if (negated) return `${negated.name}: negated`;
  if (activate) return `Chain ${activate.chain}: ${activate.name}${activate.text ? ` · ${activate.text}` : ""}`;
  if (added.length) return `Added to hand: ${added.map((card) => card.name).join(", ")}`;
  if (summon) return `Summoned: ${summon.name}`;
  if (resolve) return `Resolving: ${resolve.name}`;
  if (phase) return phase.text ?? "";
  const note = events.find((event) => event.kind === "message" || event.kind === "coin" || event.kind === "dice");
  return note?.text ?? "";
}

function drawCard(g: CanvasRenderingContext2D, card: CardView | null, x: number, y: number, sideways = false) {
  const w = sideways ? CARD_H : CARD_W, h = sideways ? CARD_W : CARD_H;
  const left = x + (CARD_W - w) / 2, top = y + (CARD_H - h) / 2;
  g.strokeStyle = "#23426e";
  g.lineWidth = 2;
  g.strokeRect(x, y, CARD_W, CARD_H);
  if (!card) return;
  const hidden = !card.code;
  g.fillStyle = hidden ? "#5a2a12" : colourOf(card.type);
  g.fillRect(left, top, w, h);
  const image = art.get(card.code);
  if (image) g.drawImage(image, left + 4, top + 4, w - 8, h - 8);
  else if (!hidden) {
    g.fillStyle = "#0b1426";
    g.font = "600 15px system-ui, sans-serif";
    g.textAlign = "center";
    wrap(g, card.name, left + w / 2, top + h / 2 - 16, w - 12, 18, 4);
  }
  if (!hidden && card.attack >= 0 && card.type & 1) {
    g.fillStyle = "rgba(4,10,24,0.85)";
    g.fillRect(left, top + h - 22, w, 22);
    g.fillStyle = "#eaf2ff";
    g.font = "700 14px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(card.type & 0x4000000 ? `${card.attack}` : `${card.attack}/${card.defense}`, left + w / 2, top + h - 6);
  }
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, line: number, lines: number) {
  const words = text.split(" ");
  let row = "", at = 0;
  for (const word of words) {
    const next = row ? `${row} ${word}` : word;
    if (g.measureText(next).width > width && row) {
      g.fillText(row, x, y + at * line);
      row = word;
      if (++at >= lines) return;
    } else row = next;
  }
  if (row) g.fillText(row, x, y + at * line);
}

function draw(g: CanvasRenderingContext2D, view: DuelView, title: string) {
  g.fillStyle = "#03060c";
  g.fillRect(0, 0, W, H);
  const [me, them] = view.players;
  const bar = (label: string, lp: number, y: number, colour: string) => {
    g.fillStyle = "rgba(9,20,42,0.92)";
    g.fillRect(16, y, W - 32, 56);
    g.fillStyle = "#8ea3c4";
    g.font = "600 22px system-ui, sans-serif";
    g.textAlign = "left";
    g.fillText(label, 32, y + 36);
    g.fillStyle = colour;
    g.font = "800 30px system-ui, sans-serif";
    g.textAlign = "right";
    g.fillText(String(lp), W - 32, y + 38);
  };
  bar(`Opponent · hand ${them.hand.length}`, them.lp, 16, "#ff8a7a");
  const zoneX = (index: number) => 40 + index * 130;
  // the opponent's Spells/Traps and monsters, seen from your side (mirrored), then the Extra Monster Zones, then yours
  them.spells.slice(0, 5).forEach((card, index) => drawCard(g, card, zoneX(4 - index), 90));
  them.monsters.slice(0, 5).forEach((card, index) => drawCard(g, card, zoneX(4 - index), 256, !!card && (card.position & 0xc) !== 0));
  const emz = [me.monsters[5] ?? them.monsters[6] ?? null, me.monsters[6] ?? them.monsters[5] ?? null];
  drawCard(g, emz[0], zoneX(1), 422, !!emz[0] && (emz[0].position & 0xc) !== 0);
  drawCard(g, emz[1], zoneX(3), 422, !!emz[1] && (emz[1].position & 0xc) !== 0);
  me.monsters.slice(0, 5).forEach((card, index) => drawCard(g, card, zoneX(index), 588, !!card && (card.position & 0xc) !== 0));
  me.spells.slice(0, 5).forEach((card, index) => drawCard(g, card, zoneX(index), 754));
  bar(`You · deck ${me.deck} · GY ${me.grave.length}`, me.lp, 922, "#5aa0ff");
  // your hand, overlapping as needed
  const hand = me.hand;
  const step = hand.length > 1 ? Math.min(CARD_W + 8, (W - 32 - CARD_W) / (hand.length - 1)) : 0;
  hand.forEach((card, index) => drawCard(g, card, 16 + index * step, 992));
  // what happened
  g.fillStyle = view.turnPlayer === 0 ? "#1a56c0" : "#9c2a20";
  g.fillRect(0, H - 120, W, 120);
  g.fillStyle = "#ffffff";
  g.font = "700 26px system-ui, sans-serif";
  g.textAlign = "center";
  wrap(g, title || `Turn ${view.turn} · ${view.phase}`, W / 2, H - 76, W - 48, 32, 2);
  g.font = "500 18px system-ui, sans-serif";
  g.fillStyle = "rgba(255,255,255,0.8)";
  g.fillText(`Turn ${view.turn} · ${view.turnPlayer === 0 ? "You" : "Opponent"} · ${view.phase} · RKAPro`, W / 2, H - 16);
}

/** Records the moments to a video file; `progress` goes from 0 to 1. Resolves with the file. */
export async function recordVideo(views: DuelView[], progress: (share: number) => void): Promise<{ blob: Blob; extension: string }> {
  const codes = new Set<number>();
  for (const view of views) for (const player of view.players) for (const card of [...player.monsters, ...player.spells, ...player.hand]) if (card?.code) codes.add(card.code);
  await Promise.all([...codes].map(loadArt));
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = canvas.getContext("2d")!;
  draw(g, views[0], "");
  const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((one) => MediaRecorder.isTypeSupported(one)) ?? "";
  if (!("captureStream" in canvas) || !type) throw new Error("This browser can't record video from the page");
  const stream = (canvas as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 3_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start(500);
  let title = "";
  for (let index = 0; index < views.length; index++) {
    const view = views[index];
    title = caption(view.events) || title;
    draw(g, view, title);
    // each moment as long as the duel screen holds it; the last one a little longer
    const hold = index === views.length - 1 ? 2200 : Math.max(450, cueTime(view.events));
    await new Promise((resolve) => window.setTimeout(resolve, hold));
    progress((index + 1) / views.length);
  }
  recorder.stop();
  await stopped;
  return { blob: new Blob(chunks, { type: type.split(";")[0] }), extension: type.startsWith("video/mp4") ? "mp4" : "webm" };
}
