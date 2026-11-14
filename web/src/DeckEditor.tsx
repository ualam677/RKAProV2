// Deck editor after EDOPro's (gframe/deck_con.cpp): search with filters on one side, Main / Extra / Side on the other,
// the ban list and deck size rules shown as you build. Phones get the Duel Links arrangement: deck on top, search below.
import { useEffect, useMemo, useRef, useState } from "react";
import { CardArt } from "./CardArt";
import { Optimiser } from "./Optimiser";
import { EXTRA_TYPES, toOmega, toYdk, toYdke, type SavedDeck } from "./decks";
import type { CardInfo, CardSearch, CardText, TestRecord } from "./engine/protocol";

interface Props {
  deck: SavedDeck;
  cards: Map<number, CardInfo>;
  texts: Map<number, CardText>;
  banlist: { name: string; limits: Record<number, number> };
  requestInfo: (codes: number[]) => void;
  traits: Map<number, string[]>;
  cutResult: { cut: number; lines?: { start: number; before: number; after: number; board: number[] }[] } | null;
  onCutTest: (code: number) => void;
  requestTraits: (codes: number[]) => void;
  requestText: (code: number) => void;
  search: (query: CardSearch) => Promise<{ results: CardInfo[]; more: boolean }>;
  onChange: (deck: SavedDeck) => void;
  onClose: () => void;
  onTest: (chosen?: number[]) => void;
  engineProgress: { done: number; total: number } | null;
  onCheck: () => void;
  routing: { code: number; tried: number; waiting: number[] } | null;
  choking: { code: number; waiting: number[] } | null;
  onFindLines: (starts: { code: number; hand: number[] }[]) => void;
  onCheckChokes: (starts: { code: number; hand: number[] }[]) => void;
  onWatchLine: (line: TestRecord, code: number) => void;
}

type Section = "main" | "extra" | "side";
const LIMITS: Record<Section, [number, number]> = { main: [40, 60], extra: [0, 15], side: [0, 15] };
const TITLES: Record<Section, string> = { main: "Main", extra: "Extra", side: "Side" };

const ATTRIBUTES: [number, string][] = [[1, "EARTH"], [2, "WATER"], [4, "FIRE"], [8, "WIND"], [16, "LIGHT"], [32, "DARK"], [64, "DIVINE"]];
const RACES = ["Warrior", "Spellcaster", "Fairy", "Fiend", "Zombie", "Machine", "Aqua", "Pyro", "Rock", "Winged Beast", "Plant", "Insect", "Thunder", "Dragon", "Beast", "Beast-Warrior", "Dinosaur", "Fish", "Sea Serpent", "Reptile", "Psychic", "Divine-Beast", "Creator God", "Wyrm", "Cyberse", "Illusion"];
const SUBTYPES: Record<string, [number, string][]> = {
  monster: [[0x10, "Normal"], [0x20, "Effect"], [0x80, "Ritual"], [0x40, "Fusion"], [0x2000, "Synchro"], [0x800000, "Xyz"], [0x1000000, "Pendulum"], [0x4000000, "Link"], [0x1000, "Tuner"]],
  spell: [[0x10000, "Quick-Play"], [0x20000, "Continuous"], [0x40000, "Equip"], [0x80000, "Field"], [0x80, "Ritual"]],
  trap: [[0x20000, "Continuous"], [0x100000, "Counter"]],
};

function frameOf(card?: CardInfo): string {
  if (!card) return "back";
  if (card.type & 2) return "spell";
  if (card.type & 4) return "trap";
  if (card.type & 0x4000000) return "link";
  if (card.type & 0x800000) return "xyz";
  if (card.type & 0x2000) return "synchro";
  if (card.type & 0x40) return "fusion";
  return "monster";
}

// EDOPro's deck order: monsters, Spells, Traps; Level high to low; then by name
function compare(a?: CardInfo, b?: CardInfo) {
  if (!a || !b) return 0;
  const group = (card: CardInfo) => (card.type & 1 ? 0 : card.type & 2 ? 1 : 2);
  return group(a) - group(b) || b.level - a.level || a.name.localeCompare(b.name);
}

