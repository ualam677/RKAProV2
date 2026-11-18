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
const WEEK = 7 * 24 * 3600 * 1000;
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
  if (live && !force && Date.now() - Date.parse(live.fetched) < WEEK && live.banlist === banlist) {
    fs.writeFileSync(OUT, JSON.stringify(live));
    console.log(`meta: live copy kept (${live.fetched.slice(0, 10)}, ${banlist})`);
    return output("fresh", "false");
  }
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const [tops, rankings] = await Promise.all([
      getJson(query("top-decks", { ocg: "false", "uploaded[$gte]": since, limit: "0" })),
      getJson(query("deck-types/rankings", { ocg: "false", t3Only: "false", range: "Last 1 month", limit: "1" })),
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
      const best = [...mine].sort((a, b) => (a.tournamentPlacement ?? 99) - (b.tournamentPlacement ?? 99) || (b.uploaded > a.uploaded ? 1 : -1))[0];
      return {
        name: deckType.name,
        count: decksCount,
        share: Math.round((1000 * decksCount) / ranking.totalDecks) / 10,
        lists: mine.length,
        wins: mine.filter((one) => one.tournamentPlacement === 1).length,
        core: spread.filter((one) => one.pct >= 90).slice(0, 12),
        flex: spread.filter((one) => one.pct >= 40 && one.pct < 90).slice(0, 10),
        list: best ? { main: named(best.main), extra: named(best.extra), side: named(best.side), placement: best.tournamentPlacement, event: best.tournamentType?.name ?? "", url: best.url ? `https://www.yugiohmeta.com${best.url}` : "" } : null,
      };
    });
    // every card's share of all lists (the app picks out the hand traps)
    const everywhere = new Map();
    for (const one of lists) for (const name of new Set(named(one.main).map((entry) => entry.name))) everywhere.set(name, (everywhere.get(name) ?? 0) + 1);
    const cards = Object.fromEntries([...everywhere].filter(([, count]) => pct(count, lists.length) >= 5).map(([name, count]) => [name, pct(count, lists.length)]));
    const meta = { fetched: new Date().toISOString(), source: "yugiohmeta.com", banlist, range: ranking.range, totalDecks: ranking.totalDecks, lists: lists.length, newest: newest.slice(0, 10), types, cards };
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
