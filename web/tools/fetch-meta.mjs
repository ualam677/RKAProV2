// The Meta screen's data: the last month of TCG tournament tops from yugiohmeta.com (its public site API, unofficial),
// summed up into web/public/meta.json. Run by the deploy workflow: the live copy is kept while it is under a week old
// and the TCG ban list is unchanged; otherwise it is fetched again. Never fails the build: on any problem the live copy
// (or nothing) is published and the reason is printed.
// Usage: node web/tools/fetch-meta.mjs [--force]   (LIVE_URL: the deployed meta.json to reuse)
import fs from "node:fs";

const OUT = new URL("../public/meta.json", import.meta.url);
const API = "https://www.yugiohmeta.com/api/v1";
const LFLIST = "https://raw.githubusercontent.com/ProjectIgnis/LFLists/master/0TCG.lflist.conf";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; deck-tool)", Accept: "application/json" };
// a little under a week: the daily check runs at a fixed time, so a full 7 days would often wait for day 8
const WEEK = 6.5 * 24 * 3600 * 1000;
// bumped when the file's shape changes, so the live copy is fetched again instead of kept
const FORMAT = 4;
const force = process.argv.includes("--force");
const output = (key, value) => process.env.GITHUB_OUTPUT && fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);

const getJson = async (url) => {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) throw new Error(`${response.status} from ${url.replace(API, "")}`);
  return response.json();
};
const query = (path, params) => `${API}/${path}?${new URLSearchParams(params)}`;

