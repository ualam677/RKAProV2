// Checks src/optimiser.ts on the Galaxy-Eyes list from RKAPro v1, three independent ways:
//  1. v1's own exact code (packages/analysis/odds.ts) on its own model (lines.json)
//  2. a deliberately naive evaluator, written separately here, over every distinct hand (no grouping of cards)
//  3. shuffled decks, dealt and judged one hand at a time
// Usage: node --experimental-sqlite tools/check-optimiser.mjs <path to rkapro v1> <path to cards.cdb>
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const [V1, CDB] = process.argv.slice(2);
const opt = await import(new URL("../src/optimiser.ts", import.meta.url));
const { metrics, enumerateHands } = await import(`${V1}/packages/analysis/odds.ts`);
const model = JSON.parse(fs.readFileSync(`${V1}/packs/galaxy-eyes/lines.json`, "utf8"));
const list = JSON.parse(fs.readFileSync(`${V1}/packs/galaxy-eyes/deck.json`, "utf8")).main;
const db = new DatabaseSync(CDB);
const pct = (x) => (x * 100).toFixed(2) + "%";

// the deck as the web app sees it: codes, facts from the database, tags from the built-in guesses
const cards = Object.entries(list).map(([name, count]) => {
  const row = db.prepare("select d.id code, d.type, d.attribute, d.level from datas d join texts t on t.id = d.id where t.name = ? and d.alias = 0").get(name);
  return { name, code: row.code, count, facts: { type: row.type, attribute: row.attribute, level: row.level & 0xff }, tag: opt.guessTag(row.code) ?? { role: "other" } };
});
console.log("Tags:", cards.map((c) => `${c.name}=${c.tag.role}`).join(", "), "\n");

const first = opt.computeOdds(cards, 5), second = opt.computeOdds(cards, 6);
const v1 = metrics(model, list);
console.log("                       optimiser   v1 code");
console.log("1st: open a combo      ", pct(first.combo).padStart(8), "  ", pct(1 - v1.brick1).padStart(8));
console.log("1st: combo + 1 HT      ", pct(first.comboHandtrap).padStart(8), "  ", pct(v1.full_1ht + 0).padStart(8), "(v1: full boards only)");
console.log("1st: combo + 2 HT      ", pct(first.comboHandtrap2).padStart(8), "  ", pct(v1.full_2ht).padStart(8));
console.log("2nd: open a combo      ", pct(second.combo).padStart(8), "  ", pct(v1.combo2).padStart(8));
console.log("2nd: >=1 / >=2 HT      ", pct(second.handtrap).padStart(8), pct(second.handtrap2), "  ", pct(v1.ht2_1), pct(v1.ht2_2));

// ---- naive evaluator: card by card, no groups ----
const byName = new Map(cards.map((c) => [c.name, c]));
function naive(hand, second) {
  const held = Object.entries(hand).flatMap(([name, k]) => Array(k).fill(byName.get(name)));
  const usable = (c) => c.tag.role === "handtrap" || (second && c.tag.role === "handtrap2");
  const hts = held.filter(usable).length;
  if (held.some((c) => c.tag.role === "starter")) return { combo: true, hts };
  let best = null;
  held.forEach((c, i) => {
    if (c.tag.role !== "pair") return;
    held.forEach((p, j) => {
      if (i === j || !opt.matchesPartner(c.tag.with, p)) return;
      const left = hts - (usable(p) ? 1 : 0);
      if (best === null || left > best) best = left;
    });
  });
  return best === null ? { combo: false, hts } : { combo: true, hts: best };
}
const exact = { combo: 0, ht1: 0, ht2: 0 };
for (const { h, p } of enumerateHands(list, 5)) {
  const r = naive(h, false);
  if (r.combo) { exact.combo += p; if (r.hts >= 1) exact.ht1 += p; if (r.hts >= 2) exact.ht2 += p; }
}
console.log("\nNaive, every hand:      combo", pct(exact.combo), "| +1 HT", pct(exact.ht1), "| +2 HT", pct(exact.ht2));

// ---- simulation ----
const deck = cards.flatMap((c) => Array(c.count).fill(c.name));
let a = 0x9e3779b9 | 0, b = 0x243f6a88 | 0;
const next32 = () => { let t = a ^ (a << 11); a = b; b = (b ^ (b >>> 19)) ^ (t ^ (t >>> 8)); return b >>> 0; };
const rnd = () => (next32() * 4294967296 + next32()) / 18446744073709551616;
const N = 1_000_000; const sim = { combo: 0, ht1: 0, ht2: 0 };
for (let t = 0; t < N; t++) {
  const pool = deck.slice(); const h = {};
  for (let i = 0; i < 5; i++) { const j = i + Math.floor(rnd() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; h[pool[i]] = (h[pool[i]] ?? 0) + 1; }
  const r = naive(h, false);
  if (r.combo) { sim.combo++; if (r.hts >= 1) sim.ht1++; if (r.hts >= 2) sim.ht2++; }
}
console.log(`Simulated, ${N.toLocaleString()} hands: combo`, pct(sim.combo / N), "| +1 HT", pct(sim.ht1 / N), "| +2 HT", pct(sim.ht2 / N));

// ---- where v1 keeps fewer hand traps: it picks the biggest board, even when that spends one ----
let v1spends = 0;
const { evalHand } = await import(`${V1}/packages/analysis/odds.ts`);
for (const { h, p } of enumerateHands(list, 5)) {
  const e = evalHand(model, h);
  if (e?.spendsHandTrap && Object.keys(h).some((n) => byName.get(n).tag.role === "starter")) v1spends += p;
}
console.log(`\nHands where v1 spends a hand trap as Soldier's discard although a lone starter was there: ${pct(v1spends)}`);

const t0 = performance.now();
const side = new Set();
const swaps = opt.bestSwaps(cards, cards, "comboHandtrap", (code) => 3 - cards.find((c) => c.code === code).count, side);
console.log(`\nBest swaps for combo + hand trap (${(performance.now() - t0).toFixed(0)} ms):`);
const show = (s) => `1st ${pct(s.first.comboHandtrap)}, 2nd ${pct(s.second.comboHandtrap)}`;
for (const s of swaps) console.log(`  -1 ${cards.find((c) => c.code === s.cut).name}, +1 ${cards.find((c) => c.code === s.add).name}: ${show(s.before)} -> ${show(s.after)}`);
const cut = opt.bestCuts(cards, "comboHandtrap");
const cut2 = opt.bestCuts(cards, "combo");
console.log(`Cut to 40 for combo: ${cut2.cuts.map((code) => cards.find((c) => c.code === code).name).join(", ")}: ${pct(cut2.before.first.combo)} -> ${pct(cut2.after.first.combo)}`);
console.log(`Cut to 40: ${cut.cuts.map((code) => cards.find((c) => c.code === code).name).join(", ")}: ${show(cut.before)} -> ${show(cut.after)}`);
