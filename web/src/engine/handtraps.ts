// Known hand traps (gframe/deck_optimizer.h's list): what "Ignore hand traps" holds back in a hand test, what the
// engine search never fires on its own turn, and the optimiser's first guess for these cards. Other effects from the
// hand (Galaxy War Drake summoning itself, for one) are part of the combo and always stay available.
export const HAND_TRAPS = [
  14558127, 97268402, 10045474, 27204311, 94145021, 59438930, 73642296, 23434538, 24508238, 52038441, 91800273, 34267821,
  33854624, 6637331, 60242223, 72656408, 67750322, 38814750, 40366667, 97045737, 60643553, 62015408, 46502744, 87170768,
  58655504, 78661338,
];
// "If you control no cards": only useful going second
export const HAND_TRAPS_SECOND = [42141493, 84192580, 87126721];

const all = new Set([...HAND_TRAPS, ...HAND_TRAPS_SECOND]);
/** `alias`: the card an alternate artwork is an artwork of */
export const isHandTrap = (code: number, alias = 0) => all.has(code) || (alias !== 0 && all.has(alias));
const first = new Set(HAND_TRAPS);
/** a hand trap that still works on the opponent's turn after you went first (not the Mulcharmy cards) */
export const isFirstTurnHandTrap = (code: number) => first.has(code);
