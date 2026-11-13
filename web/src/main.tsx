import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseYdk, shuffled } from "./deck";
import { Duel, cueTime } from "./Duel";
import { DeckEditor } from "./DeckEditor";
import { CardArt } from "./CardArt";
import { EXTRA_TYPES, importDeck, loadDecks, newId, storeDecks, type SavedDeck } from "./decks";
import type { CardInfo, CardSearch, CardText, DuelView, FromWorker, ToWorker } from "./engine/protocol";
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
  const [deckId, setDeckId] = useState(saved.deckId ?? decks[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [hand, setHand] = useState(saved.hand ?? 5);
  const [chosen, setChosen] = useState<number[]>(saved.chosen ?? []);
  const [ignoreHandTraps, setIgnoreHandTraps] = useState(saved.ignoreHandTraps ?? false);
  const [view, setView] = useState<DuelView | null>(null);
  const [texts, setTexts] = useState(new Map<number, CardText>());
  const [cards, setCards] = useState(new Map<number, CardInfo>());
  const [banlist, setBanlist] = useState<{ name: string; limits: Record<number, number> }>({ name: "", limits: {} });
  const [error, setError] = useState("");
  const deck = decks.find((one) => one.id === deckId) ?? decks[0] ?? null;

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
      } else if (message.type === "error") setError(message.text);
    };
    instance.postMessage({ type: "init" } satisfies ToWorker);
    return () => instance.terminate();
  }, []);

  useEffect(() => storeDecks(decks), [decks]);
  useEffect(() => save({ deckId: deck?.id ?? "", hand, chosen, ignoreHandTraps }), [deck, hand, chosen, ignoreHandTraps]);

  // errors clear themselves so they never sit over the field for long
  useEffect(() => {
    if (!error || !view) return;
    const clear = window.setTimeout(() => setError(""), 6000);
    return () => window.clearTimeout(clear);
  }, [error, view]);

  // card names for the opening hand picker come from the worker once the cards are loaded
  const unique = useMemo(() => [...new Set(deck?.main ?? [])], [deck]);
  useEffect(() => {
    if (ready) unique.forEach((code) => texts.has(code) || post({ type: "text", code }));
  }, [ready, unique]);

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

  const start = useCallback(() => {
    if (!deck) return;
    setError("");
    setEditing(false);
    // whatever was still being shown from the last hand is dropped
    window.clearTimeout(timer.current);
    timer.current = 0;
    queue.current = [];
    post({ type: "start", main: shuffled(deck.main), extra: deck.extra, hand, chosen, ignoreHandTraps, seed: Math.floor(Math.random() * 2 ** 31) });
  }, [deck, hand, chosen, ignoreHandTraps]);

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
        <Duel view={view} texts={texts} requestText={requestText} answer={(picks) => post({ type: "answer", picks })} restart={start} leave={() => (skip(), setView(null))} skip={skip} />
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
        onTest={start}
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
            <button className="button primary" disabled={!ready || deck.main.length === 0} onClick={start}>
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
            <p className="muted">Ignore: cards in your hand never ask to be chained, so a combo test is not interrupted by Ash or Fuwalos.</p>
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
