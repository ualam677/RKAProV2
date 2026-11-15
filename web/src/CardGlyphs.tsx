// Symbols in place of words for the Optimise Cards tab: a card's roles as badges on its picture, its deckbuilding traits
// as icons, and the hand traps that stop it as tiny cards. Each says its full meaning when tapped.
import { CardArt } from "./CardArt";
import type { Role } from "./optimiser";

const ROLE_BADGE: Partial<Record<Role, { name: string; path: string; tone: string }>> = {
  starter: { name: "Starter", path: "M8 5v14l11-7z", tone: "start" },
  pair: { name: "Needs a partner", path: "M9 15 15 9M7 11l-2 2a3 3 0 0 0 4 4l2-2M13 7l2-2a3 3 0 0 1 4 4l-2 2", tone: "start" },
  extender: { name: "Extender", path: "M12 5v14M5 12h14", tone: "extend" },
  piece: { name: "In-Deck piece", path: "M4 8h16v11H4zM7 5h10", tone: "piece" },
  handtrap: { name: "Hand trap", path: "M8 13V6a1.5 1.5 0 0 1 3 0v5M11 10V5a1.5 1.5 0 0 1 3 0v5M14 10V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-12 0v-2a1.5 1.5 0 0 1 3 0", tone: "trap" },
  breaker: { name: "Board breaker", path: "m14 4 6 6-3 3-6-6zM11 7l-7 7 3 3 7-7", tone: "break" },
  brick: { name: "Brick", path: "M4 6h16v5H4zM4 13h16v5H4zM10 6v5M14 13v5", tone: "brick" },
  other: { name: "Other", path: "M12 12h.01", tone: "piece" },
};

export function RoleBadges({ roles }: { roles: Role[] }) {
  const shown = roles.flatMap((role) => (ROLE_BADGE[role] ? [ROLE_BADGE[role]!] : []));
  if (!shown.length) return null;
  return (
    <span className="role-badges">
      {shown.map((badge) => (
        <span key={badge.name} className={`role-badge ${badge.tone}`} role="img" aria-label={badge.name} title={badge.name}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={badge.path} />
          </svg>
        </span>
      ))}
    </span>
  );
}

const LOCK = "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z";
// the hand traps a trait names, as cards
const STOPPERS: { match: RegExp; code: number; short: string }[] = [
  { match: /\bAsh\b/, code: 14558127, short: "ASH" },
  { match: /Droll/, code: 94145021, short: "DROLL" },
  { match: /Veiler/, code: 97268402, short: "VEIL" },
  { match: /Imperm/, code: 10045474, short: "IMP" },
];

