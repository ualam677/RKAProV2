// Runs the engine probe (src/engine/probe.ts) on a deck outside the browser.
// Usage: node --experimental-sqlite tools/probe-deck.mjs <cards.cdb> <CardScripts folder> <YGO Omega code file> [card name ...]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const [CDB, SCRIPTS, OMEGA, ...only] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { default: createCore } = await import("ocgcore-wasm");
const { probe, probeDeck } = await import(new URL("../src/engine/probe.ts", import.meta.url));

const db = new DatabaseSync(CDB);
const cards = new Map(), names = new Map();
for (const r of db.prepare("select d.id, d.alias, cast(d.setcode as text) setcode, d.type, d.level, d.attribute, cast(d.race as text) race, d.atk, d.def, t.name from datas d join texts t on t.id = d.id").all()) {
  const set = BigInt.asUintN(64, BigInt(r.setcode));
  const setcodes = [0n, 1n, 2n, 3n].map((i) => Number((set >> (16n * i)) & 0xffffn)).filter(Boolean);
  const link = (r.type & 0x4000000) !== 0;
  cards.set(r.id, { code: r.id, alias: r.alias, setcodes, type: r.type, level: r.level & 0xff, attribute: r.attribute, race: BigInt.asUintN(64, BigInt(r.race)),
    attack: r.atk, defense: link ? 0 : r.def, lscale: (r.level >> 24) & 0xff, rscale: (r.level >> 16) & 0xff, link_marker: link ? r.def : 0 });
  names.set(r.id, r.name);
}
const known = (code) => { const c0 = cards.get(code); if (c0) return c0.alias && Math.abs(c0.alias - code) < 20 && cards.has(c0.alias) ? c0.alias : code; for (let o = 1; o < 10; o++) { const c = cards.get(code - o); if (c) return c.alias && cards.has(c.alias) ? c.alias : code - o; } return code; };
const scriptCache = new Map();
const script = (name) => {
  name = path.basename(name);
  if (scriptCache.has(name)) return scriptCache.get(name);
  let text = "";
  for (const folder of ["", "official", "pre-release", "unofficial"]) {
    const file = path.join(SCRIPTS, folder, name);
    if (fs.existsSync(file)) { text = fs.readFileSync(file, "utf8"); break; }
  }
  if (!text && /^c\d+\.lua$/.test(name)) { const alias = cards.get(Number(name.slice(1, -4)))?.alias; if (alias) text = script(`c${alias}.lua`); }
  scriptCache.set(name, text);
  return text;
};
const wasmBinary = fs.readFileSync(require.resolve("ocgcore-wasm/lib/ocgcore.sync.wasm"));
const core = await createCore({ sync: true, wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) });
if (process.env.OVERLAY) {
  const get = core.duelGetMessage.bind(core);
  let shown = 0;
  core.duelGetMessage = (duel) => {
    const messages = get(duel);
    for (const m of messages) if (m.type === 14 && shown < 6) { shown++; console.log("OPTION", m.player, JSON.stringify(m.options.map(String))); }
    for (const m of messages) if (m.type === 15 && shown < 3 && m.selects.some((c) => c.overlay_sequence !== undefined || c.location & 0x80)) {
      shown++;
      console.log("OVERLAY PICK", JSON.stringify(m.selects.map((c) => ({ code: c.code, location: c.location, sequence: c.sequence, overlay_sequence: c.overlay_sequence }))), "min", m.min, "max", m.max);
    }
    return messages;
  };
}
const { readEffects, readSetConstants } = await import(new URL("../src/engine/interruptions.ts", import.meta.url));
const sets = readSetConstants(script("archetype_setcode_constants.lua"), script("constant.lua"));
const effectCache = new Map();
const env = {
  core, card: (code) => cards.get(code) ?? null, script, name: (code) => names.get(code) ?? `#${code}`,
  effects: (code) => { if (!effectCache.has(code)) effectCache.set(code, readEffects(script(`c${code}.lua`), cards.get(code)?.type ?? 0, sets)); return effectCache.get(code); },
  setcodes: (code) => cards.get(code)?.setcodes ?? [],
};

const raw = zlib.inflateRawSync(Buffer.from(fs.readFileSync(OMEGA, "utf8").trim().split(/\s+/).pop(), "base64"));
const all = Array.from({ length: raw[0] }, (_, i) => known(raw.readUInt32LE(2 + 4 * i)));
const unknown = all.filter((c) => !cards.has(c));
if (unknown.length) console.log(`Not in this database, left out: ${unknown.join(", ")}`);
const codes = all.filter((c) => cards.has(c));
const EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;
const main = codes.filter((c) => !(cards.get(c).type & EXTRA)), extra = codes.filter((c) => cards.get(c).type & EXTRA);
const rest = (hand) => { const deck = [...main]; for (const c of hand) deck.splice(deck.indexOf(c), 1); return deck; };
const distinct = [...new Set(main)].filter((c) => !only.length || only.some((n) => names.get(c).toLowerCase().includes(n.toLowerCase())));

