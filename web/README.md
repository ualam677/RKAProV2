# RKAPro web app

Deck-testing client on EDOPro's duel core (ocgcore-wasm), deployed to GitHub Pages by `.github/workflows/web.yml`.
No online play. Card data, scripts and pictures are fetched from Project Ignis at run time.

Develop: `RKA_DATA_DIR=<folder with cdb/, scripts/, dist/> npm run dev` with a `.env.development.local` pointing
`VITE_CDB_URL`, `VITE_CDB_LIST_URL`, `VITE_SCRIPTS_URL`, `VITE_STRINGS_URL` at `/data/...`.

## Done
- Engine in a worker, .ydk loading (Omega alternate-art ids accepted), release and pre-release card sets.
- Look: EDOPro's blue and black (navy panels, thin bright-blue borders); every animation is 80 ms so it feels instant.
- Phones, Duel Links feel with the TCG field: hand fanned along the bottom edge, tap a card for actions floating over it,
  tap and hold any card for its text, round phase button on the right edge under the field, LP bars top (opponent) and
  bottom (you), piles and field zones in side columns (yours: Field + Extra left, GY + Deck right; opponent mirrored),
  New hand / Exit in the ☰ menu.
- Wide screens (900 px+, landscape), EDOPro arrangement: LP and card info panel on the left (hover a card to read it),
  field in the middle, phase buttons under it, flat hand along the bottom.
- Prompts: when every card in a prompt is on the field or in the hand (chain with a hand trap, tribute, targets) the cards
  glow where they are and a slim bar above the hand asks the question; other card prompts (searches, GY picks) open a
  grid of cards; yes/no, options and positions are a small dialog. Grids and dialogs have "View field" to peek.
- Moments shown like EDOPro, before play goes on: an activated card pops up in the middle with its chain link,
  "Chain N resolving" before an effect happens, a burst on a summoned monster's zone, searched cards flash up as
  "Added to hand". The worker sends a view at each of these; the page holds each for 320-650 ms (tap to skip).
- Field monsters show Level (★), Rank (☆) or Link rating (L); defense position is the whole card turned sideways.
- Declaring a card name (Crossout Designator, Prohibition...): the core's opcode filter is evaluated per card like
  EDOPro's client, then a searchable list.
- A deck's scripts are downloaded together before the duel, with retries; a failed download is retried later instead
  of being remembered as "no script" (that was the "attempt to call an error function" error on the phone).
- From EDOPro's duelclient.cpp: prompt titles from the core's hints ("Select the card(s) to Tribute"), cards adding up
  to a total (Ritual/Synchro, sent as soon as the total is right), removing counters, declaring a Type or Attribute;
  negated chain links, revealed cards, coin and dice results, attacks, the core's messages and the winner are shown;
  counters and Xyz materials are on the field and in the card text.
- Deck editor after EDOPro's: search by name or text with filters (card type and subtype, Attribute, Type, Level or
  Rank, ATK/DEF, ban-list status), Main / Extra / Side with the size rules, 3 copies and the TCG ban list (Project Ignis
  LFLists), EDOPro's sort. Several decks saved on the device; import a .ydk, a ydke:// link or a YGO Omega code (Main and
  Extra split by card type); export the same three. Phone: deck on top, search below; wide: info | deck | search.
