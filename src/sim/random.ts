// Seeded, immutable RNG (mulberry32): every draw returns the value and the next state.
export type RandomState = { readonly seed: number };

export function createRandom(seed: number): RandomState {
  return { seed: seed >>> 0 };
}

export function nextRandom(state: RandomState): [number, RandomState] {
  const advanced = (state.seed + 0x6d2b79f5) >>> 0;
  let mixed = advanced;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  const value = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  return [value, { seed: advanced }];
}

export function randomBetween(state: RandomState, minimum: number, maximum: number): [number, RandomState] {
  const [value, nextState] = nextRandom(state);
  return [minimum + value * (maximum - minimum), nextState];
}
