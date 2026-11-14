import { useState } from "react";

// Card pictures are fetched one card at a time, when the card first shows up, so new cards
// need no update: the first source is the picture server EDOPro itself downloads from.
export const SOURCES = [
  (code: number) => `https://pics.projectignis.org:2096/pics/${code}.jpg`,
  (code: number) => `https://images.ygoprodeck.com/images/cards_small/${code}.jpg`,
];

// once a source has failed for one card, later cards start from the next one
let firstWorking = 0;

// An alternate artwork the picture servers don't have falls back to the original card's picture
// (the page tells this module which card each artwork is an artwork of).
let originalOf: (code: number) => number = (code) => code;
export const setArtworkOriginals = (lookup: (code: number) => number) => (originalOf = lookup);

export function CardArt({ code, onLoad }: { code: number; onLoad?: () => void }) {
  const [source, setSource] = useState(firstWorking);
  // every source with the card's own code, then every source with the original's
  const original = originalOf(code);
  const attempts = original !== code ? SOURCES.length * 2 : SOURCES.length;
  if (!code || source >= attempts) return null;
  const which = source % SOURCES.length;
  return (
    <img
      className="art"
      src={SOURCES[which](source < SOURCES.length ? code : original)}
      alt=""
      loading="lazy"
      draggable={false}
      onLoad={onLoad}
      onError={() => {
        if (source < SOURCES.length && firstWorking === source && source + 1 < SOURCES.length) firstWorking = source + 1;
        setSource(source + 1);
      }}
    />
  );
}
