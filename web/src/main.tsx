import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseYdk, shuffled } from "./deck";
import { Duel, cueTime } from "./Duel";
import { DeckEditor } from "./DeckEditor";
import { CardArt } from "./CardArt";
import { EXTRA_TYPES, deckSignature, importDeck, keepTest, loadDecks, newId, storeDecks, type SavedDeck, type SavedTest } from "./decks";
import type { CardInfo, CardSearch, CardText, DuelView, FromWorker, TestRecord, ToWorker } from "./engine/protocol";
import { Tests } from "./Tests";
import "./style.css";

// EDOPro's card back, from Project Ignis like the scripts and card data; every face-down card uses it
const COVER_URL = import.meta.env.VITE_COVER_URL ?? "https://raw.githubusercontent.com/ProjectIgnis/Distribution/master/textures/cover.png";
document.documentElement.style.setProperty("--cover", `url("${COVER_URL}")`);

// hand test settings, remembered on this device only
const SAVED = "rka.handtest";
interface Saved {
  deckId: string;
  hand: number;
  chosen: number[];
  ignoreHandTraps: boolean;
  // the computer opponent: "none", "copy" (of the deck being tested) or a saved deck's id
  opponent?: string;
  opponentHandTraps?: boolean;
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
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [hand, setHand] = useState(saved.hand ?? 5);
  const [chosen, setChosen] = useState<number[]>(saved.chosen ?? []);
  const [ignoreHandTraps, setIgnoreHandTraps] = useState(saved.ignoreHandTraps ?? false);
  const [opponent, setOpponent] = useState(saved.opponent ?? "copy");
  const [opponentHandTraps, setOpponentHandTraps] = useState(saved.opponentHandTraps ?? false);
  const [goSecond, setGoSecond] = useState(saved.goSecond ?? false);
  const [view, setView] = useState<DuelView | null>(null);
  const [texts, setTexts] = useState(new Map<number, CardText>());
  const [cards, setCards] = useState(new Map<number, CardInfo>());
  const [banlist, setBanlist] = useState<{ name: string; limits: Record<number, number> }>({ name: "", limits: {} });
  const [error, setError] = useState("");
  const deck = decks.find((one) => one.id === deckId) ?? decks[0] ?? null;
  // the engine checking a deck's cards in the background (one deck at a time; a newer request replaces it)
  const [probe, setProbe] = useState<{ id: number; deckId: string; signature: string; done: number; total: number } | null>(null);
  const probeRef = useRef(probe);
  probeRef.current = probe;
  // the hand test on screen, saved with its deck as it is played (not while a saved one is being watched)
  // `from`: choices replayed from a saved test, not saved again until you make one of your own
  const test = useRef<{ id: string; deckId: string; date: number; testOf?: number; worked?: boolean; board?: number[]; from: number } | null>(null);
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
            const saved = { keys: route.keys, board: route.board, interruptions: route.interruptions, coverage: route.coverage, full: route.full, aimed, tried: route.tried, date: Date.now(), signature: deckSignature(one), record: line };
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
      } else if (message.type === "choke") {
        const job = chokingRef.current;
        if (!job || job.id !== message.id || !message.done) return;
        const chokes = message.done;
        setDecks((all) => all.map((one) => (one.id === job.deckId && one.routes?.[job.code] ? { ...one, routes: { ...one.routes, [job.code]: { ...one.routes[job.code], chokes } } } : one)));
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
  useEffect(() => save({ deckId: deck?.id ?? "", hand, chosen, ignoreHandTraps, opponent, opponentHandTraps, goSecond }), [deck, hand, chosen, ignoreHandTraps, opponent, opponentHandTraps, goSecond]);
  // the opponent's deck for a new duel, shuffled
  const opponentDeck = () => {
    const source = opponent === "none" ? null : opponent === "copy" ? deck : decks.find((one) => one.id === opponent) ?? deck;
    return source && source.main.length ? { opponent: { main: shuffled(source.main), extra: source.extra }, opponentHandTraps, goSecond } : {};
  };

  // errors clear themselves so they never sit over the field for long
  useEffect(() => {
    if (!error || !view) return;
    const clear = window.setTimeout(() => setError(""), 6000);
    return () => window.clearTimeout(clear);
  }, [error, view]);

  // card names for the opening hand picker come from the worker once the cards are loaded
  const unique = useMemo(() => [...new Set(deck?.main ?? [])], [deck]);
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

  const importText = async (text: string, fileName = "") => {
    try {
      const imported = await importDeck(text, fileName);
      const name = fileName.replace(/\.(ydk|txt)$/i, "") || "Imported deck";
      if ("deck" in imported) return addDeck({ ...imported.deck, name });
      // YGO Omega keeps Main and Extra together: split them by card type
      const found = await info([...imported.unsplit.mainAndExtra, ...imported.unsplit.side]);
      const known = new Map(found.map((card) => [card.asked, card]));
      const isExtra = (code: number) => ((known.get(code)?.type ?? 0) & EXTRA_TYPES) !== 0;
      addDeck({ name, main: imported.unsplit.mainAndExtra.filter((code) => !isExtra(code)), extra: imported.unsplit.mainAndExtra.filter(isExtra), side: imported.unsplit.side });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
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
    post({ type: "choke", id, main: target.main, extra: target.extra, hand: first.hand, keys: route.keys, goal: target.fullAt ?? 3 });
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
    keep(current.deckId, { ...record, id: current.id, date: current.date, testOf: current.testOf, worked: current.worked, board: current.board });
  }, [record]);
  const newTest = (testOf?: number, from = 0) => {
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
    setWorked(current.worked);
    keep(current.deckId, { ...record, id: current.id, date: current.date, testOf: current.testOf, worked: current.worked, board: current.board });
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
    if (from > 0) post({ type: "jump", ...options, picks: saved.picks.slice(0, from) });
    else {
      setReplay({ picks: saved.picks, at: 0 });
      post({ type: "start", ...options });
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
    post({ type: "start", main: shuffled(deck.main), extra: deck.extra, ...use, ...opponentDeck(), seed: Math.floor(Math.random() * 2 ** 31) });
  }, [deck, hand, chosen, ignoreHandTraps, opponent, opponentHandTraps, goSecond, decks]);

  const requestText = useCallback(
    (code: number) => {
      if (!texts.has(code)) post({ type: "text", code });
    },
    [texts],
  );

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
          leave={() => (skip(), setReplay(null), setView(null))}
          skip={skip}
          worked={worked}
          onWorked={record && !replay ? markWorked : undefined}
          replaying={replay ? { at: replay.at, of: replay.picks.length, stop: () => (setReplay(null), newTest(test.current?.testOf, replay.at)) } : null}
          states={(decks.find((one) => one.id === test.current?.deckId) ?? deck)?.saves ?? []}
          onSaveState={saveState}
          onLoadState={loadState}
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
        requestText={requestText}
        search={search}
        onChange={changeDeck}
        onClose={() => setEditing(false)}
        onTest={(chosen) => start(chosen ? { chosen } : undefined)}
        engineProgress={probe && probe.deckId === deck.id ? probe : null}
        routing={routing && routing.deckId === deck.id ? { code: routing.code, tried: routing.tried, waiting: routing.queue.map((one) => one.code) } : null}
        choking={choking && choking.deckId === deck.id ? { code: choking.code, waiting: choking.queue.map((one) => one.code) } : null}
        onFindLines={(starts) => findLines(deck, starts)}
        onWatchLine={(line, code) => watch({ ...line, id: newId(), date: Date.now(), testOf: code })}
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
            <textarea value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="A ydke:// link, a YGO Omega deck code, or the text of a .ydk file" rows={3} />
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
            <button className="button primary" disabled={!ready || deck.main.length === 0} onClick={() => start()}>
              Test hand
            </button>
            <button className="button" disabled={!ready} onClick={() => setEditing(true)}>
              Edit deck
            </button>
            <button className="button ghost" onClick={() => { if (confirm(`Delete "${deck.name}"?`)) setDecks((all) => all.filter((one) => one.id !== deck.id)); }}>
              Delete
            </button>
          </div>
        )}
      </section>

      {deck && (
        <>
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
            {opponent !== "none" && (
              <div className="segmented two">
                <button className={`button ${!opponentHandTraps ? "on" : ""}`} onClick={() => setOpponentHandTraps(false)}>
                  No hand traps on my turn
                </button>
                <button className={`button ${opponentHandTraps ? "on" : ""}`} onClick={() => setOpponentHandTraps(true)}>
                  Hand traps on my turn
                </button>
              </div>
            )}
            <p className="muted">
              End your turn and the computer plays theirs: it activates everything it can, summons, then attacks. You are asked whenever you can respond, so you can see where
              your interruptions go. Import any deck (a meta deck, board breakers) to play against it.
            </p>
          </section>

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

          {deck.tests && deck.tests.length > 0 && <Tests tests={deck.tests} nameOf={nameOf} onWatch={watch} onDelete={(id) => changeDeck({ ...deck, tests: deck.tests!.filter((one) => one.id !== id) })} />}
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
