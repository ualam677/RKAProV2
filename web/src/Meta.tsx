// The Meta screen: the last month of TCG tournament tops (yugiohmeta.com, refreshed weekly by the deploy), the hand
// traps the field plays, and which of your cards the latest ban list moved. Everything shown is counted from the lists;
// nothing is written about the decks.
import { useState } from "react";
import { CardArt } from "./CardArt";

export interface MetaCard {
  name: string;
  pct: number;
}
export interface MetaType {
  name: string;
  count: number;
  share: number;
  lists: number;
  wins: number;
  core: MetaCard[];
  flex: MetaCard[];
  // what it sides in (a third of its side decks or more)
  side?: MetaCard[];
  list: { main: { name: string; amount: number }[]; extra: { name: string; amount: number }[]; side: { name: string; amount: number }[]; placement?: number; event: string; url: string } | null;
}
export interface MetaData {
  fetched: string;
  source: string;
  banlist: string;
  range: string;
  totalDecks: number;
  lists: number;
  newest: string;
  types: MetaType[];
  cards: Record<string, number>;
  banChanges: { date: string; changes: { name: string; from: string; to: string }[] } | null;
  // the most sided cards across every list
  sided?: MetaCard[];
  // last week's numbers: each deck's share, each card's share of lists
  previous?: { fetched: string; shares: Record<string, number>; cards: Record<string, number> } | null;
}

// what moved since last week: decks by share points, cards by share of lists
function moves(meta: MetaData) {
  const before = meta.previous;
  if (!before) return null;
  const decks = meta.types
    .map((type) => ({ name: type.name, now: type.share, delta: Math.round((type.share - (before.shares[type.name] ?? 0)) * 10) / 10, isNew: before.shares[type.name] === undefined }))
    .filter((one) => one.isNew || Math.abs(one.delta) >= 0.5)
    .sort((a, b) => b.delta - a.delta);
  const names = new Set([...Object.keys(meta.cards), ...Object.keys(before.cards)]);
  const cards = [...names]
    .map((name) => ({ name, now: meta.cards[name] ?? 0, delta: (meta.cards[name] ?? 0) - (before.cards[name] ?? 0) }))
    .filter((one) => Math.abs(one.delta) >= 5)
    .sort((a, b) => b.delta - a.delta);
  return { since: before.fetched, decks, up: cards.filter((one) => one.delta > 0).slice(0, 8), down: cards.filter((one) => one.delta < 0).reverse().slice(0, 8) };
}

interface Props {
  meta: MetaData | null;
  failed: boolean;
  // card name → passcode (null: not in this card database)
  codeOf: (name: string) => number | null;
  // cards in the decks' lists this card database doesn't know (left out of an import or an opponent)
  unmatched: string[];
  // the hand traps among the field's cards, most played first
  handTraps: MetaCard[];
  // ban list changes that touch your decks: the card, the move, the decks it is in
  yourChanges: { name: string; from: string; to: string; decks: string[] }[];
  opponent?: string;
  onImport: (type: MetaType) => void;
  onOpponent: (type: MetaType) => void;
  onTraps: (codes: number[]) => void;
  onBack: () => void;
}

const when = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

function Minis({ cards, codeOf, sign }: { cards: MetaCard[]; codeOf: (name: string) => number | null; sign?: boolean }) {
  return (
    <div className="meta-minis">
      {cards.map((one) => {
        const code = codeOf(one.name);
        return (
          <span key={one.name} className="meta-mini" title={one.name}>
            {code ? <CardArt code={code} /> : <span className="meta-unknown">{one.name}</span>}
            <b className={sign ? (one.pct > 0 ? "up" : "down") : ""}>
              {sign && one.pct > 0 ? "+" : ""}
              {one.pct}
              {sign ? "" : "%"}
            </b>
          </span>
        );
      })}
    </div>
  );
}

