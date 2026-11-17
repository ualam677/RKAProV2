// v1 (RKAPro) vs v2 (RKAProV2) optimiser on the user's current Galaxy-Eyes list.
// 1. v1's own code (packages/analysis/odds.ts) on its own model (lines.json).
// 2. v2's formula (gframe/deck_optimizer.h ComputeOdds, ported line for line) with v1's role tags (roles.json).
// 3. Both definitions checked by brute-force simulation of shuffled decks, independent of either implementation.
// 4. Where the two definitions disagree: which hands, how likely.
import fs from "node:fs";
const V1 = process.argv[2];
const { metrics, evalHand, enumerateHands } = await import(`${V1}/packages/analysis/odds.ts`);
const model = JSON.parse(fs.readFileSync(`${V1}/packs/galaxy-eyes/lines.json`, "utf8"));
const roles = JSON.parse(fs.readFileSync(`${V1}/packs/galaxy-eyes/knowledge/roles.json`, "utf8"));
const deck = JSON.parse(fs.readFileSync(`${V1}/packs/galaxy-eyes/deck.json`, "utf8")).main;
const total = Object.values(deck).reduce((a, b) => a + b, 0);
const pct = (x) => (x * 100).toFixed(2) + "%";

// ---- v1, its own code ----
const m1 = metrics(model, deck);
console.log(`Deck: ${total} cards\n`);
console.log("v1 (its own code): going 1st full board", pct(m1.full1), "| partial", pct(m1.partial1), "| brick", pct(m1.brick1), "| Nibiru-proof", pct(m1.nib1));
console.log("                   going 2nd: combo", pct(m1.combo2), "| >=2 hand traps", pct(m1.ht2_2));

// ---- v2, its formula, with v1's tags ----
const C = (n, k) => { if (k < 0 || n < 0 || k > n) return 0; k = Math.min(k, n - k); let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
const tagged = (role) => Object.entries(deck).filter(([n]) => (roles[n] ?? []).includes(role)).reduce((a, [, k]) => a + k, 0);
const starters = tagged("Starter"), handtraps = tagged("Hand Trap"), dead = 0; // v1 tagged no bricks
function v2Playable(hand) {
  const rest = total - starters - dead; let sum = 0;
  for (let s = 1; s <= Math.min(starters, hand); s++) for (let d = 0; d <= Math.min(dead, 1, hand - s); d++) sum += C(starters, s) * C(dead, d) * C(rest, hand - s - d);
  return sum / C(total, hand);
}
console.log(`\nv2 (deck_optimizer.h) with v1's tags: ${starters} starters, ${handtraps} hand traps, 0 bricks`);
console.log("                   going 1st playable", pct(v2Playable(5)), "| going 2nd playable", pct(v2Playable(6)));

// ---- independent check: deal shuffled decks ----
const cards = Object.entries(deck).flatMap(([n, k]) => Array(k).fill(n));
const isStarter = (n) => (roles[n] ?? []).includes("Starter");
// xorshift128+ in BigInt-free 32-bit pieces (xorshift32 twice): uniform enough, and exact in JS numbers
let a = 0x9e3779b9 | 0, b = 0x243f6a88 | 0;
const next32 = () => { let t = a ^ (a << 11); a = b; b = (b ^ (b >>> 19)) ^ (t ^ (t >>> 8)); return b >>> 0; };
const rnd = () => (next32() * 4294967296 + next32()) / 18446744073709551616;
const N = 2_000_000; let v1full = 0, v1brick = 0, v2ok = 0;
for (let t = 0; t < N; t++) {
  const h = {};
  const pool = cards.slice();
  for (let i = 0; i < 5; i++) { const j = i + Math.floor(rnd() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; h[pool[i]] = (h[pool[i]] ?? 0) + 1; }
  const e = evalHand(model, h);
  if (e && e.board >= model.fullBoard) v1full++;
  if (!e) v1brick++;
  if (Object.keys(h).some(isStarter)) v2ok++;
}
console.log(`\nSimulation, ${N.toLocaleString()} shuffled 5-card hands: v1 full board ${pct(v1full / N)}, v1 brick ${pct(v1brick / N)}, v2 playable ${pct(v2ok / N)}`);

// ---- where they disagree ----
const diff = { v1only: new Map(), v2only: new Map() };
const key = (h) => Object.entries(h).sort().map(([n, k]) => (k > 1 ? `${k}x ${n}` : n)).join(" + ");
for (const { h, p } of enumerateHands(deck, 5)) {
  const e = evalHand(model, h);
  const full = !!e && e.board >= model.fullBoard;
  const play = Object.keys(h).some(isStarter);
  const why = full && !play ? `v1 full via "${e.line}", no tagged starter` : !full && play ? (e ? `v1: only "${e.line}" (board ${e.board} < ${model.fullBoard})` : `v1: no verified line`) : null;
  if (!why) continue;
  const bucket = full ? diff.v1only : diff.v2only;
  // group by the starter / line, not by every filler card
  const starterCards = Object.keys(h).filter(isStarter).sort().join(" + ");
  const k = full ? why : `${starterCards} | ${why}`;
  const row = bucket.get(k) ?? { p: 0, example: key(h) };
  row.p += p; bucket.set(k, row);
}
const show = (title, map) => {
  const rows = [...map.entries()].sort((a, b) => b[1].p - a[1].p);
  console.log(`\n${title}: ${pct(rows.reduce((a, [, r]) => a + r.p, 0))} of hands`);
  for (const [k, r] of rows.slice(0, 12)) console.log(`  ${pct(r.p).padStart(7)}  ${k}\n           e.g. ${r.example}`);
};
show("v1 says full board, v2 says not playable", diff.v1only);
show("v2 says playable, v1 says no full board", diff.v2only);
