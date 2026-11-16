// Game words picked out in effect text: what a card does in gold, where it happens in light blue
import type { ReactNode } from "react";

const DOES = [
  "(?:Special|Normal|Tribute|Xyz|Synchro|Link|Fusion|Ritual|Pendulum) Summon(?:ed|s)?",
  "Summon(?:ed|s)?",
  "Activate",
  "[Ss]earch(?:es)?",
  "[Bb]anish(?:ed|es)?",
  "[Dd]estroy(?:ed|s)?",
  "[Nn]egate(?:d|s)?",
  "[Dd]raw(?:s)?",
  "[Ss]end(?:s)?",
  "[Aa]dd(?:s)?",
  "[Aa]ttach(?:ed|es)?",
  "[Dd]etach(?:ed|es)?",
  "[Tt]ribute(?:d)?",
  "[Ss]huffle(?:d)?",
  "[Tt]arget(?:s|ed)?",
  "Set", // case-sensitive: the game action, not "a set of"
  "Trigger Effect",
  "Quick Effect",
];
const WHERE = ["Extra Deck", "Main Deck", "Deck", "GY", "Graveyard", "Monster Zone", "Spell & Trap Zone", "[Hh]and", "[Ff]ield", "Xyz Materials?"];

const pattern = new RegExp(`\\b(${DOES.join("|")})\\b|\\b(${WHERE.join("|")})\\b`, "g");

/** The text with its game words coloured. */
export function Keywords({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  // words inside a quoted card name ("Summon Sorceress") stay as they are
  const quoted = [...text.matchAll(/"[^"]*"/g)].map((one) => [one.index ?? 0, (one.index ?? 0) + one[0].length]);
  for (const match of text.matchAll(pattern)) {
    if (quoted.some(([from, to]) => (match.index ?? 0) >= from && (match.index ?? 0) < to)) continue;
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <span key={at} className={match[1] ? "kw-does" : "kw-where"}>
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
