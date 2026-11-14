# Deckbuilding and combo principles (spec for the optimiser)

Learnt with the owner, 14 Nov 2026. Everything here must work for **any** deck put through the optimiser, read from card
scripts/text and the deck's own tags, tests and worked replays. Never hard-code one deck. Never just justify the
owner's choices: judge them.

## 1. Every slot competes
- A card earns its slot only if drawing it beats drawing what it pushes out. Each card over 40 dilutes the best draws.
- Going over 40 is right only when the extra cards are worth more than the starts they dilute. YCS top cut (2025, 46
  decks): 41% at exactly 40, most of the rest 41-43, and decks above 40 spend the room on **non-engine** (~17-19 vs 15
  at 40), engine about the same size (`TOP_CUT` in optimiser.ts). Use as a reference, not a rule.

## 2. Roles: what each card does in the deck (read per card, not per name)
- **Starter**: makes a combo alone. **1.5-card starter**: needs any one other card (Seventh Tachyon: puts a card from
  hand on top of the Deck). Its "0.5" turns a dead card into a search. **Pair starter**: needs a specific partner.
- **Extender**: keeps going or plays through a negate; looks bad in raw odds, good in games.
- **Combo piece in the Deck**: searched/sent/summoned from the Deck (Orbital 7's add/send targets). Wanted in the Deck,
  weak to draw. Count separately from starters when judging deck size (the deck-size verdict still lumps them in as
  engine: fix this first).
- **Non-engine**: hand traps (going 1st: protect/stop; going 2nd: most of what you have), board breakers, staples.
  Going-2nd-only cards (Mulcharmy) and going-1st-only cards are trade-offs weighted by how often each happens.
- **Double duty beats single duty**: a card that does two jobs (Galaxy Wizard: starter and Orbital 7 target) beats two
  cards that each do one (Thrasher + War Drake doing the same Rank 8 as Wizard + Emperor).
- For each one-of ask: does it give a line, or a way through a hand trap, that nothing else gives? If not, it's a cut.

## 3. Clashes: cards that hurt each other
- **Field conditions**: "while you control no monsters" (Photon Thrasher, Schwarzschild going 1st) compete for the one
  empty-field window, and force their line to go first. Read `IsExistingMatchingCard(...LOCATION_MZONE...)==0`-style
  conditions and summoning conditions from scripts.
- **Normal Summon**: shared by every Normal Summon starter (keep <= deck/8). Effects that grant an extra Normal Summon
  (Photon Emperor) remove the clash.
- **Once per turn by name** (`SetCountLimit(1,id)`): a second copy of the same effect is dead that turn.
- **Lock restrictions**: "cannot Special Summon except LIGHT / from the Extra Deck except Xyz/Dragon Xyz". Two cards'
  locks must be compatible for one turn.
- **Must-go-first** cards in the same hand: only one can.

## 4. Hand-trap resilience of a line (read from scripts)
- Not negatable: summoning procedures/conditions (Thrasher's own Special Summon), inherent summons.
- Out of reach of Veiler/Imperm: effects that activate in the GY (War Drake) or from the hand.
- Ash-able: adds/summons/sends from the Deck. Droll: any add after the first. Nibiru: 5 summons (have a monster/omni
  negate up by the 5th: `NibiruCheck`). Imperm/Veiler: effects activated by face-up monsters.
- Two routes to the same result that lose to **different** hand traps are not duplicates (that's why the owner ran
  Thrasher + War Drake beside Wizard + Emperor); weigh that against the clashes they bring.

## 5. Two-card (and more) hands: which route first
1. Cards whose condition will not last go before cards that break it (empty-field cards first among monsters). A Spell
   does not break "no monsters".
2. **Lead with the card you'd rather lose**, as long as playing it doesn't break the condition of the card you protect.
   Seventh Tachyon + Schwarzschild: Seventh first. Ash on Seventh costs a search; Ash on Schwarzschild costs the
   starter and its once-per-turn, and Seventh can't replace it. Ghost Ogre on an activated Spell does nothing.
3. Keep the Normal Summon for the backup route unless something gives it back.
4. If Droll is likely, make the most important add first.
5. Count summons for Nibiru: a negate up before the 5th.
6. The flexible card (1.5-card starter) puts back the worst card, never a hand trap going first.

## 6. What to build (in this order)
1. Deck-size verdict: split engine into starters / extenders / pieces in the Deck before comparing with top cut.
2. Role reader for every deck: from scripts and engine evidence, mark per card: starter / 1.5 / pair, piece in Deck
   (searched by another card), double duty, field conditions, Normal Summon use, OPT by name, locks, what each step of
   its line is weak to (Ash/Veiler/Imperm/Droll/Nibiru). Show it per card; the owner can correct it.
3. Clash check: pairs of cards whose conditions/locks/Normal Summons conflict, with how often you open both.
4. Two-route order check: for each pair of starts with worked lines, play A-then-B and B-then-A against each hand trap
   (chokePoints/chokeCombo already follow lines); show which order keeps a full board more often, explained by the rules
   above. Lead-with-what-you'd-rather-lose as the default.
5. Suggestions rebuild: locked cards, hand trap targets going 1st and 2nd, trade-offs in both turns' odds and the
   measured results (`results`), cut candidates = single-duty one-ofs, clashing cards, excess Normal Summons. Never
   one-tap apply; the owner decides.
