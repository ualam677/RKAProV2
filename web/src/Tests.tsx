// Saved hand tests for a deck: what each opened with, what you did, what it ended on. Watch one again, or jump to any
// choice in it and play on from there yourself.
import { useState } from "react";
import type { SavedTest } from "./decks";

interface Props {
  tests: SavedTest[];
  nameOf: (code: number) => string;
  onWatch: (test: SavedTest, from?: number) => void;
  onDelete: (id: string) => void;
  onVideo: (test: SavedTest) => void;
  // a video being made: which test, and how far (0-1)
  video: { id: string; share: number } | null;
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

export function Tests({ tests, nameOf, onWatch, onDelete, onVideo, video }: Props) {
  const [onlyWorked, setOnlyWorked] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const shown = onlyWorked ? tests.filter((test) => test.worked) : tests;
  const working = tests.filter((test) => test.worked).length;

  return (
    <section className="box tests">
      <div className="box-head">
        <h2>Saved tests</h2>
        <div className="segmented two tests-filter">
          <button className={`button small ${onlyWorked ? "" : "on"}`} onClick={() => setOnlyWorked(false)}>
            All {tests.length}
          </button>
          <button className={`button small ${onlyWorked ? "on" : ""}`} onClick={() => setOnlyWorked(true)}>
            Worked {working}
          </button>
        </div>
      </div>
      <p className="muted">Every hand test is saved as you play. In the duel menu, "This worked" keeps it for good and records the board you ended on.</p>
      {shown.length === 0 && <p className="muted">No working tests yet.</p>}
      {shown.map((test) => {
        const expanded = open === test.id;
        const actions = test.steps.filter((step) => step.idle).length;
        return (
          <div className={`test ${test.worked ? "worked" : ""}`} key={test.id}>
            <button className="test-head" onClick={() => setOpen(expanded ? null : test.id)}>
              <span className="test-hand">{grouped(test.startHand, nameOf) || "Hand"}</span>
              <span className="muted">
                {test.worked && <b className="test-badge">✓ Worked</b>} {when(test.date)} · {actions} action{actions === 1 ? "" : "s"}
              </span>
              {test.worked && test.board && test.board.length > 0 && <span className="test-board">Ended on {grouped(test.board, nameOf)}</span>}
              {test.worked && test.interruptions && (
                <span className={`test-board ${test.interruptions.length ? "" : "warn"}`}>
                  {test.interruptions.length
                    ? `${test.interruptions.length} interruption${test.interruptions.length > 1 ? "s" : ""}: ${test.interruptions.map((one) => `${nameOf(one.code)} (${one.kind}${one.from === "set" ? ", Set" : one.from === "hand" ? ", from the hand" : one.from === "gy" ? ", in the GY" : ""})`).join(", ")}`
                    : "No interruptions on this board"}
                </span>
              )}
            </button>
            {expanded && (
              <div className="test-body">
                <div className="test-actions">
                  <button className="button small primary" onClick={() => onWatch(test)}>
                    Watch
                  </button>
                  <button className="button small" disabled={!!video} onClick={() => onVideo(test)}>
                    {video?.id === test.id ? `Video ${Math.round(video.share * 100)}%` : "Save as video"}
                  </button>
                  <button className="button small ghost" onClick={() => onDelete(test.id)}>
                    Delete
                  </button>
                </div>
                <ol className="test-steps">
                  {test.steps.map((step, index) => (
                    <li key={index} className={step.idle ? "idle" : ""}>
                      <span>{step.text}</span>
                      <button className="opt-link" onClick={() => onWatch(test, index)} title="Jump to just before this choice and play on yourself">
                        Play from here
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
