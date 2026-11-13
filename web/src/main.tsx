import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseYdk, shuffled, type Deck } from "./deck";
import { Duel } from "./Duel";
import { CardArt } from "./CardArt";
import type { CardText, DuelView, FromWorker, ToWorker } from "./engine/protocol";
import "./style.css";

// remembered on this device only, so the phone opens straight to the last deck
const SAVED = "rka.handtest";
interface Saved {
  deckText: string;
  deckName: string;
  hand: number;
  chosen: number[];
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

function App() {
  const worker = useRef<Worker | null>(null);
  const saved = useMemo(loadSaved, []);
  const [status, setStatus] = useState("Starting");
  const [ready, setReady] = useState(false);
  const [deckText, setDeckText] = useState(saved.deckText ?? "");
  const [deckName, setDeckName] = useState(saved.deckName ?? "");
  const [hand, setHand] = useState(saved.hand ?? 5);
  const [chosen, setChosen] = useState<number[]>(saved.chosen ?? []);
  const [view, setView] = useState<DuelView | null>(null);
  const [texts, setTexts] = useState(new Map<number, CardText>());
  const [error, setError] = useState("");
  const deck: Deck | null = useMemo(() => (deckText ? parseYdk(deckText) : null), [deckText]);

  const post = (message: ToWorker) => worker.current?.postMessage(message);

  useEffect(() => {
    const instance = new Worker(new URL("./engine/worker.ts", import.meta.url), { type: "module" });
    worker.current = instance;
    instance.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === "progress") setStatus(message.text);
      else if (message.type === "ready") {
        setReady(true);
        setStatus(`${message.cards.toLocaleString()} cards loaded`);
      } else if (message.type === "view") setView(message.view);
      else if (message.type === "text") setTexts((known) => new Map(known).set(message.card.code, message.card));
      else if (message.type === "error") setError(message.text);
    };
    instance.postMessage({ type: "init" } satisfies ToWorker);
    return () => instance.terminate();
  }, []);

  useEffect(() => save({ deckText, deckName, hand, chosen }), [deckText, deckName, hand, chosen]);

  // card names for the opening hand picker come from the worker once the cards are loaded
  const unique = useMemo(() => [...new Set(deck?.main ?? [])], [deck]);
  useEffect(() => {
    if (ready) unique.forEach((code) => texts.has(code) || post({ type: "text", code }));
  }, [ready, unique]);

  const loadDeck = async (file: File | undefined) => {
    if (!file) return;
    setDeckText(await file.text());
    setDeckName(file.name.replace(/\.ydk$/i, ""));
    setChosen([]);
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
    post({ type: "start", main: shuffled(deck.main), extra: deck.extra, hand, chosen, seed: Math.floor(Math.random() * 2 ** 31) });
  }, [deck, hand, chosen]);

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
        <Duel view={view} texts={texts} requestText={requestText} answer={(picks) => post({ type: "answer", picks })} restart={start} leave={() => setView(null)} />
      </>
    );
  }

  const nameOf = (code: number) => texts.get(code)?.name ?? `#${code}`;
  return (
    <main className="start">
      <header>
        <h1>RKAPro</h1>
        <p className="status">{status}</p>
      </header>

      <section className="panel">
        <label className="button">
          {deck ? `${deckName} (${deck.main.length} + ${deck.extra.length})` : "Open a deck (.ydk)"}
          <input type="file" accept=".ydk" hidden onChange={(event) => loadDeck(event.target.files?.[0])} />
        </label>
        <button className="button primary" disabled={!ready || !deck} onClick={start}>
          Test hand
        </button>
      </section>
      {error && <p className="error">{error}</p>}

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