export function MetaScreen({ meta, failed, codeOf, unmatched, handTraps, yourChanges, opponent, onImport, onOpponent, onTraps, onBack }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="screen-head">
        <button className="icon-button" onClick={onBack} aria-label="Menu">
          ‹
        </button>
        <h2>Meta</h2>
      </div>
      {!meta ? (
        <p className="muted">{failed ? "The meta report couldn't be loaded. It comes with the app's weekly update; try again online." : "Loading the meta report…"}</p>
      ) : (
        <div className="meta">
          <div className="meta-info">
            <b>{meta.banlist} list</b>
            <small>
              {meta.totalDecks} tournament tops, {meta.range.toLowerCase()} · newest {when(meta.newest)} · updated {when(meta.fetched)} ·{" "}
              <a href="https://www.yugiohmeta.com/top-decks" target="_blank" rel="noreferrer">
                {meta.source}
              </a>
            </small>
            {unmatched.length > 0 && (
              <details className="meta-warn">
                <summary>
                  {unmatched.length} new card{unmatched.length === 1 ? "" : "s"} not in the card database yet: left out of imports
                </summary>
                {unmatched.join(", ")}
              </details>
            )}
          </div>

          {(() => {
            const moved = moves(meta);
            if (!moved) return <p className="meta-note">What moved since last week shows here after the next weekly update.</p>;
            const sign = (delta: number) => `${delta > 0 ? "▲ +" : "▼ "}${delta}`;
            return (
              <>
                <p className="section-label">
                  Since {when(moved.since)} <small>share of tops</small>
                </p>
                {moved.decks.length ? (
                  <div className="meta-moves">
                    {moved.decks.map((one) => (
                      <span key={one.name} className={`meta-move ${one.delta > 0 || one.isNew ? "up" : "down"}`}>
                        <b>{one.name}</b>
                        <i>{one.isNew ? "NEW" : `${sign(one.delta)}%`}</i>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="meta-note">No deck moved by half a point or more.</p>
                )}
                {moved.up.length > 0 && (
                  <>
                    <p className="meta-label">
                      Played more <small>change in % of lists</small>
                    </p>
                    <Minis cards={moved.up.map((one) => ({ name: one.name, pct: one.delta }))} codeOf={codeOf} sign />
                  </>
                )}
                {moved.down.length > 0 && (
                  <>
                    <p className="meta-label">Played less</p>
                    <Minis cards={moved.down.map((one) => ({ name: one.name, pct: one.delta }))} codeOf={codeOf} sign />
                  </>
                )}
              </>
            );
          })()}

          <p className="section-label">Top decks</p>
          {meta.types.map((type, rank) => {
            const expanded = open === type.name;
            const face = codeOf(type.core[0]?.name ?? "");
            return (
              <div key={type.name} className={`meta-deck ${expanded ? "open" : ""}`}>
                <button className="meta-deck-head" onClick={() => setOpen(expanded ? null : type.name)} aria-expanded={expanded}>
                  <span className="meta-rank">{rank + 1}</span>
                  <span className="meta-face">{face ? <CardArt code={face} /> : null}</span>
                  <span className="meta-deck-name">
                    <b>{type.name}</b>
                    <span className="meta-bar">
                      <i style={{ width: `${Math.min(100, type.share * 4)}%` }} />
                    </span>
                    <small>
                      {type.count} tops · {type.share}% · {type.wins} {type.wins === 1 ? "win" : "wins"}
                    </small>
                  </span>
                  <span className="meta-chev" aria-hidden="true">
                    ›
                  </span>
                </button>
                {expanded && (
                  <div className="meta-deck-body">
                    {type.core.length > 0 && (
                      <>
                        <p className="meta-label">
                          Core <small>in 90%+ of {type.lists} lists</small>
                        </p>
                        <Minis cards={type.core} codeOf={codeOf} />
                      </>
                    )}
                    {type.flex.length > 0 && (
                      <>
                        <p className="meta-label">Flex</p>
                        <Minis cards={type.flex} codeOf={codeOf} />
                      </>
                    )}
                    {type.side && type.side.length > 0 && (
                      <>
                        <p className="meta-label">
                          Side <small>% of its side decks</small>
                        </p>
                        <Minis cards={type.side} codeOf={codeOf} />
                      </>
                    )}
                    {type.list && (
                      <p className="meta-from">
                        Its list: {type.list.placement === 1 ? "1st" : `top ${type.list.placement}`} at a {type.list.event}
                        {type.list.url && (
                          <>
                            {" · "}
                            <a href={type.list.url} target="_blank" rel="noreferrer">
                              see it
                            </a>
                          </>
                        )}
                      </p>
                    )}
                    {type.list && (
                      <div className="meta-actions">
                        <button className="button primary" onClick={() => onImport(type)}>
                          Import as deck
                        </button>
                        <button className={`button ${opponent === type.name ? "on" : ""}`} onClick={() => onOpponent(type)}>
                          {opponent === type.name ? "✓ Your opponent" : "Test against it"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {handTraps.length > 0 && (
            <>
              <p className="section-label">
                Hand traps in the meta <small>% of lists</small>
              </p>
              <Minis cards={handTraps} codeOf={codeOf} />
              <button className="button primary meta-wide" onClick={() => onTraps(handTraps.slice(0, 3).flatMap((one) => codeOf(one.name) ?? []))}>
                Use the top 3 as your opponent's hand traps
              </button>
            </>
          )}

          {meta.sided && meta.sided.length > 0 && (
            <>
              <p className="section-label">
                Most sided <small>% of side decks</small>
              </p>
              <Minis cards={meta.sided.slice(0, 12)} codeOf={codeOf} />
            </>
          )}

          {meta.banChanges && (
            <>
              <p className="section-label">
                Your decks vs the {when(meta.banChanges.date)} list
              </p>
              <div className="meta-changes">
                {yourChanges.length ? (
                  yourChanges.map((one) => {
                    const code = codeOf(one.name);
                    return (
                      <div key={one.name} className="meta-change">
                        <span className="meta-face">{code ? <CardArt code={code} /> : null}</span>
                        <span className="meta-deck-name">
                          <b>{one.name}</b>
                          <small>
                            {one.from} → {one.to} · in {one.decks.join(", ")}
                          </small>
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <p className="meta-none">None of the {meta.banChanges.changes.length} changes touch your decks ✓</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