function Thumb({ code, card, limit, onTap, onHold }: { code: number; card?: CardInfo; limit?: number; onTap: () => void; onHold: () => void }) {
  const [art, setArt] = useState(false);
  const timer = useRef(0);
  const held = useRef(false);
  return (
    <button
      className={`thumb tile ${frameOf(card)}`}
      onPointerDown={() => {
        held.current = false;
        timer.current = window.setTimeout(() => ((held.current = true), onHold()), 350);
      }}
      onPointerUp={() => window.clearTimeout(timer.current)}
      onPointerLeave={() => window.clearTimeout(timer.current)}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => (held.current ? (held.current = false) : onTap())}
      aria-label={card?.name ?? `#${code}`}
    >
      <CardArt code={code} onLoad={() => setArt(true)} />
      {!art && <span className="tile-name">{card?.name ?? code}</span>}
      {limit !== undefined && limit < 3 && <span className={`limit limit-${limit}`}>{limit}</span>}
    </button>
  );
}

export function DeckEditor({ deck, cards, texts, banlist, requestInfo, traits, requestTraits, cutResult, onCutTest, requestText, search, onChange, onClose, onTest, engineProgress, onCheck, routing, choking, onFindLines, onCheckChokes, onWatchLine }: Props) {
  const [query, setQuery] = useState<CardSearch>({});
  const [results, setResults] = useState<{ results: CardInfo[]; more: boolean }>({ results: [], more: false });
  const [filters, setFilters] = useState(false);
  const [detail, setDetail] = useState<{ code: number; from?: Section } | null>(null);
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState(false);
  // remembered for this visit, so coming back from a test or a watched line returns to the optimiser
  const [optimising, setOptimisingState] = useState(() => {
    try {
      return sessionStorage.getItem("rka.optimising") === "1";
    } catch {
      return false;
    }
  });
  const setOptimising = (on: boolean) => {
    setOptimisingState(on);
    try {
      sessionStorage.setItem("rka.optimising", on ? "1" : "0");
    } catch {
      // the editor just opens on the deck next time
    }
  };

  // everything in the deck needs its type (to split Main / Extra and sort) and name
  useEffect(() => {
    const missing = [...new Set([...deck.main, ...deck.extra, ...deck.side])].filter((code) => !cards.has(code));
    if (missing.length) requestInfo(missing);
  }, [deck]);

  // search as you type, a moment after the last key
  useEffect(() => {
    const empty = !query.text && !query.kind && query.attribute === undefined && query.race === undefined && query.level === undefined && query.limit === undefined && !query.atk && !query.def;
    if (empty) return setResults({ results: [], more: false });
    const wait = window.setTimeout(() => search(query).then(setResults), 160);
    return () => window.clearTimeout(wait);
  }, [query]);

  useEffect(() => {
    if (!notice) return;
    const clear = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(clear);
  }, [notice]);

  // copies of one card counted across Main, Extra and Side, alternate artworks included
  const nameKey = (code: number) => {
    const card = cards.get(code);
    return card?.alias && Math.abs(card.alias - code) < 20 ? card.alias : code;
  };
  const limitOf = (code: number) => banlist.limits[nameKey(code)] ?? banlist.limits[code] ?? 3;
  const copies = (code: number) => [...deck.main, ...deck.extra, ...deck.side].filter((other) => nameKey(other) === nameKey(code)).length;

  const update = (next: Partial<SavedDeck>) => onChange({ ...deck, ...next, updated: Date.now() });
  const add = (code: number, to?: Section) => {
    const card = cards.get(code);
    const section: Section = to ?? (card && card.type & EXTRA_TYPES ? "extra" : "main");
    if (copies(code) >= limitOf(code)) return setNotice(`${card?.name ?? "This card"}: ${limitOf(code) === 0 ? "Forbidden" : `only ${limitOf(code)} allowed`}`);
    if (deck[section].length >= LIMITS[section][1]) return setNotice(`The ${TITLES[section]} Deck is full`);
    update({ [section]: [...deck[section], code] });
  };
  const remove = (code: number, from: Section) => {
    const at = deck[from].lastIndexOf(code);
    if (at >= 0) update({ [from]: deck[from].filter((_, index) => index !== at) });
  };
  const move = (code: number, from: Section) => {
    const card = cards.get(code);
    const to: Section = from !== "side" ? "side" : card && card.type & EXTRA_TYPES ? "extra" : "main";
    if (deck[to].length >= LIMITS[to][1]) return setNotice(`The ${TITLES[to]} Deck is full`);
    const at = deck[from].lastIndexOf(code);
    update({ [from]: deck[from].filter((_, index) => index !== at), [to]: [...deck[to], code] });
  };
  const sort = () => update({ main: [...deck.main].sort((a, b) => compare(cards.get(a), cards.get(b))), extra: [...deck.extra].sort((a, b) => compare(cards.get(a), cards.get(b))), side: [...deck.side].sort((a, b) => compare(cards.get(a), cards.get(b))) });

  const show = (code: number, from?: Section) => {
    requestText(code);
    setDetail({ code, from });
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${what} copied`);
    } catch {
      setNotice("Could not copy");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([toYdk(deck)], { type: "text/plain" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${deck.name || "deck"}.ydk` });
    link.click();
    URL.revokeObjectURL(url);
  };

  const problems = useMemo(() => {
    const list: string[] = [];
    (Object.keys(LIMITS) as Section[]).forEach((section) => {
      const [min, max] = LIMITS[section];
      if (deck[section].length < min || deck[section].length > max) list.push(`${TITLES[section]} Deck: ${deck[section].length} (${min}-${max})`);
    });
    const seen = new Set<number>();
    for (const code of [...deck.main, ...deck.extra, ...deck.side]) {
      const key = nameKey(code);
      if (seen.has(key)) continue;
      seen.add(key);
      if (copies(code) > limitOf(code)) list.push(`${cards.get(code)?.name ?? code}: ${copies(code)} copies, ${limitOf(code)} allowed`);
    }
    return list;
  }, [deck, cards, banlist]);

  const section = (name: Section) => {
    const [min, max] = LIMITS[name];
    const count = deck[name].length;
    return (
      <section className={`deck-section deck-${name}`} key={name}>
        <h3 className={count < min || count > max ? "bad" : ""}>
          {TITLES[name]} <b>{count}</b>
        </h3>
        <div className="deck-grid">
          {deck[name].map((code, index) => (
            <Thumb key={`${code}-${index}`} code={code} card={cards.get(code)} limit={limitOf(code)} onTap={() => show(code, name)} onHold={() => show(code, name)} />
          ))}
        </div>
      </section>
    );
  };

  const buttons = detail && (
    <div className="stepper-row">
      {detail.from && (
        <button className="button" onClick={() => remove(detail.code, detail.from!)}>
          − 1
        </button>
      )}
      <button className="button primary" onClick={() => add(detail.code, detail.from === "side" ? "side" : undefined)}>
        + 1
      </button>
      {detail.from ? (
        <button className="button" onClick={() => (move(detail.code, detail.from!), setDetail(null))}>
          {detail.from === "side" ? "To deck" : "To side"}
        </button>
      ) : (
        <button className="button" onClick={() => add(detail.code, "side")}>
          + Side
        </button>
      )}
    </div>
  );

  const set = (patch: Partial<CardSearch>) => setQuery({ ...query, ...patch });
  const number = (value: string) => (value === "" ? null : Number(value));
  const detailCard = detail ? cards.get(detail.code) : undefined;
  const detailText = detail ? texts.get(detail.code) : undefined;

  return (
    <div className="editor">
      <header className="editor-head">
        <button className="icon-button" onClick={onClose} aria-label="Back">
          ‹
        </button>
        <input className="deck-name" value={deck.name} onChange={(event) => update({ name: event.target.value })} aria-label="Deck name" />
        <button className={`button small ${optimising ? "on" : ""}`} onClick={() => setOptimising(!optimising)}>
          {optimising ? "Build" : "Optimise"}
        </button>
        {!optimising && (
          <button className="button small" onClick={sort}>
            Sort
          </button>
        )}
        <button className="icon-button" onClick={() => setMenu(!menu)} aria-label="More">
          ⋯
        </button>
        {menu && (
          <div className="menu editor-menu" onClick={() => setMenu(false)}>
            <button className="button" onClick={() => onTest()}>
              Test hand
            </button>
            <button className="button" onClick={download}>
              Save as .ydk
            </button>
            <button className="button" onClick={() => copy(toYdke(deck), "ydke:// link")}>
              Copy ydke:// link
            </button>
            <button className="button" onClick={async () => copy(await toOmega(deck), "YGO Omega code")}>
              Copy YGO Omega code
            </button>
            <button className="button ghost" onClick={() => update({ main: [], extra: [], side: [] })}>
              Clear deck
            </button>
          </div>
        )}
      </header>
      <p className={`deck-status ${problems.length ? "bad" : ""}`}>{problems.length ? problems.join(" · ") : `Legal for ${banlist.name || "TCG"}`}</p>

      <div className={`editor-body ${optimising ? "optimising" : ""}`}>
        <aside className="editor-info">
          {detail ? (
            <>
              <div className="info-head">
                <div className="info-art">
                  <CardArt key={detail.code} code={detail.code} />
                </div>
                <div>
                  <h2>{detailCard?.name}</h2>
                  {detailText?.line && <p className="muted">{detailText.line}</p>}
                  <p className="muted">
                    In deck: {copies(detail.code)} / {limitOf(detail.code)}
                  </p>
                </div>
              </div>
              {buttons}
              {detailText?.text && <p className="card-text">{detailText.text}</p>}
            </>
          ) : (
            <p className="muted info-empty">Tap a card to read it.</p>
          )}
        </aside>

        <div className="deck-area">{(["main", "extra", "side"] as Section[]).map(section)}</div>

        {optimising ? (
          <Optimiser deck={deck} cards={cards} nameKey={nameKey} room={(key) => limitOf(key) - copies(key)} onChange={onChange} onShow={(code) => show(deck.main.find((one) => nameKey(one) === code) ?? code, "main")} requestInfo={requestInfo} traits={traits} requestTraits={requestTraits} cutResult={cutResult} onCutTest={onCutTest} onTest={onTest} engineProgress={engineProgress} onCheck={onCheck} routing={routing} choking={choking} onFindLines={onFindLines} onCheckChokes={onCheckChokes} onWatchLine={onWatchLine} />
        ) : (
        <div className="search-area">
          <div className="search-bar">
            <input className="search" type="search" placeholder="Search name or text" value={query.text ?? ""} onChange={(event) => set({ text: event.target.value })} />
            <button className={`button small ${filters ? "on" : ""}`} onClick={() => setFilters(!filters)}>
              Filters
            </button>
          </div>
          {filters && (
            <div className="filters">
              <div className="segmented four">
                {(["monster", "spell", "trap"] as const).map((kind) => (
                  <button key={kind} className={`button small ${query.kind === kind ? "on" : ""}`} onClick={() => set({ kind: query.kind === kind ? undefined : kind, subtype: undefined })}>
                    {kind[0].toUpperCase() + kind.slice(1)}
                  </button>
                ))}
                <button className="button small ghost" onClick={() => setQuery({ text: query.text })}>
                  Reset
                </button>
              </div>
              {query.kind && (
                <select value={query.subtype ?? ""} onChange={(event) => set({ subtype: event.target.value ? Number(event.target.value) : undefined })}>
                  <option value="">Any {query.kind} type</option>
                  {SUBTYPES[query.kind].map(([bit, label]) => (
                    <option key={bit} value={bit}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              {query.kind !== "spell" && query.kind !== "trap" && (
                <div className="filter-row">
                  <select value={query.attribute ?? ""} onChange={(event) => set({ attribute: event.target.value ? Number(event.target.value) : undefined })}>
                    <option value="">Attribute</option>
                    {ATTRIBUTES.map(([bit, label]) => (
                      <option key={bit} value={bit}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select value={query.race ?? ""} onChange={(event) => set({ race: event.target.value ? Number(event.target.value) : undefined })}>
                    <option value="">Type</option>
                    {RACES.map((label, bit) => (
                      <option key={bit} value={1 << bit}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input type="number" min={0} max={13} placeholder="Lv/Rank" value={query.level ?? ""} onChange={(event) => set({ level: event.target.value === "" ? undefined : Number(event.target.value) })} />
                </div>
              )}
              {query.kind !== "spell" && query.kind !== "trap" && (
                <div className="filter-row">
                  <input type="number" placeholder="ATK min" value={query.atk?.[0] ?? ""} onChange={(event) => set({ atk: [number(event.target.value), query.atk?.[1] ?? null] })} />
                  <input type="number" placeholder="ATK max" value={query.atk?.[1] ?? ""} onChange={(event) => set({ atk: [query.atk?.[0] ?? null, number(event.target.value)] })} />
                  <input type="number" placeholder="DEF min" value={query.def?.[0] ?? ""} onChange={(event) => set({ def: [number(event.target.value), query.def?.[1] ?? null] })} />
                  <input type="number" placeholder="DEF max" value={query.def?.[1] ?? ""} onChange={(event) => set({ def: [query.def?.[0] ?? null, number(event.target.value)] })} />
                </div>
              )}
              <select value={query.limit ?? ""} onChange={(event) => set({ limit: event.target.value === "" ? undefined : (Number(event.target.value) as 0 | 1 | 2 | 3) })}>
                <option value="">Any ban-list status</option>
                <option value={0}>Forbidden</option>
                <option value={1}>Limited</option>
                <option value={2}>Semi-Limited</option>
                <option value={3}>Unlimited</option>
              </select>
            </div>
          )}
          <div className="results">
            {results.results.map((card) => (
              <div className="result" key={card.code}>
                <Thumb code={card.code} card={card} limit={limitOf(card.code)} onTap={() => show(card.code)} onHold={() => show(card.code)} />
                <button className="result-text" onClick={() => show(card.code)}>
                  <b>{card.name}</b>
                  <span className="muted">{describe(card)}</span>
                </button>
                <button className="button small add" onClick={() => add(card.code)} aria-label={`Add ${card.name}`}>
                  +
                </button>
              </div>
            ))}
            {results.more && <p className="muted">Showing the first 300. Narrow the search to see more.</p>}
            {!results.results.length && <p className="muted info-empty">{query.text || filters ? "No cards match." : "Search for cards to add."}</p>}
          </div>
        </div>
        )}
      </div>

      {detail && (
        <div className="sheet editor-sheet" onClick={(event) => event.stopPropagation()}>
          <div className="info-head">
            <div className="info-art">
              <CardArt key={detail.code} code={detail.code} />
            </div>
            <div>
              <h2>{detailCard?.name}</h2>
              {detailText?.line && <p className="muted">{detailText.line}</p>}
              <p className="muted">
                In deck: {copies(detail.code)} / {limitOf(detail.code)}
                {limitOf(detail.code) < 3 ? ` (${["Forbidden", "Limited", "Semi-Limited"][limitOf(detail.code)]})` : ""}
              </p>
            </div>
          </div>
          {buttons}
          {detailText?.text && <p className="card-text">{detailText.text}</p>}
          <button className="button ghost" onClick={() => setDetail(null)}>
            Close
          </button>
        </div>
      )}
      {notice && <p className="toast notice">{notice}</p>}
    </div>
  );
}

function describe(card: CardInfo): string {
  if (card.type & 2) return "Spell";
  if (card.type & 4) return "Trap";
  const link = card.type & 0x4000000;
  const kind = card.type & 0x800000 ? "Rank" : link ? "Link" : "Level";
  return `${kind} ${card.level} · ${card.attack < 0 ? "?" : card.attack}${link ? "" : ` / ${card.defense < 0 ? "?" : card.defense}`}`;
}
