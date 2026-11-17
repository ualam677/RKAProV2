/// <reference lib="webworker" />
// A helper for the searches: it holds the card data and scripts the engine worker hands it, and plays tries (a hand
// and a plan of choices from the start of the duel) on its own copy of the core, so several are played at once.

import createCore, { type OcgCardData, type OcgCoreSync } from "ocgcore-wasm";
import coreWasmUrl from "ocgcore-wasm/lib/ocgcore.sync.wasm?url";
import { readEffects, readSetConstants, type QuickEffect } from "./interruptions";
import { play, playAgainst, probe, type Against, type FollowJob, type FollowResult, type ProbeOptions, type ProbeResult, type Stop } from "./probe";

export type ToHelper =
  | { type: "init"; cards: [number, OcgCardData][]; names: [number, string][]; scripts: [string, string | null][]; scriptsUrl: string }
  | { type: "scripts"; scripts: [string, string | null][] }
  | { type: "plays"; id: number; hand: number[]; deck: number[]; extra: number[]; against?: Against | Against[]; plans: number[][] }
  | { type: "follows"; id: number; hand: number[]; deck: number[]; extra: number[]; jobs: FollowJob[] }
  | { type: "probes"; id: number; extra: number[]; probes: { hand: number[]; deck: number[]; options: ProbeOptions }[] };
export type FromHelper = { type: "ready" } | { type: "plays"; id: number; stops: Stop[] } | { type: "follows"; id: number; results: FollowResult[] } | { type: "probes"; id: number; results: ProbeResult[] } | { type: "error"; id: number; text: string };

let core: OcgCoreSync | null = null;
const cards = new Map<number, OcgCardData>();
const names = new Map<number, string>();
const scripts = new Map<string, string | null>();
let scriptsUrl = "";

// a script the engine worker had not fetched yet: fetched here the same way (a blocking request)
function readScript(path: string): string | null {
  const name = path.split("/").pop()!;
  if (scripts.has(name)) return scripts.get(name)!;
  const folders = /^c\d+\.lua$/.test(name) ? ["official", "pre-release", "unofficial"] : [""];
  let source: string | null = null;
  for (const folder of folders) {
    const request = new XMLHttpRequest();
    request.open("GET", `${scriptsUrl}/${folder ? folder + "/" : ""}${name}`, false);
    try {
      request.send();
    } catch {
      continue;
    }
    if (request.status === 200) {
      source = request.responseText;
      break;
    }
  }
  if (source === null && name.startsWith("c")) {
    const alias = cards.get(Number(name.slice(1, -4)))?.alias;
    if (alias) source = readScript(`c${alias}.lua`);
  }
  scripts.set(name, source);
  return source;
}

const send = (message: FromHelper) => postMessage(message);

// what each card can do on the opponent's turn, read from its script as the engine worker does: boards are counted here
const quickEffects = new Map<number, QuickEffect[]>();
let setConstants: Map<string, number> | null = null;
function effectsOf(code: number): QuickEffect[] {
  setConstants ??= readSetConstants(readScript("archetype_setcode_constants.lua") ?? "", readScript("constant.lua") ?? "");
  if (!quickEffects.has(code)) quickEffects.set(code, readEffects(readScript(`c${code}.lua`) ?? "", cards.get(code)?.type ?? 0, setConstants));
  return quickEffects.get(code)!;
}

self.onmessage = async (event: MessageEvent<ToHelper>) => {
  const message = event.data;
  if (message.type === "init") {
    for (const [code, card] of message.cards) cards.set(code, card);
    for (const [code, name] of message.names) names.set(code, name);
    for (const [name, text] of message.scripts) scripts.set(name, text);
    scriptsUrl = message.scriptsUrl;
    core = await createCore({ sync: true, wasmBinary: await (await fetch(coreWasmUrl)).arrayBuffer() });
    send({ type: "ready" });
  } else if (message.type === "scripts") {
    for (const [name, text] of message.scripts) if (!scripts.has(name)) scripts.set(name, text);
  } else if (message.type === "plays" || message.type === "follows" || message.type === "probes") {
    try {
      const env = { core: core!, card: (code: number) => cards.get(code) ?? null, script: (name: string) => readScript(name) ?? "", name: (code: number) => names.get(code) ?? (code ? `#${code}` : ""), effects: effectsOf, setcodes: (code: number) => cards.get(code)?.setcodes ?? [] };
      if (message.type === "probes") send({ type: "probes", id: message.id, results: message.probes.map((one) => probe(env, one.hand, one.deck, message.extra, one.options)) });
      else if (message.type === "plays") send({ type: "plays", id: message.id, stops: message.plans.map((plan) => play(env, message.hand, message.deck, message.extra, plan, message.against)) });
      else send({ type: "follows", id: message.id, results: message.jobs.map((job) => playAgainst(env, message.hand, message.deck, message.extra, job.keys, job.trap, job.at, job.fixed)) });
    } catch (error) {
      send({ type: "error", id: message.id, text: error instanceof Error ? error.message : String(error) });
    }
  }
};
