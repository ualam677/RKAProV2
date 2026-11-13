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
- Hand test options on the start screen: hand size 1-6 and chosen opening cards (empty slots are random). The last deck,
  hand size and chosen cards are remembered on the device.

## Next, in order
1. Opponent: hand traps (easy / smart), then plays its own turn with board breakers
   (Veiler / Imperm on the player's turn, Imperm at the start of its turn, Lightning Storm, Cosmic Cyclone-style cards).
2. Deck Optimiser: card roles, exact odds, routes learned from saved replays, then end-board suggestion from a random
   hand (beam search over the core, scored against learned end boards).
3. Save states (seed + response log), replays, takeover.
4. Missing prompts: SELECT_SUM, SELECT_COUNTER, ANNOUNCE_RACE / ATTRIB.
5. Omega deck folder link with write-back, Google Drive sync.
6. Replay to mp4 / GIF.

The C++ fork in `gframe/` already implements 1-3 for desktop (see `deck_optimizer.h`, `handtrap_ai.h`, `single_mode.cpp`);
port the logic from there.

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