- Deck Optimiser in the editor ("Optimise"), `src/optimiser.ts` + `src/Optimiser.tsx`: tag each Main Deck card
  (Starter, Starter with a partner, Extender, Hand trap, Hand trap going 2nd, Board breaker, Brick, Other; known cards
  are guessed, the latest tag for a card is reused in other decks). Partners are cards or rules ("any LIGHT monster",
  "any Level 4"). Exact odds over every hand, going first (5) and second (6): open a combo, combo + 1 / 2 hand traps
  (a hand trap used as a partner is not counted), combo + extender, hand traps held, breakers, bricks. Suggestions:
  cut to 40 and the best one-for-one swaps (Main or Side Deck cards), judged on both turns equally for the chosen goal,
  applied with one tap and undone with another. Untagged cards and Extenders are never suggested as cuts.
  Each start has Test (deals it with one partner if it needs one and cards that can't help, hand traps held back) and a
  Proven tick; until every start is proven the headline also shows the proven-only number. On the Galaxy list, only
  Delta Wing, Orbital 7 and Infinity Dragon were ever replayed alone under EDOPro rules in v1: 71.1% proven of 93.3%.
- Engine probe (`src/engine/probe.ts`, run in the worker between other requests; `tools/probe-deck.mjs` runs it in Node):
  the duel core plays every Main Deck card alone, then every pair of cards that start nothing alone, trying the Main
  Phase actions it allows and every single pick from the Deck, Extra Deck or hand, up to 6 steps, each branch replayed
  from the start. A start keeps a new card out of the Deck (by identity, so Seventh Tachyon putting its search back
  gains nothing). Its starts and the partners it finds become the tags unless you set your own, with a line per card
  saying how it knows and a warning where your tag disagrees. The optimiser shows three numbers: as tagged,
  engine-checked starts, proven to a full board. Galaxy list: 4 starters alone (Orbital 7, Infinity Dragon, Delta
  Wing, Wizard), Soldier with any LIGHT monster in the deck, Photon Orbital with Summoner or War Drake, Seventh
  Tachyon with any second card; 93.3% engine-checked. About 20 s for a 43-card deck, kept with the deck.
- Normal Summon rule: starts whose engine line opens with a Normal Summon are marked (toggle per card); a second one in
  the hand counts as dead, the odds show how often two meet, and swaps never go past one per 8 cards (5 in 40).
  "Combo piece in the Deck" role: dead if drawn, never cut; the engine points at cards its lines take from the Deck.
- Recording: every hand test is saved with its deck as it is played (deck order, seed, settings and every choice, which
  the worker replays exactly; readable steps for the list). Duel menu "This worked" keeps it and records the end
  board. Start screen "Saved tests": Watch (choices made one by one at play speed; any choice of yours takes over as a
  new test) and "Play from here" on any step (fast-forwards to just before it). A working test that opened with one
  start ticks that start Proven in the optimiser. Working tests are kept; of the rest, the newest 30.
- Route search (`routeSearch` in probe.ts): a beam search over the engine from a start's test hand, branching on Main
  Phase actions and on every card picked from the Deck, Extra Deck or hand (one at a time for groups like Orbital 7's).
  It aims for the boards of your working tests (stops at the first board holding all of one), prefers actions from
  your working lines, and otherwise gathers the most it can. The line comes back as a saved-test record (same deck
  order and seed, choices numbered as the duel screen numbers them), so Watch replays it in the duel screen exactly;
  "This worked" at the end makes its board a target. Optimiser: Find a line per start or for every start, and a fourth
  number, "Engine reached your full board". Delta Wing + 4 hand traps: Full Armor, Tachyon Primal, Seventh Tachyon in
  about 100 tries / 5 s. Galaxy Wizard + 3 Ash + Droll: every line tried (71), nothing left on the field.
- Interruptions (`src/engine/interruptions.ts`): read from each card's script. An interruption is an effect usable on
  the opponent's turn (Quick Effect, Trap, Quick-Play Spell) that negates or removes; searches and summons don't
  count, nor anything only usable in battle (by event, or a condition like Galaxy-Eyes Photon Dragon's Battle Phase
  check). Xyz Materials to detach are checked (Photon Howling needs 3), and so are conditions on your own field
  (Tachyon Transmigration: Set with a "Galaxy-Eyes" monster, from the hand with a "Galaxy-Eyes Tachyon Dragon").
  Traps in hand count as Set while there is room. Only what the line built counts, not the hand traps it started with.
  The route search aims for the most interruptions (negates first); "full board" is a per-deck setting (default 3).
  Galaxy list, each start + 4 hand traps, 69 s for all seven: Infinity Dragon 3 (Photon Howling, Number 38, Set
  Transmigration); Delta Wing, Orbital 7, Soldier, Seventh Tachyon, Photon Orbital 2; Wizard 0.
- Opponent's turn: a computer opponent with a copy of the deck (default), any saved deck, or none. On its turn it
  activates everything it can once, Special and Normal Summons (never a hand trap), then attacks with everything;
  on yours it chains hand traps only if "Hand traps on my turn" is on. You're asked whenever you can respond. It is
  deterministic, so replays play the same; saved tests and engine lines get today's opponent when watched.
  Your own hand traps are only held back on your own turn.
- The route search learns your picks too, by what they were for (the core's "add to your hand" vs "send to the GY"
  hint), so a working Orbital 7 line that adds Galaxy Summoner and sends Photon Emperor is followed.
- The opponent plans its turn: at its first Main Phase it runs the route search on its own hand and deck (as a fresh
  opening, your board not part of the plan, about 10 s), then follows that plan step by step, picks included. Once
  your interruptions throw it off, it plays whatever it can. Still deterministic: loading a state replays it the same.
- Going second ("I go second"): the opponent opens with 4, draws to 5, plans and plays turn 1 without attacking; your
  turn 1 passes, so your first real turn starts with 6 cards against its board.
- Choke points: each engine line is replayed with the opponent holding one hand trap (Ash, Imperm, Veiler, Ghost Ogre,
  Nibiru, Droll, Ghost Belle, D.D. Crow) used at every moment the engine allows; the worst moments are searched again
  with the hand trap in the duel (the best way through). Listed per line, worst first; "Full board through" each hand
  trap counts every hand exactly: a start that plays through it, or two different full-board starts. Galaxy list:
  52.9% through Ash going first (each line alone is stopped by Ash on its starter), 65.4% going second.
- Working tests count their own board's interruptions (field with Xyz Materials, hand, GY, read from the scripts).
- Sync (start screen): "Back up everything" / "Restore a backup" (decks with tags, tests, lines and save states, tag
  defaults, settings; restoring merges, the newer copy of each deck wins). Desktop Chrome/Edge: link a deck folder (e.g.
  YGO Omega's or EDOPro's): its .ydk / .txt decks come in, decks changed here are written back as .ydk. Phones: open
  several deck files at once. Google Drive: the same backup in the app's hidden Drive folder, once the site has a
  Google sign-in ID. One-time setup: Google Cloud console > APIs & Services > enable the Google Drive API; OAuth
  consent screen (External, scope drive.appdata, add yourself as a test user); Credentials > Create OAuth client ID >
  Web application, authorised JavaScript origin https://ualam677.github.io; then in the GitHub repository Settings >
  Secrets and variables > Actions > Variables, add VITE_GOOGLE_CLIENT_ID with that client ID and re-run the Web build.
- Save as video (saved tests): the worker replays the test out of sight and sends every moment; the page draws each on
  a portrait canvas (both fields, hands, LP, a caption for what happened) for as long as the duel screen holds it, and
  records it with the browser's encoder (MP4 where supported, otherwise WebM). Works on phones.
- Replay viewer (Watch on a saved test or an engine line): the test is replayed out of sight with every card shown,
  then stepped through: a step per play of yours (declining to chain, zones and positions are part of the play around
  them), one per action of the opponent's, then your next turn. Play/pause, back and forward a play (going back says
  what was undone), start/end, a scrubber, and Play from here to take over. Nothing to answer; both hands, Extra
  Decks, Graveyards and banished cards open from the life bars and piles.
- Import formats: .ydk, ydke://, YGO Omega codes, and card lists by name: "Main: 3 Mulcharmy Fuwalos", "3x Ash
  Blossom", "Galaxy Wizard x2", "Effect Veiler (x3)", with or without Main / Extra / Side headings (YGOPRODeck, Master
  Duel and Neuron text exports). Names match exactly, then ignoring case and punctuation, then the shortest name
  holding every word; Extra Deck monsters go to the Extra Deck without a heading; unknown names are listed. Every
  imported code is translated to a card the database knows.
