import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseYdk, shuffled } from "./deck";
import { Duel, cueTime } from "./Duel";
import { DeckEditor } from "./DeckEditor";
import { CardArt, setArtworkOriginals } from "./CardArt";
import { EXTRA_TYPES, deckSignature, importDeck, keepTest, loadDecks, newId, storeDecks, type SavedDeck, type SavedTest, type TestResult } from "./decks";
import type { CardInfo, CardSearch, CardText, DuelView, FromWorker, TestRecord, ToWorker } from "./engine/protocol";
import type { Piece } from "./engine/interruptions";
import { CHOKE_TRAPS } from "./engine/probe";
import { hasRole, secondOnly } from "./optimiser";
import { Tests } from "./Tests";
import { canLinkFolder, downloadBackup, driveDownload, driveReady, driveUpload, linkFolder, linkedFolder, makeBackup, mergeBackup, readFolder, unlinkFolder, writeFolderFile } from "./sync";
import { readReplayLink, replayLink, toYdk } from "./decks";
import { recordVideo } from "./video";
import "./style.css";

// EDOPro's card back, from Project Ignis like the scripts and card data; every face-down card uses it
const COVER_URL = import.meta.env.VITE_COVER_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/Distribution/master/textures/cover.png";
document.documentElement.style.setProperty("--cover", `url("${COVER_URL}")`);

// works offline once opened online (public/sw.js); not in development, where it would serve stale code
if (import.meta.env.PROD && "serviceWorker" in navigator) void navigator.serviceWorker.register("./sw.js").catch(() => {});
// the browser's own "install this app" offer, kept for the Install button
let installOffer: (Event & { prompt(): Promise<void> }) | null = null;
const installListeners = new Set<() => void>();
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installOffer = event as typeof installOffer;
  installListeners.forEach((listener) => listener());
});

// hand test settings, remembered on this device only
const SAVED = "rka.handtest";
// the rules boards are counted by (negate types, rank-ups, once per turn by name, protection): older counts are redone
const COUNTING = 2;
interface Saved {
  deckId: string;
  hand: number;
  chosen: number[];
  ignoreHandTraps: boolean;
  // the computer opponent: "none", "copy" (of the deck being tested) or a saved deck's id
  opponent?: string;
  opponentHandTraps?: boolean;
  // the opponent opens with the deck's chosen hand traps (the ones Optimise checks against), not random draws
  fixedTraps?: boolean;
  goSecond?: boolean;
  // before decks were saved in a list, the last opened .ydk was kept here
  deckText?: string;
  deckName?: string;
}
function loadSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(SAVED) ?? "{}");
  } catch {
    return {};
  }
}
function save(value: Saved) {
  try {
    localStorage.setItem(SAVED, JSON.stringify(value));
  } catch {
    // private mode or storage full: settings just are not remembered
  }
}

function startingDecks(saved: Partial<Saved>): SavedDeck[] {
  const decks = loadDecks();
  if (decks.length || !saved.deckText) return decks;
  // the deck opened before the deck list existed becomes the first saved deck
  return [{ ...parseYdk(saved.deckText), id: newId(), name: saved.deckName || "My deck", updated: Date.now() }];
}

// The start a test was for: the Test button's card, else the first card in the hand tagged (or found by the engine) as one
function startOf(owner: SavedDeck, hand: number[], testOf?: number): number | undefined {
  const starter = (code: number) => ["starter", "pair"].includes(owner.tags?.[code]?.role ?? "") || !!owner.engine?.evidence.some((entry) => entry.code === code && entry.alone.deck > 0);
  return testOf ?? hand.find(starter);
}

