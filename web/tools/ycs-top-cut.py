# YCS top cut main decks from YGOPRODeck: size, hand traps, other non-engine staples. Refreshes TOP_CUT in src/optimiser.ts.
# Usage: RKA_DATA=<folder holding cdb/cards.cdb> python3 tools/ycs-top-cut.py (needs ygoprodeck.com reachable)
import json, re, subprocess, sqlite3, collections, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("RKA_DATA", os.path.join(HERE, "data"))
EVENTS = ["ycs-orlando-2684", "ycs-birmingham-2704", "ycs-sydney-2783", "ycs-houston-2930", "ycs-mexico-city-2972", "ycs-quito-3128",
          "ycs-anaheim-3601", "ycs-s%C3%A3o-paulo-3622", "ycs-pittsburgh-3784", "na-remote-duel-ycs-3930"]
TOP8 = {"Winner", "Top 2", "Top 4", "Top 8", "Top 16", "Top 32"}

def get(url):
    return subprocess.run(["curl", "-sS", "--max-time", "40", url], capture_output=True, text=True).stdout

# the app's hand trap list (src/engine/handtraps.ts)
src = open(os.path.join(HERE, "..", "src", "engine", "handtraps.ts")).read()
HAND = set(int(x) for x in re.findall(r"\d{6,9}", src))
db = sqlite3.connect(f"{DATA}/cdb/cards.cdb")
name = lambda c: (db.execute("select name from texts where id=?", (c,)).fetchone() or [str(c)])[0]
# alternate artworks: a code the database lacks, or an alias, counts as its original
def canon(c):
    row = db.execute("select alias from datas where id=?", (c,)).fetchone()
    if row and row[0] and abs(row[0] - c) < 20: return row[0]
    if row: return c
    for off in range(1, 10):
        r = db.execute("select alias from datas where id=?", (c - off,)).fetchone()
        if r: return r[0] if r[0] else c - off
    return c
# generic non-engine that isn't a hand trap: board breakers and staples any deck can play
STAPLE_NAMES = ["Called by the Grave", "Crossout Designator", "Triple Tactics Talent", "Triple Tactics Thrust", "Forbidden Droplet",
    "Dark Ruler No More", "Evenly Matched", "Harpie's Feather Duster", "Lightning Storm", "Raigeki", "Super Polymerization", "Cosmic Cyclone",
    "Pot of Prosperity", "Droll & Lock Bird", "Book of Moon", "Torrential Tribute", "Solemn Judgment", "Solemn Strike", "Dominus Impulse",
    "Dominus Purge", "Kaiser Colosseum", "Ice Dragon's Prison", "Nibiru, the Primal Being", "Gold Sarcophagus", "Kaijus",
    "Interrupted Kaiju Slumber", "Gameciel, the Sea Turtle Kaiju", "Dogoran, the Mad Flame Kaiju", "Santa Claws", "Lava Golem",
    "Bystial Magnamhut", "Bystial Druiswurm", "Bystial Saronir", "The Bystial Lubellion", "Bystial Baldrake", "Mulcharmy Fuwalos",
    "Mulcharmy Purulia", "Mulcharmy Meowls", "Retaliating \"C\"", "Infinite Impermanence", "Ash Blossom & Joyous Spring", "Effect Veiler",
    "Ghost Ogre & Snow Rabbit", "Ghost Belle & Haunted Mansion", "Ghost Mourner & Moonlit Chill", "D.D. Crow", "Maxx \"C\"",
    "Dimension Shifter", "Artifact Lancea", "Skull Meister", "PSY-Framegear Gamma", "Droplet", "Fantastical Dragon Phantazmay",
    "Ash Blossom", "Nibiru", "Talents", "Sauravis, the Ancient and Ascended", "Belle", "Mystic Mine", "Anti-Spell Fragrance",
    "Cyber Emergency", "Herald of Orange Light", "Kurikara Divincarnate", "Barrier Statue", "Sky Striker Mobilize - Engage!"]
STAPLES = set()
for n in STAPLE_NAMES:
    for (c,) in db.execute("select id from texts where name=?", (n,)): STAPLES.add(c)

decks = []
for ev in EVENTS:
    page = get(f"https://ygoprodeck.com/tournament/{ev}")
    rows = re.findall(r'class="tournament_table_row[^"]*"[^>]*href="(/deck/[^"]+)"[^>]*>\s*<span[^>]*><b>([^<]+)</b>', page)
    for href, place in rows:
        if place.strip() not in TOP8: continue
        html = get("https://ygoprodeck.com" + href)
        m = re.search(r"var maindeckjs = '(\[[^']*\])'", html)
        if not m: continue
        main = [canon(int(x)) for x in json.loads(m.group(1))]
        decks.append({"event": ev, "place": place.strip(), "deck": href.split("/deck/")[1], "main": main})
    print(ev, "top 8 decks:", sum(1 for d in decks if d["event"] == ev), flush=True)

json.dump(decks, open("ycs_top_cut.json", "w"))
size = collections.Counter(len(d["main"]) for d in decks)
print("\nDecks:", len(decks))
print("Main deck size:", dict(sorted(size.items())))
traps = [sum(1 for c in d["main"] if c in HAND or c in STAPLES) for d in decks]
hand = [sum(1 for c in d["main"] if c in HAND) for d in decks]
def stats(xs): xs = sorted(xs); return f"min {xs[0]}, median {xs[len(xs)//2]}, mean {sum(xs)/len(xs):.1f}, max {xs[-1]}"
print("Hand traps (app's list):", stats(hand))
print("All non-engine (hand traps + staples):", stats(traps))
share = [t / len(d["main"]) for t, d in zip(traps, decks)]
print("Non-engine share:", f"min {min(share):.0%}, median {sorted(share)[len(share)//2]:.0%}, max {max(share):.0%}")
use = collections.Counter()
for d in decks:
    for c, n in collections.Counter(d["main"]).items():
        if c in HAND or c in STAPLES: use[c] += 1
print("\nMost played non-engine (decks running it, of", len(decks), "):")
for c, n in use.most_common(18):
    copies = [collections.Counter(d["main"])[c] for d in decks if c in d["main"]]
    print(f"  {name(c)}: {n} decks, usually {collections.Counter(copies).most_common(1)[0][0]} copies")
for d, t in zip(decks, traps):
    d["nonengine"] = t
print("\nBy size:")
for s in sorted(size):
    group = [t for d, t in zip(decks, traps) if len(d["main"]) == s]
    print(f"  {s} cards: {len(group)} decks, non-engine mean {sum(group)/len(group):.1f}")