- Phases as EDOPro shows them: a DP SP M1 BP M2 EP bar lit in your colour or the opponent's, and a banner at every
  phase change on both turns. Chances to respond say what to ("Respond to Seventh Tachyon?", "Respond to the summon
  of Galaxy Wizard?", "Opponent's End Phase: activate an effect?").
- Save / load states (duel menu): the duel's start plus every choice so far, kept per deck (20); loading replays it
  choice by choice, opponent included, and you play on from there.
- Summon buttons say how (Xyz / Synchro / Link / Fusion Summon) and which card when several share a spot; the same card
  offered twice is "(another way)".
- "Ignore hand traps" now holds back only known hand traps (src/engine/handtraps.ts); other effects from the hand,
  like Galaxy War Drake summoning itself, stay available in tests and in the search.
  Checked by `node --experimental-sqlite web/tools/check-optimiser.mjs <rkapro v1> <cards.cdb>`: on the Galaxy list it
  matches v1's own code (93.34% / 96.48%), a separate naive evaluator over every hand, and a 1M-hand simulation.
- Hand test options on the start screen: hand size 1-6 and chosen opening cards (empty slots are random). The last deck,
  hand size and chosen cards are remembered on the device.

## Next, in order
1. Going second: the opponent goes first and builds a board to break. Then choke points: replay lines with the
   opponent holding one hand trap, at every moment the engine allows it, then the
   opponent: hand traps (easy / smart), then plays its own turn with board breakers
   (Veiler / Imperm on the player's turn, Imperm at the start of its turn, Lightning Storm, Cosmic Cyclone-style cards).
2. Routes learned from saved replays, then end-board suggestion from a random hand (beam search over the core, scored
   against learned end boards).
3. Save states (seed + response log), replays, takeover.
4. Omega deck folder link with write-back, Google Drive sync.
5. Replay to mp4 / GIF.

The C++ fork in `gframe/` already implements 1-2 for desktop (see `deck_optimizer.h`, `handtrap_ai.h`, `single_mode.cpp`);
port the logic from there.

## v1 vs v2 optimiser on the Galaxy-Eyes list (`node web/tools/compare-v1-v2.mjs <path to ualam677/rkapro>`)

Current 43-card list (v1 `packs/galaxy-eyes/deck.json`), going first:
- v1 (its own `odds.ts` on `lines.json`): "full board" 93.34%, brick 6.66%. v2 (`deck_optimizer.h` formula, v1's role tags,
  no bricks tagged): playable 93.17%. 2,000,000 shuffled hands give 93.34% and 93.16%: both are exact, no arithmetic error.
- v1's NOTES quote 93.5% / 5.9%; that row is the old list (Thrasher, Prosperity). Its current-list row is 93.3% / 6.7%.
- They disagree on 0.61% of hands, and v1 is right both times:
  - 0.39%: Photon Orbital + a Level 4 LIGHT body (War Drake, Summoner) with no tagged starter. v1 has this as an
    engine-verified line (board 4); a starter tag cannot express a two-card start.
  - 0.22%: Galaxy Soldier whose only other monsters are non-LIGHT (Ash FIRE, Fuwalos WIND, Droll WIND). Soldier's cost is
    "another LIGHT monster", so this is a brick; v2 counts it as playable.
- v1's real bias is in the label, not the maths: its "full board" threshold (3.25) equals its weakest line (Galaxy
  Wizard alone), so "full board" = "has any verified line" (partial boards: 0.00%). And neither model plays against hand
  traps: 93% is an uninterrupted ceiling, not a win rate.
- For the web optimiser: keep v2's tags and exact maths, add v1's two-card "needs" (Soldier + LIGHT, Orbital + body) so
  starters that need a partner are counted right, and report board strength and hand-trap interaction separately.

## Handoff notes

Decisions made by the owner
- The web app is the product. The Android APK path is parked (it crashed on launch; cause unknown, no crash log).
- No online play. Built from scratch here, not from the older `ualam677/RKAPro` repo; only its ideas are reused
  (beam line search, Omega replay/deck import, Drive sync through a synced folder first).
- Styled like EDOPro, blue and black, and as snappy as EDOPro. On phones it should feel like Duel Links but keep TCG
  rules (5 monster and 5 spell/trap zones).
- Kept separate from EDOPro itself: nothing goes to edo9300/edopro.
- Purpose of the optimiser: every saved replay of a correct route teaches it that deck's end boards, until it can work
  out the end board from a random hand.
- Omega decks: read from Omega's deck folder and write edits back (or a conversion step if that is simpler).
- Work in small batches; the owner tests on a phone and sends screenshots.

State of the repo
- Work continues on branch `ccr-ec7bb1b5-cfkgim` (it deploys to Pages; the older `ccr-2d230037-wg0h5q` is merged in).
- Pull requests must target `ualam677/RKAProV2`, never `edo9300/edopro`: GitHub defaults a fork's PRs to the parent.
- Only `web.yml` runs on push; the desktop and Android workflows are manual.
- GitHub Pages is on (source: GitHub Actions) at https://ualam677.github.io/RKAProV2/ and the `github-pages`
  environment allows this branch.
- `gframe/` holds a working desktop C++ fork with the optimiser, hand-trap opponent (easy / smart), save states,
  replay takeover and route learning. It is reference material for the web port now.

Things that cost time
- `duelQueryLocation` returns misaligned data when asked for TYPE, LEVEL or RANK. Ask only for CODE, POSITION, ATTACK,
  DEFENSE and read the rest from the card database (see `worker.ts`).
- Omega numbers alternate artworks itself; unknown codes are mapped to the real card just below (`knownCode`).
- Card pictures load on the owner's phone (Project Ignis picture server, YGOPRODeck as fallback). Those hosts, and
  dl.google.com, are blocked in the cloud build environment, so pictures and Android builds cannot be checked there.
- Local testing: Playwright with a phone profile against `npm run dev`, with ProjectIgnis `BabelCDB`, `CardScripts`
  and `Distribution` cloned under `RKA_DATA_DIR` as `cdb/`, `scripts/`, `dist/`.

Not yet confirmed by the owner
- The cropping fix for field cards (cards keep card proportions; defense position is the card turned sideways).
- The phone and wide layouts and the new prompts (checked here on Pixel 7, iPhone SE and 1440x900, without card
  pictures).