function App() {
  const worker = useRef<Worker | null>(null);
  const saved = useMemo(loadSaved, []);
  const [status, setStatus] = useState("Starting");
  const [ready, setReady] = useState(false);
  const [decks, setDecks] = useState<SavedDeck[]>(() => startingDecks(saved));
  const decksRef = useRef(decks);
  decksRef.current = decks;
  const [deckId, setDeckId] = useState(saved.deckId ?? decks[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  // "Install app": shown when the browser offers it (Chrome / Edge / Android); iPhone uses Share > Add to Home Screen
  const [canInstall, setCanInstall] = useState(!!installOffer);
  useEffect(() => {
    const listener = () => setCanInstall(true);
    installListeners.add(listener);
    return () => void installListeners.delete(listener);
  }, []);
  // the main menu, or one of its sections
  const [screen, setScreen] = useState<"menu" | "decks" | "test" | "replays" | "sync">("menu");
  // the editor opens on the deck (Edit deck) or on the optimiser (Optimise)
  const openEditor = (optimise: boolean) => {
    try {
      sessionStorage.setItem("rka.optimising", optimise ? "1" : "0");
    } catch {
      // the editor opens on the deck
    }
    setEditing(true);
  };
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [hand, setHand] = useState(saved.hand ?? 5);
  const [chosen, setChosen] = useState<number[]>(saved.chosen ?? []);
  const [ignoreHandTraps, setIgnoreHandTraps] = useState(saved.ignoreHandTraps ?? false);
  const [opponent, setOpponent] = useState(saved.opponent ?? "copy");
  const [opponentHandTraps, setOpponentHandTraps] = useState(saved.opponentHandTraps ?? false);
  const [fixedTraps, setFixedTraps] = useState(saved.fixedTraps ?? true);
  const [goSecond, setGoSecond] = useState(saved.goSecond ?? false);
  const [view, setView] = useState<DuelView | null>(null);
  const [texts, setTexts] = useState(new Map<number, CardText>());
  const [cards, setCards] = useState(new Map<number, CardInfo>());
  // what each card does for deckbuilding (read by the worker from its text)
  const [traits, setTraits] = useState(new Map<number, string[]>());
  // the cut test on screen: a card, and what each of your lines loses without it
  const [cutResult, setCutResult] = useState<{ id: number; deckId: string; cut: number; lines?: { start: number; before: number; after: number; board: number[] }[] } | null>(null);
  const cutTest = (target: SavedDeck, cut: number) => {
    const lines = Object.entries(target.routes ?? {}).flatMap(([start, route]) => (route.source === "replay" && route.keys ? [{ start: Number(start), hand: route.record.startHand, keys: route.keys }] : []));
    const id = (cutResult?.id ?? 0) + 1;
    setCutResult({ id, deckId: target.id, cut });
    post({ type: "cut", id, main: target.main, extra: target.extra, cut, lines });
  };
  // card pictures: an alternate artwork the picture servers lack shows the original card's picture
  setArtworkOriginals((code) => {
    const card = cards.get(code);
    return card?.alias && Math.abs(card.alias - code) < 20 ? card.alias : code;
  });
  const [banlist, setBanlist] = useState<{ name: string; limits: Record<number, number> }>({ name: "", limits: {} });
  const [error, setError] = useState("");
  const deck = decks.find((one) => one.id === deckId) ?? decks[0] ?? null;
  // the engine checking a deck's cards in the background (one deck at a time; a newer request replaces it)
  const [probe, setProbe] = useState<{ id: number; deckId: string; signature: string; done: number; total: number } | null>(null);
  const probeRef = useRef(probe);
  probeRef.current = probe;
  // the hand test on screen, saved with its deck as it is played (not while a saved one is being watched)
  // `from`: choices replayed from a saved test, not saved again until you make one of your own
  const test = useRef<{ id: string; deckId: string; date: number; testOf?: number; worked?: boolean; board?: number[]; pieces?: Piece[]; from: number } | null>(null);
  const [record, setRecord] = useState<TestRecord | null>(null);
  const lastRecord = useRef<TestRecord | null>(null);
  const [worked, setWorked] = useState(false);
  // watching a saved test: its choices are made one by one; any tap of yours takes over from there
  const [replay, setReplay] = useState<{ picks: (number[] | null)[]; at: number } | null>(null);
  const replayRef = useRef(replay);
  replayRef.current = replay;

  const post = (message: ToWorker) => worker.current?.postMessage(message);

  // replies the worker sends back to a request: searches by id, card details in the order they were asked
  const searches = useRef(new Map<number, (result: { results: CardInfo[]; more: boolean }) => void>());
  const searchId = useRef(0);
  const infoWaiting = useRef<((found: (CardInfo & { asked: number })[]) => void)[]>([]);
  const search = useCallback(
    (query: CardSearch) =>
      new Promise<{ results: CardInfo[]; more: boolean }>((resolve) => {
        const id = ++searchId.current;
        searches.current.set(id, resolve);
        post({ type: "search", id, search: query });
      }),
    [],
  );
  // deck list names to cards, in the order asked
  const namesWaiting = useRef(new Map<string, (cards: (CardInfo | null)[]) => void>());
  const names = useCallback(
    (list: string[]) =>
      new Promise<(CardInfo | null)[]>((resolve) => {
        const id = newId();
        namesWaiting.current.set(id, resolve);
        post({ type: "names", id, names: list });
      }),
    [],
  );
  const info = useCallback(
    (codes: number[]) =>
      new Promise<(CardInfo & { asked: number })[]>((resolve) => {
        infoWaiting.current.push(resolve);
        post({ type: "info", codes });
      }),
    [],
  );

  // Views sent mid-play are shown one after another, each held only as long as its animation;
  // a tap skips straight to the newest one.
  const queue = useRef<DuelView[]>([]);
  const timer = useRef(0);
  const playNext = useCallback(() => {
    timer.current = 0;
    const next = queue.current.shift();
    if (!next) return;
    setView(next);
    // a view with an animation stays up for it, even if the next view has not arrived yet
    const hold = cueTime(next.events);
    if (hold) timer.current = window.setTimeout(playNext, hold);
    else if (queue.current.length) playNext();
  }, []);
  const receive = useCallback(
    (next: DuelView) => {
      queue.current.push(next);
      if (!timer.current) playNext();
    },
    [playNext],
  );
  const skip = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    const last = queue.current.pop();
    queue.current = [];
    setView((shown) => {
      const latest = last ?? shown;
      return latest && { ...latest, events: [] };
    });
  }, []);

  useEffect(() => {
    const instance = new Worker(new URL("./engine/worker.ts", import.meta.url), { type: "module" });
    worker.current = instance;
    instance.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === "progress") setStatus(message.text);
      else if (message.type === "ready") {
        setReady(true);
        setBanlist(message.banlist);
        setStatus(`${message.cards.toLocaleString()} cards loaded`);
      } else if (message.type === "view") receive(message.view);
      else if (message.type === "record") {
        lastRecord.current = message.record;
        if (!replayRef.current) setRecord(message.record);
      }
      else if (message.type === "text") setTexts((known) => new Map(known).set(message.card.code, message.card));
      else if (message.type === "search") {
        // results are remembered too, so adding one knows whether it belongs in the Extra Deck
        setCards((known) => {
          const next = new Map(known);
          for (const card of message.results) next.set(card.code, card);
          return next;
        });
        searches.current.get(message.id)?.(message);
        searches.current.delete(message.id);
      } else if (message.type === "info") {
        setCards((known) => {
          const next = new Map(known);
          // a code the database doesn't have (YGO Omega's own alternate artworks) points at the card it stands for
          for (const card of message.cards) next.set(card.asked, { ...card, code: card.asked, alias: card.asked !== card.code ? card.alias || card.code : card.alias });
          return next;
        });
        infoWaiting.current.shift()?.(message.cards);
      } else if (message.type === "route") {
        const job = routingRef.current;
        if (!job || job.id !== message.id) return;
        if (!message.done) return setRouting({ ...job, tried: message.tried });
        const { route, record: line } = message.done;
        setDecks((all) =>
          all.map((one) => {
            if (one.id !== job.deckId) return one;
            const aimed = (one.tests ?? []).some((test) => test.worked && test.board?.length);
            // a second round keeps the earlier line if it was better
            const before = one.routes?.[job.code];
            if (before && before.signature === deckSignature(one) && (before.interruptions?.length ?? 0) >= route.interruptions.length && before.date > job.started) return one;
            const saved = { keys: route.keys, board: route.board, interruptions: route.interruptions, protection: route.protection, nibiru: route.nibiru, coverage: route.coverage, full: route.full, aimed, tried: route.tried, date: Date.now(), signature: deckSignature(one), record: line };
            return { ...one, routes: { ...one.routes, [job.code]: saved } };
          }),
        );
        // on to the next start waiting, if any (a second-round start that already reached a full board is skipped)
        let rest = job.queue;
        const target = decksRef.current.find((one) => one.id === job.deckId);
        while (rest.length && target) {
          const [next, ...after] = rest;
          rest = after;
          const found = next.code === job.code ? message.done.route : target.routes?.[next.code];
          if (next.retry && found && (found.interruptions?.length ?? 0) >= (target.fullAt ?? 3)) continue;
          return searchRoute(target, next.code, next.hand, rest);
        }
        setRouting(null);
        // every line found: now where hand traps hurt each of them
        const done = decksRef.current.find((one) => one.id === job.deckId);
        if (done) window.setTimeout(() => checkChokes(decksRef.current.find((one) => one.id === job.deckId) ?? done, allStarts.current), 50);
      } else if (message.type === "cut") {
        setCutResult((now) => (now && now.id === message.id ? { ...now, lines: message.lines } : now));
      } else if (message.type === "traits") {
        setTraits((known) => new Map([...known, ...message.traits]));
      } else if (message.type === "names") {
        namesWaiting.current.get(message.id)?.(message.cards);
        namesWaiting.current.delete(message.id);
      } else if (message.type === "views") {
        videoWaiting.current.get(message.id)?.({ views: message.views, marks: message.marks });
        videoWaiting.current.delete(message.id);
      } else if (message.type === "interruptions" && message.id.startsWith("outcome:")) {
        // a finished test, counted at the end of your first turn
        const id = message.id.slice(8);
        const pending = outcomes.current.get(id);
        outcomes.current.delete(id);
        if (!pending) return;
        setDecks((all) =>
          all.map((one) => {
            if (one.id !== pending.deckId || one.results?.some((result) => result.id === id)) return one;
            const goal = one.fullAt ?? 3;
            const count = message.list.length;
            const kind: TestResult["kind"] = count >= goal ? "full" : pending.start === undefined ? "brick" : pending.trap ? "handtrap" : "short";
            const why =
              kind === "full" ? `Full board: ${count} interruption${count === 1 ? "" : "s"}` : kind === "brick" ? "No start in the opening hand" : kind === "handtrap" ? `${pending.trap}: ended on ${count} of ${goal}` : `Fell short: ${count} of ${goal} interruptions`;
            const result: TestResult = { id, date: pending.date, start: pending.start, hand: pending.hand, interruptions: count, kind, why };
            return { ...one, results: [result, ...(one.results ?? [])].slice(0, 300) };
          }),
        );
      } else if (message.type === "interruptions") {
        // a working test's board, counted: kept with the test
        setDecks((all) => all.map((one) => (one.tests?.some((test) => test.id === message.id) ? { ...one, tests: one.tests.map((test) => (test.id === message.id ? { ...test, interruptions: message.list, protection: message.protection, nibiru: message.nibiru, counted: COUNTING } : test)) } : one)));
        // a worked replay is its start's line in Optimise: checked against each hand trap and Nibiru
        window.setTimeout(() => {
          const owner = decksRef.current.find((one) => one.tests?.some((test) => test.id === message.id));
          const test = owner?.tests?.find((one) => one.id === message.id);
          if (!owner || !test?.worked) return;
          const start = startOf(owner, test.startHand, test.testOf) ?? test.startHand[0];
          // marked as working: its result is a full board, whatever it was counted as
          if (owner.results?.some((one) => one.id === test.id && one.kind !== "full"))
            owner.results = owner.results.map((one) => (one.id === test.id ? { ...one, kind: "full", why: "Marked as working" } : one));
          if (start === undefined) return;
          const before = owner.routes?.[start];
          // the start keeps its best worked line
          if (before?.source === "replay" && before.testId !== test.id && (before.interruptions?.length ?? 0) > message.list.length) return;
          const keys = test.steps.flatMap((step) => (!step.code ? [] : step.idle ? [`${step.text.split(/[ :]/)[0]}:${step.code}`] : [`pick:${step.hint ?? 0}:${step.code}`]));
          const line = {
            keys, board: test.board ?? [], interruptions: message.list, protection: message.protection, nibiru: message.nibiru, coverage: 1, full: message.list.length >= (owner.fullAt ?? 3),
            aimed: true, tried: 0, date: Date.now(), signature: deckSignature(owner), record: { options: test.options, picks: test.picks, steps: test.steps, startHand: test.startHand }, source: "replay" as const, testId: test.id,
          };
          const updated = { ...owner, routes: { ...owner.routes, [start]: line } };
          setDecks((all) => all.map((one) => (one.id === owner.id ? updated : one)));
          if (!chokingRef.current) checkChokes(updated, [{ code: start, hand: test.startHand }]);
        }, 50);
      } else if (message.type === "choke") {
        const job = chokingRef.current;
        if (!job || job.id !== message.id || !message.done) return;
        const chokes = message.done;
        const combo = message.combo;
        setDecks((all) => all.map((one) => (one.id === job.deckId && one.routes?.[job.code] ? { ...one, routes: { ...one.routes, [job.code]: { ...one.routes[job.code], chokes, combo } } } : one)));
        const target = decksRef.current.find((one) => one.id === job.deckId);
        if (target) window.setTimeout(() => checkChokes(decksRef.current.find((one) => one.id === job.deckId) ?? target, job.queue), 50);
        else setChoking(null);
      } else if (message.type === "probe") {
        const job = probeRef.current;
        if (!job || job.id !== message.id) return;
        if (message.evidence) {
          const evidence = message.evidence;
          setDecks((all) => all.map((one) => (one.id === job.deckId ? { ...one, engine: { signature: job.signature, evidence } } : one)));
          setProbe(null);
        } else setProbe({ ...job, done: message.done, total: message.total });
      } else if (message.type === "error") setError(message.text);
    };
    instance.postMessage({ type: "init" } satisfies ToWorker);
    return () => instance.terminate();
  }, []);

  useEffect(() => storeDecks(decks), [decks]);
  useEffect(() => save({ deckId: deck?.id ?? "", hand, chosen, ignoreHandTraps, opponent, opponentHandTraps, fixedTraps, goSecond }), [deck, hand, chosen, ignoreHandTraps, opponent, opponentHandTraps, fixedTraps, goSecond]);
  // names for the hand trap chips on the Test screen
  useEffect(() => {
    if (ready && screen === "test" && CHOKE_TRAPS.some((code) => !cards.has(code))) void info(CHOKE_TRAPS);
  }, [ready, screen]);
  // the opponent's deck for a new duel, shuffled
  const opponentDeck = () => {
    const source = opponent === "none" ? null : opponent === "copy" ? deck : decks.find((one) => one.id === opponent) ?? deck;
    if (!source?.main.length) return {};
    const main = shuffled(source.main);
    // the chosen hand traps on top, so they are in the opening hand: taken from the deck, or put in for random cards;
    // they're the only ones it uses on your turn (anything else it draws stays in its hand)
    const wanted = opponentHandTraps && fixedTraps && deck ? (deck.opponentTraps ?? [14558127, 10045474]).slice(0, goSecond ? 4 : 5) : [];
    if (wanted.length) {
      for (const code of [...wanted].reverse()) {
        const at = main.indexOf(code);
        if (at >= 0) main.splice(at, 1);
        else main.pop();
        main.unshift(code);
      }
    }
    return { opponent: { main, extra: source.extra }, opponentHandTraps, opponentTraps: wanted, goSecond };
  };

  // errors clear themselves so they never sit over the field for long
  useEffect(() => {
    if (!error || !view) return;
    const clear = window.setTimeout(() => setError(""), 6000);
    return () => window.clearTimeout(clear);
  }, [error, view]);

  // card names for the opening hand picker come from the worker once the cards are loaded
  const unique = useMemo(() => [...new Set(deck?.main ?? [])], [deck]);
  // what every card of the chosen deck is (which artwork of which card), for pictures in the duel as well
  useEffect(() => {
    if (!ready || !deck) return;
    const missing = [...new Set([...deck.main, ...deck.extra, ...deck.side])].filter((code) => !cards.has(code));
    if (missing.length) void info(missing);
  }, [ready, deck?.id]);
  useEffect(() => {
    if (!ready) return;
    // and for saved tests: what they opened with and the boards they ended on (Extra Deck monsters too)
    const named = new Set([...unique, ...(deck?.tests ?? []).flatMap((one) => [...one.startHand, ...(one.board ?? [])])]);
    named.forEach((code) => texts.has(code) || post({ type: "text", code }));
  }, [ready, unique, deck?.tests]);

  const pickDeck = (id: string) => {
    setDeckId(id);
    setChosen([]);
  };
  const changeDeck = (next: SavedDeck) => setDecks((all) => all.map((one) => (one.id === next.id ? next : one)));
  const addDeck = (next: Omit<SavedDeck, "id" | "updated">) => {
    const made = { ...next, id: newId(), updated: Date.now() };
    setDecks((all) => [made, ...all]);
    pickDeck(made.id);
    return made;
  };

  // a deck from any of the formats, Main and Extra split by card type when the format keeps them together (Omega)
  // Every card is translated to one the database knows: YGO Omega's own artwork numbers become the real card, and
  // anything that can't be matched is named in a notice instead of being kept as an unreadable number.
  const readDeck = async (text: string, fileName = "") => {
    const imported = await importDeck(text, fileName);
    const name = fileName.replace(/\.(ydk|txt)$/i, "") || "Imported deck";
    if ("list" in imported) {
      // card names to cards; Extra Deck monsters go to the Extra Deck unless the list put them in the Side
      const found = await names(imported.list.map((entry) => entry.name));
      const unknown = imported.list.filter((_, index) => !found[index]).map((entry) => entry.name);
      if (unknown.length) setError(`Not found in the card database, left out: ${unknown.join(", ")}`);
      const deck = { name, main: [] as number[], extra: [] as number[], side: [] as number[] };
      imported.list.forEach((entry, index) => {
        const card = found[index];
        if (!card) return;
        const section = entry.section === "side" ? "side" : card.type & EXTRA_TYPES ? "extra" : "main";
        for (let copy = 0; copy < entry.count; copy++) deck[section].push(card.code);
      });
      setCards((known) => {
        const next = new Map(known);
        found.forEach((card) => card && next.set(card.code, card));
        return next;
      });
      return deck;
    }
    const asked = "deck" in imported ? [...imported.deck.main, ...imported.deck.extra, ...imported.deck.side] : [...imported.unsplit.mainAndExtra, ...imported.unsplit.side];
    const found = await info([...new Set(asked)]);
    const known = new Map(found.map((card) => [card.asked, card]));
    const missing = [...new Set(asked.filter((code) => !known.has(code)))];
    if (missing.length) setError(`${missing.length} card${missing.length > 1 ? "s" : ""} in this deck aren't in the card database and were left out: ${missing.join(", ")}`);
    const real = (codes: number[]) => codes.flatMap((code) => (known.has(code) ? [known.get(code)!.code] : []));
    if ("deck" in imported) return { name, main: real(imported.deck.main), extra: real(imported.deck.extra), side: real(imported.deck.side) };
    const isExtra = (code: number) => ((known.get(code)?.type ?? 0) & EXTRA_TYPES) !== 0;
    return { name, main: real(imported.unsplit.mainAndExtra.filter((code) => !isExtra(code))), extra: real(imported.unsplit.mainAndExtra.filter(isExtra)), side: real(imported.unsplit.side) };
  };
  const importText = async (text: string, fileName = "") => {
    try {
      addDeck(await readDeck(text, fileName));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  // ---- keeping decks elsewhere: backup file, a linked deck folder, Google Drive ----
  const [syncNote, setSyncNote] = useState("");
  const [folderName, setFolderName] = useState<string | null>(null);
  useEffect(() => void linkedFolder().then((handle) => setFolderName(handle?.name ?? null)), []);
  const note = (text: string) => setSyncNote(text);
  const failed = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));
  const restore = (text: string) => {
    const merged = mergeBackup(text, decksRef.current);
    setDecks(merged);
    note(`Restored: ${merged.length} deck${merged.length === 1 ? "" : "s"}`);
  };
  // the folder's deck files come in (new or changed there); decks changed here go out as .ydk
  const syncFolder = async (relink = false) => {
    try {
      const handle = !relink && (await linkedFolder()) ? (await linkedFolder())! : await linkFolder();
      setFolderName(handle.name);
      const files = await readFolder(handle);
      let next = [...decksRef.current];
      let came = 0, went = 0;
      for (const file of files) {
        const mine = next.find((one) => one.file === file.name);
        if (mine && !(file.modified > (mine.fileSynced ?? 0) && mine.updated <= (mine.fileSynced ?? 0))) continue;
        const read = await readDeck(file.text, file.name).catch(() => null);
        if (!read) continue;
        came++;
        next = mine
          ? next.map((one) => (one.id === mine.id ? { ...one, main: read.main, extra: read.extra, side: read.side, updated: Date.now(), fileSynced: Date.now() } : one))
          : [{ ...read, id: newId(), updated: file.modified, file: file.name, fileSynced: Date.now() }, ...next];
      }
      const taken = new Set(next.map((one) => one.file).filter(Boolean));
      for (const one of next) {
        if (one.file && one.fileSynced && one.updated <= one.fileSynced) continue;
        if (!one.file) {
          let name = `${(one.name || "deck").replace(/[\\/:*?"<>|]/g, "")}.ydk`;
          for (let n = 2; taken.has(name); n++) name = `${(one.name || "deck").replace(/[\\/:*?"<>|]/g, "")} (${n}).ydk`;
          taken.add(name);
          one.file = name;
        }
        await writeFolderFile(handle, one.file, toYdk(one));
        one.fileSynced = Date.now();
        went++;
      }
      setDecks(next.map((one) => ({ ...one })));
      note(`Deck folder "${handle.name}": ${came} deck${came === 1 ? "" : "s"} in, ${went} written`);
    } catch (problem) {
      if (!(problem instanceof DOMException && problem.name === "AbortError")) failed(problem);
    }
  };
  const openMany = async (files: FileList) => {
    let count = 0;
    for (const file of Array.from(files)) {
      try {
        const read = await readDeck(await file.text(), file.name);
        setDecks((all) => [{ ...read, id: newId(), updated: Date.now() }, ...all]);
        count++;
      } catch {
        // not a deck: skipped
      }
    }
    note(`${count} deck${count === 1 ? "" : "s"} opened`);
  };

  const copies = (code: number) => deck?.main.filter((card) => card === code).length ?? 0;
  const picked = (code: number) => chosen.filter((card) => card === code).length;
  const choose = (code: number) => {
    if (chosen.length < hand && picked(code) < copies(code)) setChosen([...chosen, code]);
  };
  const unchoose = (slot: number) => setChosen(chosen.filter((_, index) => index !== slot));
  const pickHand = (size: number) => {
    setHand(size);
    setChosen(chosen.slice(0, size));
  };

  // a test from the optimiser deals exactly the cards it names (5 cards, hand traps held back) and stays set for New hand
  // route searches, one start at a time: the queue holds the starts still to search and the hand each starts from
  // a queued start with `retry` is a second round: searched again, guided by every line found, if it fell short
  type Queued = { code: number; hand: number[]; retry?: boolean };
  const [routing, setRouting] = useState<{ id: number; deckId: string; code: number; tried: number; queue: Queued[]; started: number } | null>(null);
  const routingRef = useRef(routing);
  routingRef.current = routing;
  const searchRoute = (target: SavedDeck, code: number, hand: number[], queue: Queued[] = []) => {
    const id = (routingRef.current?.id ?? 0) + 1;
    const next = { id, deckId: target.id, code, tried: 0, queue, started: Date.now() };
    routingRef.current = next;
    setRouting(next);
    const worked = (target.tests ?? []).filter((one) => one.worked);
    const targets = worked.flatMap((one) => (one.board?.length ? [one.board] : []));
    // your actions ("Activate:<card>") and your picks ("pick:<card>": what you added, what you sent) in working lines
    const signature = deckSignature(target);
    const prior = [
      ...new Set([
        ...worked.flatMap((one) => one.steps.filter((step) => step.code).map((step) => (step.idle ? `${step.text.split(/[ :]/)[0]}:${step.code}` : `pick:${step.hint ?? 0}:${step.code}`))),
        // the lines found for the other starts: a start that searches into one of them (Galaxy Wizard into Orbital 7)
        // follows it from there
        ...Object.entries(target.routes ?? {}).flatMap(([start, route]) => (Number(start) !== code && route.signature === signature ? route.keys ?? [] : [])),
      ]),
    ];
    post({ type: "route", id, main: target.main, extra: target.extra, hand, targets, prior, goal: target.fullAt ?? 3 });
  };
  // choke points, one start at a time, once its line is found (the hand trap check runs after all lines are in)
  const [choking, setChoking] = useState<{ id: number; deckId: string; code: number; queue: { code: number; hand: number[] }[] } | null>(null);
  const chokingRef = useRef(choking);
  chokingRef.current = choking;
  const checkChokes = (target: SavedDeck, queue: { code: number; hand: number[] }[]) => {
    const [first, ...rest] = queue;
    const route = first && target.routes?.[first.code];
    if (!first) return setChoking(null);
    if (!route?.keys) return checkChokes(target, rest);
    const id = (chokingRef.current?.id ?? 0) + 1;
    const next = { id, deckId: target.id, code: first.code, queue: rest };
    chokingRef.current = next;
    setChoking(next);
    // the hand traps to check: the ones this deck tags as hand traps (they're the ones you expect), then the common staples
    const tagged = Object.entries(target.tags ?? {}).filter(([, tag]) => hasRole(tag, "handtrap") && !secondOnly(tag)).map(([code]) => Number(code));
    post({ type: "choke", id, main: target.main, extra: target.extra, hand: first.hand, keys: route.keys, goal: target.fullAt ?? 3, combo: target.opponentTraps ?? [14558127, 10045474], traps: [...new Set([...tagged, ...CHOKE_TRAPS])] });
  };
  const allStarts = useRef<{ code: number; hand: number[] }[]>([]);
  const findLines = (target: SavedDeck, starts: { code: number; hand: number[] }[]) => {
    allStarts.current = starts;
    if (!starts.length) return;
    // every start once, then a second round for the ones that fell short, now guided by the others' lines
    const queue: Queued[] = [...starts.slice(1), ...(starts.length > 1 ? starts.map((one) => ({ ...one, retry: true })) : [])];
    searchRoute(target, starts[0].code, starts[0].hand, queue);
  };

  const checkDeck = useCallback((target: SavedDeck) => {
    const signature = deckSignature(target);
    const running = probeRef.current;
    if (running && running.deckId === target.id && running.signature === signature) return;
    const id = (running?.id ?? 0) + 1;
    setProbe({ id, deckId: target.id, signature, done: 0, total: 0 });
    probeRef.current = { id, deckId: target.id, signature, done: 0, total: 0 };
    post({ type: "probe", id, main: target.main, extra: target.extra });
  }, []);

  const keep = (deckIdToSave: string, entry: SavedTest) =>
    setDecks((all) => all.map((one) => (one.id === deckIdToSave ? { ...one, tests: keepTest(one.tests, entry) } : one)));
  // every choice made is saved straight away, so leaving or closing the page loses nothing
  useEffect(() => {
    const current = test.current;
    if (!record || !current || record.picks.length <= current.from) return;
    keep(current.deckId, { ...record, id: current.id, date: current.date, testOf: current.testOf, worked: current.worked, board: current.board, pieces: current.pieces });
  }, [record]);
  // a test you played (made choices of your own in), counted once you move on from it
  const outcomes = useRef(new Map<string, { deckId: string; date: number; start?: number; hand: number[]; trap?: string }>());
  const finishTest = () => {
    const current = test.current;
    const played = lastRecord.current;
    if (!current || !played || played.picks.length <= current.from || !played.steps.some((step) => step.idle)) return;
    const owner = decksRef.current.find((one) => one.id === current.deckId);
    if (!owner || owner.results?.some((one) => one.id === current.id) || outcomes.current.has(current.id)) return;
    const saved: SavedTest = { ...played, id: current.id, date: current.date, testOf: current.testOf };
    outcomes.current.set(current.id, { deckId: owner.id, date: current.date, start: startOf(owner, played.startHand, current.testOf), hand: played.startHand });
    void (async () => {
      const { views } = await replayViews(saved);
      // your first turn, to its last moment
      const first = views.find((one) => one.turnPlayer === 0 && one.turn > 0)?.turn;
      const turn = views.filter((one) => one.turn === first);
      const end = turn.at(-1) ?? views.at(-1);
      if (!end) return outcomes.current.delete(current.id);
      // a hand trap the opponent used in it, and what it answered
      let last = "";
      let trap: string | undefined;
      for (const event of turn.flatMap((one) => one.events)) {
        if ((event.kind === "activate" || event.kind === "summon") && event.controller === 0) last = event.name;
        if (event.kind === "activate" && event.controller === 1 && !trap) trap = last ? `${event.name} on ${last}` : event.name;
      }
      const pending = outcomes.current.get(current.id);
      if (pending) pending.trap = trap;
      post({ type: "interruptions", id: `outcome:${current.id}`, pieces: piecesOf(end), startHand: played.startHand, used: usedIn(played.steps) });
    })();
  };
  const newTest = (testOf?: number, from = 0) => {
    finishTest();
    test.current = deck ? { id: newId(), deckId: deck.id, date: Date.now(), testOf, from } : null;
    setRecord(null);
    setWorked(false);
  };
  const markWorked = () => {
    const current = test.current;
    if (!current || !record || !view) return;
    current.worked = !current.worked;
    const mine = view.players[0];
    current.board = current.worked ? [...mine.monsters, ...mine.spells].flatMap((card) => (card?.code ? [card.code] : [])) : undefined;
    // everything that can matter on the opponent's turn, to count the board's interruptions
    current.pieces = current.worked
      ? [
          ...mine.monsters.flatMap((card) => (card?.code ? [{ code: card.code, location: 4, materials: card.overlay?.length ?? 0 }] : [])),
          ...mine.spells.flatMap((card) => (card?.code ? [{ code: card.code, location: 8, materials: 0 }] : [])),
          ...mine.hand.flatMap((card) => (card.code ? [{ code: card.code, location: 2, materials: 0 }] : [])),
          ...mine.grave.flatMap((card) => (card.code ? [{ code: card.code, location: 16, materials: 0 }] : [])),
          ...mine.extra.flatMap((card) => (card.code ? [{ code: card.code, location: 64, materials: 0 }] : [])),
        ]
      : undefined;
    setWorked(current.worked);
    keep(current.deckId, { ...record, id: current.id, date: current.date, testOf: current.testOf, worked: current.worked, board: current.board, pieces: current.pieces });
    if (current.pieces) void countBoard({ ...record, id: current.id, date: current.date }).then((counted) => counted?.send());
  };
  // going back: the duel is rebuilt from your choices up to the point asked for
  const rewind = (to: "action" | "turn") => {
    const current = lastRecord.current;
    if (!current || !view) return;
    const steps = current.steps;
    let at = 0;
    if (to === "action") {
      // before your last action, and every choice that came with it
      for (let index = steps.length - 1; index >= 0; index--)
        if (steps[index].idle) {
          at = index;
          break;
        }
    } else {
      // the start of this turn; if nothing was chosen in it yet, the start of the turn before
      const turns = steps.map((step) => step.turn ?? 0);
      const latest = turns.includes(view.turn) ? view.turn : Math.max(0, ...turns.filter((one) => one < view.turn));
      at = Math.max(0, turns.findIndex((one) => one >= latest));
    }
    const saved: SavedTest = { ...current, id: newId(), date: Date.now(), testOf: test.current?.testOf };
    if (at > 0) return watch(saved, at);
    // back to the very start: the same hand, the same order, no animations to sit through
    newTest(saved.testOf);
    lastRecord.current = null;
    post({ ...saved.options, type: "start" });
  };
  // save states: where the duel on screen is now, kept with the deck; loading one rebuilds it choice by choice
  const saveState = () => {
    const current = lastRecord.current;
    const target = test.current && decks.find((one) => one.id === test.current!.deckId);
    if (!current || !target || !view) return;
    const state = { id: newId(), date: Date.now(), name: `Turn ${view.turn} · ${view.phase} · ${current.picks.length} choice${current.picks.length === 1 ? "" : "s"}`, record: current };
    changeDeck({ ...target, saves: [state, ...(target.saves ?? [])].slice(0, 20) });
    return state.name;
  };
  const loadState = (id: string) => {
    const state = (test.current ? decks.find((one) => one.id === test.current!.deckId) : deck)?.saves?.find((one) => one.id === id);
    if (state) watch({ ...state.record, id: newId(), date: Date.now() }, state.record.picks.length);
  };
  // a saved test as a video file: the worker replays it out of sight, the page draws and records every moment
  const [video, setVideo] = useState<{ id: string; share: number } | null>(null);
  const videoWaiting = useRef(new Map<string, (replay: { views: DuelView[]; marks: number[] }) => void>());
  const replayViews = (saved: SavedTest, reveal = false) => {
    const id = newId();
    const options = saved.options.opponent ? saved.options : { ...saved.options, ...opponentDeck(), opponentHandTraps: false, goSecond: false };
    return new Promise<{ views: DuelView[]; marks: number[] }>((resolve) => {
      videoWaiting.current.set(id, resolve);
      // the request's own type last: a saved duel's settings must never turn it into something else
      post({ ...options, picks: saved.picks, reveal, type: "views", id });
    });
  };

  // ---- the replay viewer: every play of a saved test, stepped through with every card shown ----
  type Frame = { index: number; label: string; picks: number };
  // fast: playing straight through, nothing described until paused; mini: the bar folded down to one line
  const [viewing, setViewing] = useState<{ test: SavedTest; views: DuelView[]; frames: Frame[]; at: number; back: boolean; playing: boolean; fast?: boolean; mini?: boolean } | null>(null);
  // the phone's back button steps back through the app (replay, duel, editor, a section) and only leaves it from the menu
  const goBack = useRef<() => boolean>(() => false);
  goBack.current = () => {
    if (viewing) return setViewing(null), true;
    if (view) return finishTest(), skip(), setReplay(null), setView(null), true;
    if (editing) return setEditing(false), true;
    if (screen !== "menu") return setScreen("menu"), true;
    return false;
  };
  useEffect(() => {
    history.pushState({ rka: true }, "");
    const onBack = () => {
      if (goBack.current()) history.pushState({ rka: true }, "");
    };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, []);
  // what matters on the opponent's turn, from a view: field (with Xyz Materials), hand, GY
  const piecesOf = (shown: DuelView) => {
    const mine = shown.players[0];
    return [
      ...mine.monsters.flatMap((card) => (card?.code ? [{ code: card.code, location: 4, materials: card.overlay?.length ?? 0 }] : [])),
      ...mine.spells.flatMap((card) => (card?.code ? [{ code: card.code, location: 8, materials: 0 }] : [])),
      ...mine.hand.flatMap((card) => (card.code ? [{ code: card.code, location: 2, materials: 0 }] : [])),
      ...mine.grave.flatMap((card) => (card.code ? [{ code: card.code, location: 16, materials: 0 }] : [])),
      // for rank-ups on their turn (Eternal Galaxy into Number 90)
      ...mine.extra.flatMap((card) => (card.code ? [{ code: card.code, location: 64, materials: 0 }] : [])),
    ];
  };
  // a saved test counted: replayed out of sight for its end board and for the moment of your 5th summon (Nibiru)
  const countBoard = async (saved: SavedTest, views?: DuelView[]) => {
    const all = views ?? (await replayViews(saved)).views;
    const last = all.at(-1);
    if (!last) return null;
    let summons = 0;
    let fifth: ReturnType<typeof piecesOf> | undefined;
    for (const one of all) {
      summons += one.events.filter((event) => event.kind === "summon" && event.controller === 0).length;
      if (summons >= 5 && !fifth) fifth = piecesOf(one);
    }
    const pieces = piecesOf(last);
    const board = [...last.players[0].monsters, ...last.players[0].spells].flatMap((card) => (card?.code ? [card.code] : []));
    // sent once the test is kept, so the answer finds it
    const send = () => post({ type: "interruptions", id: saved.id, pieces, startHand: saved.startHand, used: usedIn(saved.steps), summons, fifth });
    return { last, pieces, board, send };
  };
  // the effects a test activated, for what they leave in place on the opponent's turn
  const usedIn = (steps: { text: string; idle: boolean; code?: number }[]) => steps.flatMap((step) => (step.idle && step.code && /^Activate/.test(step.text) ? [{ code: step.code }] : []));
  // mark a saved test as working (or not) after the fact: its end is the board it worked to
  const markTestWorked = async (saved: SavedTest, views?: DuelView[]) => {
    const target = decks.find((one) => one.tests?.some((test) => test.id === saved.id)) ?? deck;
    if (!target) return;
    if (saved.worked) {
      const routes = Object.fromEntries(Object.entries(target.routes ?? {}).filter(([, route]) => route.testId !== saved.id));
      changeDeck({ ...target, routes, tests: (target.tests ?? []).map((test) => (test.id === saved.id ? { ...test, worked: false, board: undefined, pieces: undefined, interruptions: undefined } : test)) });
      return;
    }
    const counted = await countBoard(saved, views);
    if (!counted) return;
    const { pieces, board } = counted;
    const latest = decksRef.current.find((one) => one.id === target.id) ?? target;
    const known = latest.tests?.some((test) => test.id === saved.id);
    const marked = { ...saved, worked: true, board, pieces };
    changeDeck({ ...latest, tests: known ? (latest.tests ?? []).map((test) => (test.id === saved.id ? marked : test)) : keepTest(latest.tests, marked) });
    window.setTimeout(counted.send, 0);
  };
  const [loadingReplay, setLoadingReplay] = useState(false);
  // worked tests saved before boards were counted: replayed out of sight, one at a time, and counted
  const counting = useRef(new Set<string>());
  useEffect(() => {
    if (screen !== "replays" || !deck || !ready) return;
    const waiting = (deck.tests ?? []).filter((one) => one.worked && (!one.interruptions || one.counted !== COUNTING) && !counting.current.has(one.id));
    if (!waiting.length) return;
    void (async () => {
      for (const saved of waiting) {
        counting.current.add(saved.id);
        const counted = await countBoard(saved);
        if (!counted) continue;
        const { pieces, board } = counted;
        setDecks((all) => all.map((one) => (one.tests?.some((test) => test.id === saved.id) ? { ...one, tests: one.tests.map((test) => (test.id === saved.id ? { ...test, pieces, board: test.board?.length ? test.board : board } : test)) } : one)));
        counted.send();
      }
    })();
  }, [screen, deck, ready]);
  const describeEvents = (events: DuelView["events"]) => {
    const parts = events.flatMap((event) => {
      if (event.kind === "summon") return [`Summoned ${event.name}`];
      if (event.kind === "activate") return [`Activated ${event.name}${event.text ? `: ${event.text}` : ""}`];
      if (event.kind === "added") return [`Added ${event.name} to the hand`];
      if (event.kind === "negated") return [`${event.name} negated`];
      if (event.kind === "attack") return [`${event.name || "a monster"} attacks${event.target ? "" : " directly"}`];
      return [];
    });
    return parts.join(" · ");
  };
  const openViewer = async (saved: SavedTest) => {
    setLoadingReplay(true);
    try {
      const { views, marks } = await replayViews(saved, true);
      // a step per play of yours (declining to chain, zones and positions are part of the play around them), then one per
      // action of the opponent's that followed it, then your next turn when it comes back to you
      const minor = (text: string) => /^(Don't chain|Cancel|Select a zone|Select the battle position|Confirm)/.test(text) || /^(Yes|No)$/.test(text) || /: (Yes|No)$/.test(text);
      const frames: Frame[] = [{ index: Math.max(0, marks[0] - 1), label: "Start of the duel", picks: 0 }];
      let pending = "";
      for (let pick = 0; pick + 1 < marks.length; pick++) {
        const first = marks[pick], last = marks[pick + 1] - 1;
        // a test you played names each choice; an engine line's steps don't line up with its choices one to one, so
        // its plays are described by what happened
        const aligned = saved.steps.length === saved.picks.length;
        const happened = describeEvents(views.slice(first, last + 1).filter((view) => view.turnPlayer === 0).flatMap((view) => view.events));
        const text = aligned ? saved.steps[pick]?.text ?? `Play ${pick + 1}` : happened || "Don't chain";
        // your part: the views of this play still on your turn
        let mine = first - 1;
        while (mine + 1 <= last && views[mine + 1].turnPlayer === 0) mine++;
        if (!minor(text)) pending = text;
        if (pending && (mine >= first || pick + 2 === marks.length || views[last].turnPlayer !== 0)) {
          frames.push({ index: Math.max(first, Math.min(mine, last)), label: pending, picks: pick + 1 });
          pending = "";
        } else if (!minor(text) || mine < last) {
          // nothing to show apart from the choice itself: it shows with the next step
        }
        // the opponent's actions that followed
        let theirs = false;
        for (let index = Math.max(first, mine + 1); index <= last; index++) {
          const view = views[index];
          if (view.turnPlayer !== 1) continue;
          theirs = true;
          const said = describeEvents(view.events);
          if (said) frames.push({ index, label: `Opponent: ${said}`, picks: pick + 1 });
        }
        // back to you after their turn
        if (theirs && views[last].turnPlayer === 0) frames.push({ index: last, label: `Your turn ${views[last].turn}`, picks: pick + 1 });
      }
      if (pending) frames.push({ index: marks[marks.length - 1] - 1, label: pending, picks: marks.length - 1 });
      setViewing({ test: saved, views, frames, at: 0, back: false, playing: false });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setLoadingReplay(false);
    }
  };
  const viewTo = (at: number, playing?: boolean) =>
    setViewing((now) => (now ? { ...now, at: Math.max(0, Math.min(now.frames.length - 1, at)), back: at < now.at, playing: playing ?? now.playing } : now));
  // playing: the next step once this one's animations have been seen
  useEffect(() => {
    if (!viewing?.playing) return;
    if (viewing.at >= viewing.frames.length - 1) return setViewing({ ...viewing, playing: false, fast: false });
    const shown = viewing.views[viewing.frames[viewing.at].index];
    // fast forward: a play every tenth of a second, nothing described or animated until paused
    const wait = window.setTimeout(() => viewTo(viewing.at + 1), viewing.fast ? 110 : Math.max(800, cueTime(shown?.events ?? []) + 350));
    return () => window.clearTimeout(wait);
  }, [viewing]);
  // a link to this test's replay, shared or copied
  const shareReplay = async (saved: SavedTest) => {
    try {
      const url = await replayLink(saved);
      if (navigator.share) await navigator.share({ title: "RKAPro replay", url });
      else {
        await navigator.clipboard.writeText(url);
        setSyncNote("Replay link copied");
        setError("Replay link copied: anyone who opens it watches this test in their browser.");
      }
    } catch (problem) {
      if (!(problem instanceof DOMException && problem.name === "AbortError")) setError(problem instanceof Error ? problem.message : String(problem));
    }
  };
  // opened from a shared link: watch it as soon as the cards are loaded
  useEffect(() => {
    if (!ready || !location.hash.startsWith("#replay=")) return;
    void readReplayLink(location.hash)
      .then((shared) => {
        history.replaceState(null, "", location.pathname);
        if (shared) void openViewer({ ...shared, id: newId(), date: Date.now() });
      })
      .catch(() => setError("This replay link is damaged or incomplete."));
  }, [ready]);
  const saveVideo = async (saved: SavedTest) => {
    setVideo({ id: saved.id, share: 0 });
    try {
      const { views } = await replayViews(saved);
      const { blob, extension } = await recordVideo(views, (share) => setVideo({ id: saved.id, share }));
      const url = URL.createObjectURL(blob);
      const name = `${deck?.name ?? "RKAPro"} ${new Date(saved.date).toISOString().slice(0, 16).replace("T", " ").replace(":", "-")}.${extension}`;
      Object.assign(document.createElement("a"), { href: url, download: name }).click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setVideo(null);
    }
  };
  const watch = (saved: SavedTest, from = 0) => {
    setError("");
    newTest(saved.testOf, from > 0 ? from : saved.picks.length);
    window.clearTimeout(timer.current);
    timer.current = 0;
    queue.current = [];
    // a test saved without an opponent (or a line the route search found) gets today's opponent, without hand traps
    // on your turn, so your recorded choices still play the same and you can go on into their turn
    const options = saved.options.opponent ? saved.options : { ...saved.options, ...opponentDeck(), opponentHandTraps: false, goSecond: false };
    // "from": jump straight to that choice and carry on from there yourself; otherwise watch it play
    lastRecord.current = null;
    if (from > 0) post({ ...options, picks: saved.picks.slice(0, from), type: "jump" });
    else {
      setReplay({ picks: saved.picks, at: 0 });
      post({ ...options, type: "start" });
    }
  };
  // the next recorded choice, once the prompt it answers is on screen and the animations before it have played
  useEffect(() => {
    if (!replay || !view?.prompt || queue.current.length || timer.current) return;
    // played to the end: the test on screen is that line, so "This worked" can keep it
    if (replay.at >= replay.picks.length) return setReplay(null), setRecord(lastRecord.current);
    const wait = window.setTimeout(() => {
      post({ type: "answer", picks: replay.picks[replay.at] });
      setReplay({ ...replay, at: replay.at + 1 });
    }, 450);
    return () => window.clearTimeout(wait);
  }, [view, replay]);

  // a test from Optimise: a dud opponent, 40 cards of Marshmallon (does nothing on its own) with the hand traps picked in
  // Lines on top (in its opening hand, and the only ones it uses); none picked, none at all
  const dudOpponent = (traps: number[]) => ({
    opponent: { main: [...traps, ...Array.from({ length: 40 - traps.length }, () => 31305911)], extra: [] as number[] },
    opponentHandTraps: traps.length > 0,
    opponentTraps: traps,
    goSecond: false,
  });
  const start = useCallback((test?: { chosen: number[] }) => {
    if (!deck) return;
    setReplay(null);
    newTest(test ? test.chosen[0] : undefined);
    const use = test ? { hand: 5, chosen: test.chosen, ignoreHandTraps: true } : { hand, chosen, ignoreHandTraps };
    if (test) {
      setHand(5);
      setChosen(test.chosen);
      setIgnoreHandTraps(true);
    }
    setError("");
    // a test started from the editor returns to it when you leave the duel
    // whatever was still being shown from the last hand is dropped
    window.clearTimeout(timer.current);
    timer.current = 0;
    queue.current = [];
    lastRecord.current = null;
    post({ type: "start", main: shuffled(deck.main), extra: deck.extra, ...use, ...(test ? dudOpponent(deck.opponentTraps ?? [14558127, 10045474]) : opponentDeck()), seed: Math.floor(Math.random() * 2 ** 31) });
  }, [deck, hand, chosen, ignoreHandTraps, opponent, opponentHandTraps, fixedTraps, goSecond, decks]);

  const requestText = useCallback(
    (code: number) => {
      if (!texts.has(code)) post({ type: "text", code });
    },
    [texts],
  );

  if (viewing) {
    const frame = viewing.frames[viewing.at];
    const previous = viewing.frames[viewing.at - 1];
    // going forward shows what happened since the last step; going back or jumping shows the position only
    // fast forward keeps the small animations on the board (summons, attacks) and skips the big ones
    const between = !viewing.back && previous ? viewing.views.slice(previous.index + 1, frame.index + 1).flatMap((one) => one.events) : [];
    const events = viewing.fast && viewing.playing ? between.filter((event) => event.kind === "summon" || event.kind === "attack") : between;
    const shown = { ...viewing.views[frame.index], prompt: null, events };
    const undone = viewing.back ? viewing.frames[viewing.at + 1]?.label : null;
    const fastForward = viewing.fast && viewing.playing;
    const caption = fastForward ? <span className="ff-blink" aria-label="Fast forwarding">⏩</span> : undone ? `Undone: ${undone}` : frame.label;
    const saved = viewing.test.id && decks.some((one) => one.tests?.some((test) => test.id === viewing.test.id)) ? (deck?.tests ?? []).find((test) => test.id === viewing.test.id) : undefined;
    const isWorked = !!(saved ?? viewing.test).worked;
    const where = `Turn ${shown.turn} · ${shown.turnPlayer === 0 ? "You" : "Opponent"} · ${shown.phase}`;
    // the caption strip of the saved videos: what just happened, and where in the duel
    const strip = (
      <div className="viewer-strip">
        <p className="viewer-caption">{caption}</p>
        {!fastForward && (
          <small>
            {where} · step {viewing.at} of {viewing.frames.length - 1}
          </small>
        )}
      </div>
    );
    const playButton = (
      <button className="button small primary" onClick={() => setViewing({ ...viewing, playing: !viewing.playing, fast: false, back: false })} aria-label={viewing.playing ? "Pause" : "Play"}>
        {viewing.playing ? "⏸" : "▶︎"}
      </button>
    );
    const controls = viewing.mini ? (
      <div className="viewer mini">
        {strip}
        {playButton}
        <button className="button small" onClick={() => setViewing({ ...viewing, mini: false })} aria-label="Show the controls">
          ⌃
        </button>
      </div>
    ) : (
      <div className="viewer">
        {strip}
        <input className="viewer-scrub" type="range" min={0} max={viewing.frames.length - 1} value={viewing.at} onChange={(event) => viewTo(Number(event.target.value), false)} aria-label="Step" />
        <div className="viewer-buttons">
          <button className="button small" onClick={() => viewTo(0, false)} aria-label="Start">⏮</button>
          <button className="button small" onClick={() => viewTo(viewing.at - 1, false)} aria-label="Back a play">◀</button>
          {playButton}
          <button className="button small" onClick={() => viewTo(viewing.at + 1, false)} aria-label="Forward a play">▶</button>
          <button className={`button small ${viewing.fast && viewing.playing ? "on" : ""}`} onClick={() => setViewing({ ...viewing, playing: !(viewing.fast && viewing.playing), fast: !(viewing.fast && viewing.playing), back: false })} aria-label="Fast forward">
            ⏩
          </button>
          <button className="button small" onClick={() => viewTo(viewing.frames.length - 1, false)} aria-label="End">⏭</button>
          <button className="button small" onClick={() => setViewing({ ...viewing, mini: true })} aria-label="Minimise">
            ⌄
          </button>
        </div>
      </div>
    );
    // marking it as working and playing on from here sit in the menu
    const viewerMenu = (
      <>
        <button
          className={`button ${isWorked ? "on" : ""}`}
          onClick={async () => {
            await markTestWorked({ ...viewing.test, ...(saved ?? {}) }, viewing.views.slice(0, viewing.frames[viewing.frames.length - 1].index + 1));
            setViewing((now) => now && { ...now, test: { ...now.test, worked: !isWorked } });
          }}
        >
          {isWorked ? "✓ Worked" : "Mark as working"}
        </button>
        <button
          className="button"
          onClick={() => {
            const { test: saved } = viewing;
            setViewing(null);
            if (frame.picks > 0) watch(saved, frame.picks);
            else {
              newTest(saved.testOf);
              post({ ...(saved.options.opponent ? saved.options : { ...saved.options, ...opponentDeck(), opponentHandTraps: false, goSecond: false }), type: "start" });
            }
          }}
        >
          Play from here
        </button>
      </>
    );
    return (
      <Duel
        view={shown}
        texts={texts}
        requestText={requestText}
        answer={() => {}}
        restart={() => {}}
        leave={() => setViewing(null)}
        skip={() => {}}
        worked={false}
        replaying={null}
        states={[]}
        onSaveState={() => undefined}
        onLoadState={() => {}}
        viewer={controls}
        viewerMenu={viewerMenu}
      />
    );
  }

  if (view) {
    return (
      <>
        {error && (
          <p className="error toast" onClick={() => setError("")}>
            {error}
          </p>
        )}
        <Duel
          view={view}
          texts={texts}
          requestText={requestText}
          answer={(picks) => {
            // a choice of yours while a saved test plays: you take over from here, as a new test
            if (replayRef.current) {
              setReplay(null);
              newTest(test.current?.testOf, replayRef.current.at);
            }
            post({ type: "answer", picks });
          }}
          restart={() => start()}
          leave={() => (finishTest(), skip(), setReplay(null), setView(null))}
          skip={skip}
          worked={worked}
          onWorked={record && !replay ? markWorked : undefined}
          replaying={replay ? { at: replay.at, of: replay.picks.length, stop: () => (setReplay(null), newTest(test.current?.testOf, replay.at)) } : null}
          states={(decks.find((one) => one.id === test.current?.deckId) ?? deck)?.saves ?? []}
          onSaveState={saveState}
          onLoadState={loadState}
          onRewind={replay ? undefined : rewind}
        />
      </>
    );
  }

  if (editing && deck) {
    return (
      <DeckEditor
        deck={deck}
        cards={cards}
        texts={texts}
        banlist={banlist}
        requestInfo={(codes) => void info(codes)}
        traits={traits}
        cutResult={cutResult && cutResult.deckId === deck.id ? cutResult : null}
        onCutTest={(code) => cutTest(deck, code)}
        requestTraits={(codes) => post({ type: "traits", codes })}
        requestText={requestText}
        search={search}
        onChange={changeDeck}
        onClose={() => setEditing(false)}
        onTest={(chosen) => start(chosen ? { chosen } : undefined)}
        engineProgress={probe && probe.deckId === deck.id ? probe : null}
        routing={routing && routing.deckId === deck.id ? { code: routing.code, tried: routing.tried, waiting: routing.queue.map((one) => one.code) } : null}
        choking={choking && choking.deckId === deck.id ? { code: choking.code, waiting: choking.queue.map((one) => one.code) } : null}
        onFindLines={(starts) => findLines(deck, starts)}
        onCheckChokes={(starts) => checkChokes(deck, starts)}
        onWatchLine={(line, code) => openViewer({ ...line, id: newId(), date: Date.now(), testOf: code })}
        onCheck={() => checkDeck(deck)}
      />
    );
  }

  const nameOf = (code: number) => texts.get(code)?.name ?? `#${code}`;
  return (
    <main className="start">
      <header>
        <h1>RKAPro</h1>
        <p className="status">{status}</p>
      </header>
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}

      {screen === "menu" && <span className="version">{__APP_VERSION__}</span>}
      {screen === "menu" && (
        <nav className="main-menu">
          <button className="deck-card" onClick={() => setScreen("decks")}>
            {deck ? (
              <>
                <b>{deck.name}</b>
                <span className="muted">
                  {deck.main.length} + {deck.extra.length}
                  {deck.side.length ? ` + ${deck.side.length}` : ""} · change deck
                </span>
              </>
            ) : (
              <b>Choose or import a deck</b>
            )}
          </button>
          {canInstall && (
            <button
              className="button small"
              onClick={async () => {
                await installOffer?.prompt();
                installOffer = null;
                setCanInstall(false);
              }}
            >
              Install RKAPro as an app (works offline)
            </button>
          )}
          <div className="menu-grid">
            <button className="menu-tile" disabled={!ready || !deck} onClick={() => openEditor(false)}>
              <b>Edit deck</b>
              <span>Search, build, ban list</span>
            </button>
            <button className="menu-tile" disabled={!ready || !deck} onClick={() => openEditor(true)}>
              <b>Optimise</b>
              <span>Odds, lines, choke points</span>
            </button>
            <button className="menu-tile primary" disabled={!ready || !deck?.main.length} onClick={() => setScreen("test")}>
              <b>Test</b>
              <span>Hands, opponent, going first or second</span>
            </button>
            <button className="menu-tile" disabled={!deck} onClick={() => setScreen("replays")}>
              <b>Replays</b>
              <span>{deck?.tests?.length ? `${deck.tests.length} saved test${deck.tests.length === 1 ? "" : "s"}` : "Saved tests"}</span>
            </button>
            <button className="menu-tile" onClick={() => setScreen("decks")}>
              <b>Decks</b>
              <span>New, import, delete</span>
            </button>
            <button className="menu-tile" onClick={() => setScreen("sync")}>
              <b>Sync</b>
              <span>Backup, deck folder, Drive</span>
            </button>
          </div>
        </nav>
      )}

      {screen === "decks" && (
        <>
          <div className="screen-head">
            <button className="icon-button" onClick={() => setScreen("menu")} aria-label="Menu">
              ‹
            </button>
            <h2>Decks</h2>
          </div>
      <section className="box">
        <div className="box-head">
          <h2>Decks</h2>
          <div className="row">
            <button className="button small" onClick={() => (addDeck({ name: "New deck", main: [], extra: [], side: [] }), setEditing(true))} disabled={!ready}>
              New
            </button>
            <label className="button small">
              Open file
              <input type="file" accept=".ydk,.txt" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (file) await importText(await file.text(), file.name); event.target.value = ""; }} />
            </label>
            <button className="button small" onClick={() => setPasting(!pasting)}>
              Paste
            </button>
          </div>
        </div>
        {pasting && (
          <div className="paste">
            <textarea value={paste} onChange={(event) => setPaste(event.target.value)} placeholder={"A card list (\"Main: 3 Mulcharmy Fuwalos\", \"3x Ash Blossom\"), a ydke:// link, a YGO Omega deck code, or the text of a .ydk file"} rows={3} />
            <button className="button primary small" disabled={!paste.trim() || !ready} onClick={async () => { await importText(paste); setPaste(""); setPasting(false); }}>
              Import
            </button>
          </div>
        )}
        <div className="deck-picker">
          {decks.map((one) => (
            <button key={one.id} className={`deck-row ${one.id === deck?.id ? "on" : ""}`} onClick={() => pickDeck(one.id)}>
              <span>{one.name}</span>
              <span className="muted">
                {one.main.length} + {one.extra.length}
                {one.side.length ? ` + ${one.side.length}` : ""}
              </span>
            </button>
          ))}
          {!decks.length && <p className="muted">No decks yet: make one, or open a .ydk file, or paste a ydke:// link or YGO Omega code.</p>}
        </div>
        {deck && (
          <div className="row">
            <button className="button primary" onClick={() => setScreen("menu")}>
              Use "{deck.name}"
            </button>
            <button className="button ghost" onClick={() => { if (confirm(`Delete "${deck.name}"?`)) setDecks((all) => all.filter((one) => one.id !== deck.id)); }}>
              Delete
            </button>
          </div>
        )}
      </section>
        </>
      )}

      {screen === "sync" && (
        <>
          <div className="screen-head">
            <button className="icon-button" onClick={() => setScreen("menu")} aria-label="Menu">
              ‹
            </button>
            <h2>Sync</h2>
          </div>
      <details className="box sync" open>
        <summary>
          <h2>Sync</h2>
          {syncNote && <span className="muted">{syncNote}</span>}
        </summary>
        <div className="row wrap">
          <button className="button small" onClick={downloadBackup}>
            Back up everything
          </button>
          <label className="button small">
            Restore a backup
            <input type="file" accept=".json" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (file) try { restore(await file.text()); } catch (problem) { failed(problem); } event.target.value = ""; }} />
          </label>
        </div>
        <p className="muted">One file with your decks and everything learned about them (tags, tests, lines, save states). Restoring merges it in: the newer copy of each deck wins.</p>
        {canLinkFolder() ? (
          <>
            <div className="row wrap">
              <button className="button small" onClick={() => syncFolder()}>
                {folderName ? `Sync "${folderName}"` : "Link a deck folder"}
              </button>
              {folderName && (
                <>
                  <button className="button small ghost" onClick={() => syncFolder(true)}>
                    Change folder
                  </button>
                  <button className="button small ghost" onClick={() => (unlinkFolder(), setFolderName(null))}>
                    Unlink
                  </button>
                </>
              )}
            </div>
            <p className="muted">A folder of .ydk files, like YGO Omega's or EDOPro's deck folder: its decks come in, and decks you change here are written back as .ydk.</p>
          </>
        ) : (
          <>
            <label className="button small">
              Open several deck files
              <input type="file" accept=".ydk,.txt" multiple hidden onChange={async (event) => { if (event.target.files) await openMany(event.target.files); event.target.value = ""; }} />
            </label>
            <p className="muted">Linking a whole deck folder works in Chrome or Edge on a computer. Here, pick several .ydk files at once.</p>
          </>
        )}
        <div className="row wrap">
          <button className="button small" disabled={!driveReady()} onClick={async () => { try { await driveUpload(JSON.stringify(makeBackup())); note("Saved to Google Drive"); } catch (problem) { failed(problem); } }}>
            Save to Google Drive
          </button>
          <button className="button small" disabled={!driveReady()} onClick={async () => { try { const text = await driveDownload(); if (text) restore(text); else note("Nothing saved in Google Drive yet"); } catch (problem) { failed(problem); } }}>
            Load from Google Drive
          </button>
        </div>
        <p className="muted">
          {driveReady()
            ? "Kept in this app's own hidden folder in your Drive, so your other files stay private to it."
            : "Google Drive needs a one-time setup for this site (a Google sign-in ID, see the README). Until then, back up to a file and keep it in Drive yourself."}
        </p>
      </details>
        </>
      )}

      {screen === "test" && deck && (
        <>
          <div className="screen-head">
            <button className="icon-button" onClick={() => setScreen("menu")} aria-label="Menu">
              ‹
            </button>
            <h2>Test</h2>
          </div>
          <section className="box">
            <h2>Hand size</h2>
            <div className="segmented">
              {[1, 2, 3, 4, 5, 6].map((size) => (
                <button key={size} className={`button ${size === hand ? "on" : ""}`} onClick={() => pickHand(size)}>
                  {size}
                </button>
              ))}
            </div>
          </section>

          <section className="box">
            <h2>Hand traps in my hand</h2>
            <div className="segmented two">
              <button className={`button ${!ignoreHandTraps ? "on" : ""}`} onClick={() => setIgnoreHandTraps(false)}>
                Ask to chain
              </button>
              <button className={`button ${ignoreHandTraps ? "on" : ""}`} onClick={() => setIgnoreHandTraps(true)}>
                Ignore
              </button>
            </div>
            <p className="muted">Ignore: on your turn, hand traps in your hand never ask to be chained, so a combo test is not interrupted by Ash or Fuwalos. On the opponent's turn they always can.</p>
          </section>

          <section className="box">
            <h2>Opponent</h2>
            <select className="select" value={opponent} onChange={(event) => setOpponent(event.target.value)}>
              <option value="copy">A copy of this deck</option>
              {decks
                .filter((one) => one.id !== deck.id)
                .map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              <option value="none">None: my turn only</option>
            </select>
            {opponent !== "none" && (
              <div className="segmented two">
                <button className={`button ${!goSecond ? "on" : ""}`} onClick={() => setGoSecond(false)}>
                  I go first
                </button>
                <button className={`button ${goSecond ? "on" : ""}`} onClick={() => setGoSecond(true)}>
                  I go second
                </button>
              </div>
            )}
            <p className="muted">
              End your turn and the computer plays theirs: it activates everything it can, summons, then attacks. You are asked whenever you can respond, so you can see where
              your interruptions go. Import any deck (a meta deck, board breakers) to play against it.
            </p>
          </section>

          {opponent !== "none" && (
            <section className="box">
              <h2>Opponent's hand traps</h2>
              <div className="segmented two">
                <button className={`button ${!opponentHandTraps ? "on" : ""}`} onClick={() => setOpponentHandTraps(false)}>
                  Off on my turn
                </button>
                <button className={`button ${opponentHandTraps ? "on" : ""}`} onClick={() => setOpponentHandTraps(true)}>
                  On my turn
                </button>
              </div>
              {opponentHandTraps && (
                <>
                  <div className="segmented two">
                    <button className={`button ${fixedTraps ? "on" : ""}`} onClick={() => setFixedTraps(true)}>
                      Opens with these
                    </button>
                    <button className={`button ${!fixedTraps ? "on" : ""}`} onClick={() => setFixedTraps(false)}>
                      Whatever it draws
                    </button>
                  </div>
                  {fixedTraps && (
                    <div className="opt-chips">
                      {CHOKE_TRAPS.map((trap) => {
                        const held = (deck.opponentTraps ?? [14558127, 10045474]).includes(trap);
                        return (
                          <button
                            key={trap}
                            className={`button small ${held ? "on" : ""}`}
                            onClick={() => {
                              const now = deck.opponentTraps ?? [14558127, 10045474];
                              const next = held ? now.filter((code) => code !== trap) : [...now, trap].slice(-3);
                              changeDeck({ ...deck, opponentTraps: next, updated: Date.now() });
                            }}
                          >
                            {cards.get(trap)?.name ?? `#${trap}`}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
              <p className="muted">
                {!opponentHandTraps
                  ? "The computer keeps its hand traps for its own turn: a clean combo test."
                  : fixedTraps
                    ? "It opens with these (up to 3) and chains them against your combo at the first chance it gets. Optimise checks the same set at every moment."
                    : "It chains whatever hand traps it happens to draw against your combo, at the first chance it gets."}
              </p>
            </section>
          )}

          <section className="box">
            <div className="box-head">
              <h2>Opening hand</h2>
              {chosen.length > 0 && (
                <button className="button ghost small" onClick={() => setChosen([])}>
                  Clear
                </button>
              )}
            </div>
            <p className="muted">Tap cards below to open with them. Empty slots are drawn at random.</p>
            <div className="slots">
              {Array.from({ length: hand }, (_, slot) => {
                const code = chosen[slot];
                return code ? (
                  <button key={slot} className="slot filled" onClick={() => unchoose(slot)} aria-label={`Remove ${nameOf(code)}`}>
                    <CardArt code={code} />
                    <span className="slot-name">{nameOf(code)}</span>
                  </button>
                ) : (
                  <span key={slot} className="slot">
                    Random
                  </span>
                );
              })}
            </div>
            <div className="deck-list">
              {unique.map((code) => {
                const left = copies(code) - picked(code);
                return (
                  <button key={code} className="deck-row" disabled={left === 0 || chosen.length >= hand} onClick={() => choose(code)}>
                    <span>{nameOf(code)}</span>
                    <b>×{left}</b>
                  </button>
                );
              })}
            </div>
          </section>
          <button className="button primary start-test" disabled={!ready || deck.main.length === 0} onClick={() => start()}>
            Start the test
          </button>
        </>
      )}

      {screen === "replays" && deck && (
        <>
          <div className="screen-head">
            <button className="icon-button" onClick={() => setScreen("menu")} aria-label="Menu">
              ‹
            </button>
            <h2>Replays</h2>
          </div>
          {deck.tests?.length ? (
            <Tests tests={deck.tests} nameOf={nameOf} onWatch={(saved, from) => (from ? watch(saved, from) : openViewer(saved))} loading={loadingReplay} onVideo={saveVideo} onShare={shareReplay} onWorked={(saved) => void markTestWorked(saved)} video={video} onDelete={(id) => changeDeck({ ...deck, tests: deck.tests!.filter((one) => one.id !== id) })} />
          ) : (
            <p className="muted">No saved tests yet. Every hand you test is saved here as you play.</p>
          )}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
