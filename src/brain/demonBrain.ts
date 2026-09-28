import { config } from "../config.ts";
import type { CasterInput, SimEvent, World } from "../sim/types.ts";
import { createHeuristicMemory, heuristicDemonInput, type HeuristicMemory } from "./heuristicBrain.ts";
import type { JevBrain } from "../jev/jevBrain.ts";
import type { BrainErrorKind } from "../jev/protocol.ts";
import type { JevBrainSnapshot } from "../jev/stats.ts";
import { mirrorEvents, mirrorWorld } from "./mirror.ts";
import { createRandomBrainMemory, randomDemonInput, type RandomBrainMemory } from "./randomBrain.ts";

export const brainModes = ["jev", "heuristic", "random"] as const;
export type BrainMode = (typeof brainModes)[number];

// Who actually produced the demon's input this step.
export type BrainController = "jev" | "fallback" | "heuristic" | "random";

export type FallbackStats = {
  readonly takeovers: number;
  readonly fallbackSteps: number;
  readonly jevSteps: number;
};

export type DemonBrain = {
  readonly mode: BrainMode;
  readonly controller: BrainController;
  input(world: World): CasterInput;
  observe(world: World, events: readonly SimEvent[]): void;
  cycleMode(): BrainMode;
  // Aborts Jev requests in flight; call when this brain stops being asked for input.
  cancel(): void;
  fallbackStats(): FallbackStats;
  // Why Jev can't be reached while it should be playing, or null (also in the heuristic and random modes).
  outOfMana(): BrainErrorKind | null;
  snapshot(world: World): JevBrainSnapshot;
};

// Switches the demon between brains (F1). In Jev mode the heuristic takes over whenever there is no
// fresh decision (no answer yet, offline, backing off), so the game is always playable.
export function createDemonBrain(jev: JevBrain, initialMode: BrainMode = "jev", heuristicSeed: number = config.heuristicBrain.seed): DemonBrain {
  let mode: BrainMode = initialMode;
  let controller: BrainController = initialMode === "jev" ? "fallback" : initialMode;
  let heuristicMemory: HeuristicMemory = createHeuristicMemory(heuristicSeed);
  let randomMemory: RandomBrainMemory = createRandomBrainMemory();
  let takeovers = 0;
  let fallbackSteps = 0;
  let jevSteps = 0;

  return {
    get mode() {
      return mode;
    },
    get controller() {
      return controller;
    },
    input(world) {
      // The heuristic runs every step, so its memory is warm whenever it has to take over.
      const heuristic = heuristicDemonInput(world, heuristicMemory);
      heuristicMemory = heuristic.memory;
      if (mode === "heuristic") return heuristic.input;
      if (mode === "random") {
        const random = randomDemonInput(world, randomMemory);
        randomMemory = random.memory;
        return random.input;
      }

      const jevInput = jev.input(world);
      const fighting = world.round.phase === "fighting";
      if (jevInput) {
        controller = "jev";
        if (fighting) jevSteps += 1;
        return jevInput;
      }
      if (controller === "jev" && fighting) takeovers += 1;
      controller = "fallback";
      if (fighting) fallbackSteps += 1;
      return heuristic.input;
    },
    observe(world, events) {
      jev.observe(world, events);
    },
    cycleMode() {
      mode = brainModes[(brainModes.indexOf(mode) + 1) % brainModes.length]!;
      if (mode !== "jev") jev.cancel();
      controller = mode === "jev" ? "fallback" : mode;
      return mode;
    },
    cancel() {
      jev.cancel();
      controller = mode === "jev" ? "fallback" : mode;
    },
    fallbackStats: () => ({ takeovers, fallbackSteps, jevSteps }),
    outOfMana: () => (mode === "jev" ? jev.outOfMana() : null),
    snapshot: (world) => jev.snapshot(world),
  };
}

// Short name for the HUD: which brain is playing, and whether Jev or its fallback is in control.
export function brainLabel(brain: DemonBrain): string {
  if (brain.mode !== "jev") return brain.mode;
  return brain.controller === "jev" ? "Jev" : "Jev (fallback)";
}

// Drives the warlock's mage with a demon brain (Jev vs Jev): the brain sees the mirrored world,
// where the warlock's mage is "demon", and its input applies to the warlock's mage unchanged.
export function mirroredBrain(brain: DemonBrain): DemonBrain {
  return {
    get mode() {
      return brain.mode;
    },
    get controller() {
      return brain.controller;
    },
    input: (world) => brain.input(mirrorWorld(world)),
    observe: (world, events) => brain.observe(mirrorWorld(world), mirrorEvents(events)),
    cycleMode: () => brain.cycleMode(),
    cancel: () => brain.cancel(),
    fallbackStats: () => brain.fallbackStats(),
    outOfMana: () => brain.outOfMana(),
    snapshot: (world) => brain.snapshot(mirrorWorld(world)),
  };
}
