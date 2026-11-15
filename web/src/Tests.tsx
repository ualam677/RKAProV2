// Saved hand tests for a deck: what each opened with, what you did, what it ended on. Watch one again, or jump to any
// choice in it and play on from there yourself.
import { useState } from "react";
import type { SavedTest } from "./decks";
import type { Interruption } from "./engine/interruptions";
import { CardArt } from "./CardArt";
import { describeInterruption, describeNibiru, describeProtection, shortWhat } from "./interruptText";

interface Props {
  tests: SavedTest[];
  nameOf: (code: number) => string;
  onWatch: (test: SavedTest, from?: number) => void;
  onDelete: (id: string) => void;
  onVideo: (test: SavedTest) => void;
  onShare: (test: SavedTest) => void;
  onWorked: (test: SavedTest) => void;
  // a video being made: which test, and how far (0-1)
  video: { id: string; share: number } | null;
  // a replay being prepared for watching
  loading?: boolean;
}

const when = (date: number) => {
  const minutes = Math.round((Date.now() - date) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(date).toLocaleDateString();
};

// "Galaxy Wizard · 3× Ash Blossom & Joyous Spring · Droll & Lock Bird"
const grouped = (codes: number[], nameOf: (code: number) => string) => {
  const tally = new Map<number, number>();
  codes.forEach((code) => tally.set(code, (tally.get(code) ?? 0) + 1));
  return [...tally].map(([code, count]) => `${count > 1 ? `${count}× ` : ""}${nameOf(code)}`).join(" · ");
};

export function Tests({ tests, nameOf, onWatch, onDelete, onVideo, onShare, onWorked, video, loading }: Props) {
  const [onlyWorked, setOnlyWorked] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  const shown = onlyWorked ? tests.filter((test) => test.worked) : tests;
  const working = tests.filter((test) => test.worked).length;

  return (
    <section className="tests">
      <div className="tests-head">
        <div className="segmented two tests-filter">
          <button className={`button small ${onlyWorked ? "" : "on"}`} onClick={() => setOnlyWorked(false)}>
            All {tests.length}
          </button>
          <button className={`button small ${onlyWorked ? "on" : ""}`} onClick={() => setOnlyWorked(true)}>
            ✓ {working}
          </button>
        </div>
        <button className={`icon-button small ${about ? "on" : ""}`} onClick={() => setAbout(!about)} aria-label="What is kept" aria-expanded={about}>
          ⓘ
        </button>
      </div>
      {about && <p className="trait-said">Every test is saved as you play. The newest 5 are kept; working ones are kept for good, with the board they ended on.</p>}
      {shown.length === 0 && <p className="muted">No working tests yet.</p>}
      {shown.map((test) => {
        const expanded = open === test.id;
        const actions = test.steps.filter((step) => step.idle).length;
        const stops = test.interruptions;
        return (
          <div className={`test ${test.worked ? "worked" : ""} ${expanded ? "open" : ""}`} key={test.id}>
            <button className="test-head" onClick={() => (setOpen(expanded ? null : test.id), setMore(null))} aria-expanded={expanded} aria-label={`${grouped(test.startHand, nameOf) || "Hand"}, ${when(test.date)}`}>
              <span className="test-hand-cards" aria-hidden="true">
                {test.startHand.map((code, index) => (
                  <span key={index} className="hand-mini">
                    <CardArt code={code} />
                    <i>{nameOf(code)}</i>
                  </span>
                ))}
              </span>
              <span className="test-meta">
                {test.worked ? (
                  <span className={`int-badge ${!stops ? "" : stops.length ? "good" : "warn"}`}>
                    {stops ? stops.length : "…"}
                    <small>INT</small> ✓
                  </span>
                ) : null}
                {test.worked && test.nibiru && <span className={`route-mark ${test.nibiru.proof ? "good" : "warn"}`}>N {test.nibiru.proof ? "✓" : "✕"}</span>}
                {test.worked && test.protection && test.protection.length > 0 && (
                  <span className="route-mark good" aria-label="Protection on their turn">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" />
                    </svg>
                  </span>
                )}
                <small className="muted">
                  {when(test.date)} · {actions} move{actions === 1 ? "" : "s"}
                </small>
              </span>
              {test.worked && test.board && test.board.length > 0 && <EndBoard board={test.board} interruptions={stops ?? []} nameOf={nameOf} />}
            </button>
            {expanded && (
              <div className="test-body">
                {test.worked && (stops?.length || test.nibiru || test.protection?.length) ? (
                  <p className="trait-said">
                    {stops?.length ? stops.map((one) => describeInterruption(one, nameOf)).join(" · ") : "No interruptions"}
                    {test.nibiru && <><br />{describeNibiru(test.nibiru, nameOf)}</>}
                    {test.protection && test.protection.length > 0 && <><br />Protection: {test.protection.map((one) => describeProtection(one, nameOf)).join(" · ")}</>}
                  </p>
                ) : null}
                <div className="test-actions">
                  <button className="button primary test-watch" disabled={loading} onClick={() => onWatch(test)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 4v16l13-8z" />
                    </svg>
                    {loading ? "Loading…" : "Watch"}
                  </button>
                  <button className={`button test-worked ${test.worked ? "on" : ""}`} onClick={() => onWorked(test)} aria-pressed={!!test.worked}>
                    {test.worked ? "✓ Working" : "Working?"}
                  </button>
                  <button className="icon-button" onClick={() => setMore(more === test.id ? null : test.id)} aria-label="More" aria-expanded={more === test.id}>
                    ⋯
                  </button>
                </div>
                {more === test.id && (
                  <div className="test-more">
                    <button className="button" disabled={!!video} onClick={() => onVideo(test)}>
                      {video?.id === test.id ? `Video ${Math.round(video.share * 100)}%` : "Save as video"}
                    </button>
                    <button className="button" onClick={() => onShare(test)}>
                      Share link
                    </button>
                    <button className="button danger" onClick={() => onDelete(test.id)}>
                      Delete
                    </button>
                  </div>
                )}
                <ol className="test-steps">
                  {test.steps.map((step, index) => (
                    <li key={index} className={step.idle ? "idle" : ""}>
                      <span>{step.text}</span>
                      <button className="play-round small" onClick={() => onWatch(test, index)} aria-label={`Play on from before: ${step.text}`} title="Play on from just before this choice">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M7 4v16l13-8z" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** A line's end board in small cards: the ones that interrupt lit, with what they do, then the ones off the field. */
export function EndBoard({ board, interruptions, nameOf }: { board: number[]; interruptions: Interruption[]; nameOf: (code: number) => string }) {
  return (
    <span className="test-cards">
      {board.map((code, index) => {
        const uses = interruptions.filter((one) => (one.code === code || nameOf(one.code) === nameOf(code)) && one.from !== "hand" && one.from !== "gy");
        return (
          <span key={index} className={`test-card ${uses.length ? "interrupts" : ""}`} title={nameOf(code)}>
            <i>{nameOf(code)}</i>
            <CardArt code={code} />
            {uses.length > 0 && <small>{[...new Set(uses.map((one) => (one.via ? "→ " : "") + shortWhat(one)))].join(" + ")}</small>}
          </span>
        );
      })}
      {interruptions
        // ones not on the field: a Trap still in the hand to Set, a hand trap, an effect in the GY
        .filter((one) => one.from === "hand" || one.from === "gy" || !board.some((code) => code === one.code || nameOf(code) === nameOf(one.code)))
        .map((one, index) => (
          <span key={`off${index}`} className="test-card interrupts off" title={describeInterruption(one, nameOf)}>
            <i>{nameOf(one.code)}</i>
            <CardArt code={one.code} />
            <small>
              {(one.via ? "→ " : "") + shortWhat(one)}
              <br />
              {one.from === "hand" ? "HAND" : one.from === "gy" ? "GY" : "SET"}
            </small>
          </span>
        ))}
    </span>
  );
}