async function main() {
  const banlist = (await (await fetch(LFLIST)).text()).match(/^!(.+)$/m)?.[1]?.trim() ?? "";
  // the live copy, kept while it is fresh and the ban list is the same
  let live = null;
  if (process.env.LIVE_URL) live = await getJson(process.env.LIVE_URL).catch(() => null);
  if (live && !force && live.v === FORMAT && Date.now() - Date.parse(live.fetched) < WEEK && live.banlist === banlist) {
    fs.writeFileSync(OUT, JSON.stringify(live));
    console.log(`meta: live copy kept (${live.fetched.slice(0, 10)}, ${banlist})`);
    return output("fresh", "false");
  }
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const [tops, rankings, changes] = await Promise.all([
      getJson(query("top-decks", { ocg: "false", "uploaded[$gte]": since, limit: "0" })),
      getJson(query("deck-types/rankings", { ocg: "false", t3Only: "false", range: "Last 1 month", limit: "1" })),
      // the latest TCG ban list change: what moved (the app shows which of your cards are among them)
      getJson(query("banlist-changes", { format: "TCG", "date[$lte]": new Date().toISOString().slice(0, 10), limit: "1", "sort[date]": "-1" })).catch(() => []),
    ]);
    // standard TCG only: Genesys is a format of its own
    const lists = tops.filter((one) => !one.ocg && !/genesys/i.test(one.tournamentType?.name ?? "") && one.deckType?.name && one.main?.length);
    const ranking = rankings[0];
    const newest = lists.reduce((latest, one) => (one.uploaded > latest ? one.uploaded : latest), "");
    // sane or not published
    if (lists.length < 50) throw new Error(`only ${lists.length} lists`);
    if (!ranking?.deckTypes?.length) throw new Error("no rankings");
    if (Date.now() - Date.parse(newest) > 21 * 24 * 3600 * 1000) throw new Error(`newest list is from ${newest.slice(0, 10)}`);
    const pct = (part, whole) => Math.round((100 * part) / whole);
    const named = (entries) => (entries ?? []).map((entry) => ({ name: entry.card?.name, amount: entry.amount })).filter((one) => one.name);
    const types = ranking.deckTypes.slice(0, 10).map(({ deckType, decksCount }) => {
      const mine = lists.filter((one) => one.deckType.name === deckType.name);
      const seen = new Map();
      for (const one of mine) for (const name of new Set(named(one.main).map((entry) => entry.name))) seen.set(name, (seen.get(name) ?? 0) + 1);
      const spread = [...seen].map(([name, count]) => ({ name, pct: pct(count, mine.length) })).sort((a, b) => b.pct - a.pct);
      // the list shown and imported: the best finish, the newest of those
      // (a list the site marks illegal, from before the current ban list, is never the one used)
      const best = mine.filter((one) => !one.illegal && !one.incomplete).sort((a, b) => (a.tournamentPlacement ?? 99) - (b.tournamentPlacement ?? 99) || (b.uploaded > a.uploaded ? 1 : -1))[0];
      return {
        name: deckType.name,
        count: decksCount,
        share: Math.round((1000 * decksCount) / ranking.totalDecks) / 10,
        lists: mine.length,
        wins: mine.filter((one) => one.tournamentPlacement === 1).length,
        core: spread.filter((one) => one.pct >= 90).slice(0, 12),
        flex: spread.filter((one) => one.pct >= 40 && one.pct < 90).slice(0, 10),
        // what this deck sides in: the cards in at least a third of its side decks
        side: (() => {
          const sided = new Map();
          const withSide = mine.filter((one) => one.side?.length);
          for (const one of withSide) for (const name of new Set(named(one.side).map((entry) => entry.name))) sided.set(name, (sided.get(name) ?? 0) + 1);
          return [...sided].map(([name, count]) => ({ name, pct: pct(count, withSide.length) })).filter((one) => one.pct >= 33).sort((a, b) => b.pct - a.pct).slice(0, 10);
        })(),
        list: best ? { main: named(best.main), extra: named(best.extra), side: named(best.side), placement: best.tournamentPlacement, event: best.tournamentType?.name ?? "", url: best.url ? `https://www.yugiohmeta.com${best.url}` : "" } : null,
      };
    });
    // every card's share of all lists (the app picks out the hand traps)
    const everywhere = new Map();
    for (const one of lists) for (const name of new Set(named(one.main).map((entry) => entry.name))) everywhere.set(name, (everywhere.get(name) ?? 0) + 1);
    const cards = Object.fromEntries([...everywhere].filter(([, count]) => pct(count, lists.length) >= 5).map(([name, count]) => [name, pct(count, lists.length)]));
    // the most sided cards across every list
    const sidedAll = new Map();
    const withSide = lists.filter((one) => one.side?.length);
    for (const one of withSide) for (const name of new Set(named(one.side).map((entry) => entry.name))) sidedAll.set(name, (sidedAll.get(name) ?? 0) + 1);
    const sided = [...sidedAll].map(([name, count]) => ({ name, pct: pct(count, withSide.length) })).sort((a, b) => b.pct - a.pct).slice(0, 15);
    // last week's numbers, for what moved: the live copy once it is about a week old, otherwise what it carried
    // every ranked deck's share (not only the top 10 shown), so a deck entering or leaving the top 10 compares right
    const shares = Object.fromEntries(ranking.deckTypes.map(({ deckType, decksCount }) => [deckType.name, Math.round((1000 * decksCount) / ranking.totalDecks) / 10]));
    const summary = (copy) => ({ fetched: copy.fetched, shares: copy.shares ?? Object.fromEntries(copy.types.map((type) => [type.name, type.share])), cards: copy.cards });
    const previous = live?.types && live.v >= 2 ? (Date.now() - Date.parse(live.fetched) >= WEEK ? summary(live) : live.previous ?? null) : null;
    const latest = changes[0];
    const banChanges = latest ? { date: latest.date.slice(0, 10), changes: (latest.changes ?? []).map((one) => ({ name: one.card?.name, from: one.from ?? "Unlimited", to: one.to ?? "Unlimited" })).filter((one) => one.name) } : null;
    const meta = { v: FORMAT, fetched: new Date().toISOString(), source: "yugiohmeta.com", banlist, range: ranking.range, totalDecks: ranking.totalDecks, lists: lists.length, newest: newest.slice(0, 10), types, shares, cards, sided, banChanges, previous };
    fs.writeFileSync(OUT, JSON.stringify(meta));
    console.log(`meta: fetched ${lists.length} lists, ${types.length} deck types, newest ${meta.newest}, ${banlist}`);
    output("fresh", "true");
  } catch (error) {
    console.log(`meta: not fetched (${error.message})${live ? "; the live copy is kept" : ""}`);
    if (live) fs.writeFileSync(OUT, JSON.stringify(live));
    output("fresh", "false");
  }
}
main().catch((error) => (console.log(`meta: skipped (${error.message})`), output("fresh", "false")));