console.log(`${main.length} main, ${extra.length} extra\n`);
const t0 = performance.now();
const r0 = probe(env, [distinct[0]], rest([distinct[0]]), extra, { budget: 1 });
console.log(`one branch: ${(performance.now() - t0).toFixed(0)} ms\n`);
for (const code of distinct) {
  const t = performance.now();
  const r = probe(env, [code], rest([code]), extra, { budget: 150, depth: 6 });
  console.log(`${names.get(code).padEnd(34)} deck ${r.deck} extra ${r.extra}  (${r.tried} tried${r.exhausted ? ", all" : ""}, ${(performance.now() - t).toFixed(0)} ms)  ${r.steps.join(" > ")}${r.taken.length ? `  | took ${r.taken.map((c) => names.get(c)).join(", ")}` : ""}`);
}

if (process.env.PAIRS) {
  const t1 = performance.now();
  let last;
  for (const step of probeDeck(env, main, extra)) if (step) last = step;
  console.log(`\nWhole deck, singles and pairs: ${last.done} duels tried in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  for (const e of last.evidence.values()) {
    if (e.alone.deck > 0) console.log(`  START   ${names.get(e.code)}: alone, ${e.alone.deck} new from the Deck, ${e.alone.extra} Extra Deck summons`);
    else if (e.partners.length) console.log(`  PARTNER ${names.get(e.code)} with: ${e.partners.map((c) => names.get(c)).join(", ")}`);
    else console.log(`  none    ${names.get(e.code)} (${e.checked} pairs)`);
  }
}

if (process.env.HAND) {
  const hand = process.env.HAND.split(",").map((n) => [...names].find(([c, name]) => name === n && main.includes(c))[0]);
  const r = probe(env, hand, rest(hand), extra, { budget: 60, depth: 6, untilDeck: true });
  console.log("HAND", process.env.HAND, JSON.stringify({ ...r, taken: r.taken.map((c) => names.get(c)) }));
}

if (process.env.ROUTE) {
  const { routeSearch } = await import(new URL("../src/engine/probe.ts", import.meta.url));
  const hand = process.env.ROUTE.split(",").map((n) => [...names].find(([c, name]) => name === n && main.includes(c))[0]);
  const targets = process.env.TARGET ? [process.env.TARGET.split(",").map((n) => [...names].find(([, name]) => name === n)[0])] : [];
  const t = performance.now();
  // PRIOR_FROM: search that hand first and use its line as guidance (as the app does with other starts' lines)
  let prior = new Set();
  if (process.env.PRIOR_FROM) {
    const other = process.env.PRIOR_FROM.split(",").map((n) => [...names].find(([c, name]) => name === n && main.includes(c))[0]);
    const g = routeSearch(env, other, rest(other), extra, { targets, budget: 2500 });
    let n; while (!(n = g.next()).done);
    prior = new Set(n.value.keys);
    console.log("PRIOR", n.value.interruptions.length, "interruptions from", process.env.PRIOR_FROM.split(",")[0], n.value.keys.join(" "));
  }
  const steps = routeSearch(env, hand, rest(hand), extra, { targets, prior, budget: Number(process.env.BUDGET ?? 2500) });
  let next;
  while (!(next = steps.next()).done);
  const r = next.value;
  console.log(`ROUTE ${(performance.now() - t) / 1000 | 0} s, ${r.tried} tried, full ${r.full}, coverage ${(r.coverage * 100).toFixed(0)}%`);
  console.log("  interruptions:", r.interruptions.map((i) => `${names.get(i.code)} (${i.kind}, ${i.from})`).join("; ") || "none");
  console.log("  board:", r.board.map((c) => names.get(c)).join(", "));
  console.log("  steps:", r.steps.join(" > "));
  console.log("  ui picks:", JSON.stringify(r.ui));
}

if (process.env.PLAN) {
  const { play } = await import(new URL("../src/engine/probe.ts", import.meta.url));
  const hand = process.env.HAND2.split(",").map((n) => [...names].find(([c, name]) => name === n && main.includes(c))[0]);
  const plan = process.env.PLAN ? process.env.PLAN.split(",").filter(Boolean).map(Number) : [];
  for (let n = 0; n <= plan.length; n++) {
    const s = play(env, hand, rest(hand), extra, plan.slice(0, n));
    console.log(`after ${n}: failed=${!!s.failed} board=[${s.board.map((c) => names.get(c))}] options=${JSON.stringify(s.options)}`);
  }
}

if (process.env.CHOKE) {
  const { routeSearch, chokePoints } = await import(new URL("../src/engine/probe.ts", import.meta.url));
  const hand = process.env.CHOKE.split(",").map((n) => [...names].find(([c, name]) => name === n && main.includes(c))[0]);
  const g = routeSearch(env, hand, rest(hand), extra, { targets: [], budget: 2500 });
  let n; while (!(n = g.next()).done);
  console.log(`LINE ${n.value.interruptions.length} interruptions: ${n.value.steps.filter((s) => !s.startsWith("pick")).join(" > ")}`);
  const t = performance.now();
  const c = chokePoints(env, hand, rest(hand), extra, n.value.keys);
  let m; while (!(m = c.next()).done);
  console.log(`choke points in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  for (const one of m.value) {
    const worst = one.windows.reduce((a, w) => (a && a.interruptions <= w.interruptions ? a : w), null);
    console.log(`  ${names.get(one.trap)}: clean ${one.clean}; ${one.windows.length} moments; ` + one.windows.map((w) => `${w.at} -> ${w.interruptions}`).join("; "));
  }
}