interface Glyph {
  key: string;
  full: string;
  path: string;
  text?: string;
  tone?: "good" | "lock";
}
// a trait the worker read from the card text, as an icon (the words stay as its label)
function glyphOf(trait: string): Glyph | null {
  if (trait.startsWith("stopped by")) return null;
  if (trait.startsWith("needs an empty field")) return { key: trait, full: trait, path: "M5 5h14v14H5z" };
  if (trait.startsWith("once per turn")) return { key: trait, full: trait, path: "M3 12a9 9 0 1 0 3-6.7M3 4v4h4", text: "1" };
  if (trait.startsWith("gives an extra Normal")) return { key: trait, full: trait, path: "M6 19V5l9 14V5M19 4v6M16 7h6", tone: "good" };
  if (trait.startsWith("summons itself")) return { key: trait, full: trait, path: "M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z", tone: "good" };
  if (trait.startsWith("has a GY effect")) return { key: trait, full: trait, path: "M6 21V9a6 6 0 0 1 12 0v12zM9 13h6", tone: "good", text: "GY" };
  if (trait.startsWith("locks you")) {
    // "except Xyz Monsters" → XYZ, "except LIGHT monsters" → LIGHT
    const except = /except (.+)$/i.exec(trait)?.[1] ?? "";
    const word = except.replace(/["“”]/g, "").replace(/\bmonsters?\b/gi, "").trim().split(/\s+/).slice(0, 2).join(" ");
    return { key: trait, full: trait, path: LOCK, tone: "lock", text: word.length <= 10 ? word.toUpperCase() : word.split(" ")[0].toUpperCase() };
  }
  return { key: trait, full: trait, path: "M12 8v5M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" };
}

/** A card's traits as icons and the hand traps that stop it as tiny cards; tapping one says what it means. */
export function TraitGlyphs({ traits, normal, open, onOpen }: { traits: string[]; normal?: boolean; open: string | null; onOpen: (full: string | null) => void }) {
  const glyphs = [...(normal ? [{ key: "normal", full: "uses the turn's Normal Summon", path: "M7 19V5l10 14V5" } as Glyph] : []), ...traits.flatMap((trait) => glyphOf(trait) ?? [])];
  const stoppedBy = traits.find((trait) => trait.startsWith("stopped by")) ?? "";
  const stoppers = STOPPERS.filter((one) => one.match.test(stoppedBy));
  const shown = [...glyphs.map((glyph) => glyph.full), stoppedBy];
  if (!glyphs.length && !stoppers.length) return null;
  const toggle = (full: string) => onOpen(open === full ? null : full);
  return (
    <>
      <div className="trait-glyphs">
        {glyphs.map((glyph) => (
          <button key={glyph.key} className={`trait-glyph ${glyph.tone ?? ""} ${open === glyph.full ? "on" : ""}`} aria-label={glyph.full} title={glyph.full} onClick={() => toggle(glyph.full)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={glyph.path} />
            </svg>
            {glyph.text && <span>{glyph.text}</span>}
          </button>
        ))}
        {stoppers.length > 0 && (
          <button className={`stopped-by ${open === stoppedBy ? "on" : ""}`} aria-label={stoppedBy} title={stoppedBy} onClick={() => toggle(stoppedBy)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="m6 6 12 12" />
            </svg>
            {stoppers.map((one) => (
              <span key={one.code} className="mini-card">
                <CardArt code={one.code} />
                <b>{one.short}</b>
              </span>
            ))}
          </button>
        )}
      </div>
      {open && shown.includes(open) && <p className="trait-said">{open}</p>}
    </>
  );
}

// tiny card-shaped symbols for the odds: a starter (▶), a hand trap (✋), an extender (+), a breaker (hammer),
// a Normal Summon card (N), a dead card (✕), no breaker (crossed hammer)
export type Mini = "play" | "hand" | "plus" | "break" | "n" | "dead" | "nobreak";
const MINI: Record<Mini, { tone: string; path: string }> = {
  play: { tone: "start", path: "M8 5v14l11-7z" },
  hand: { tone: "trap", path: ROLE_BADGE.handtrap!.path },
  plus: { tone: "extend", path: "M12 5v14M5 12h14" },
  break: { tone: "break", path: ROLE_BADGE.breaker!.path },
  nobreak: { tone: "warn", path: `${ROLE_BADGE.breaker!.path}M3 3l18 18` },
  n: { tone: "start", path: "M7 19V5l10 14V5" },
  dead: { tone: "warn", path: "M5 5l14 14M19 5 5 19" },
};
export function MiniCards({ kinds }: { kinds: Mini[] }) {
  return (
    <span className="mini-glyphs" aria-hidden="true">
      {kinds.map((kind, at) => (
        <span key={at} className={`mini-glyph ${MINI[kind].tone}`}>
          <svg viewBox="0 0 24 24">
            <path d={MINI[kind].path} />
          </svg>
        </span>
      ))}
    </span>
  );
}

const STRIP_ORDER: Role[] = ["starter", "pair", "extender", "handtrap", "breaker", "piece", "brick", "other", "none"];
const STRIP_TONE = (role: Role) => (role === "none" ? "none" : role === "handtrap2" ? "trap" : (ROLE_BADGE[role]?.tone ?? "piece"));
/** Every Main Deck card as a small block coloured by its first role, with a count per kind. */
export function RoleStrip({ cards }: { cards: { count: number; role: Role }[] }) {
  const blocks = STRIP_ORDER.flatMap((role) => cards.filter((card) => card.role === role).flatMap((card) => Array.from({ length: card.count }, () => STRIP_TONE(role))));
  const legend = (["start", "extend", "trap", "break", "piece", "brick", "none"] as const)
    .map((tone) => ({ tone, n: blocks.filter((one) => one === tone).length }))
    .filter((one) => one.n > 0);
  const names: Record<string, string> = { start: "start", extend: "extend", trap: "hand trap", break: "breaker", piece: "other", brick: "brick", none: "untagged" };
  return (
    <div className="role-strip" role="img" aria-label={`${blocks.length} cards: ${legend.map((one) => `${one.n} ${names[one.tone]}`).join(", ")}`}>
      <div className="role-blocks">
        {blocks.map((tone, at) => (
          <i key={at} className={tone} />
        ))}
      </div>
      <div className="role-legend">
        <b className="role-total">{blocks.length}</b>
        {legend.map((one) => (
          <span key={one.tone}>
            <i className={one.tone} />
            <b>{one.n}</b>
            <small>{names[one.tone]}</small>
          </span>
        ))}
      </div>
    </div>
  );
}
