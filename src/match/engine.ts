import type { DemonBrain } from "../brain/demonBrain.ts";
import { config } from "../config.ts";
import { idleInput } from "../sim/caster.ts";
import type { CasterInput, SimEvent, World } from "../sim/types.ts";
import { createWorld, stepWorld } from "../sim/world.ts";

export type DuelBrains = {
  demon: DemonBrain;
  // Null while a human plays the warlock; otherwise a mirrored brain drives it (Jev vs Jev).
  warlock: DemonBrain | null;
};

export type AdvanceResult = {
  events: SimEvent[];
  // The human's dash or cast press was seen by a step; the caller should acknowledge it.
  pressesConsumed: boolean;
};

export type DuelEngine = {
  readonly world: World;
  readonly previous: World;
  // How far the render sits between previous and world, 0–1.
  readonly alpha: number;
  advance(frameSeconds: number, humanInput?: CasterInput): AdvanceResult;
};

export type DuelEngineOptions = {
  // Hitstop freezes the sim for a moment after a direct hit. The server leaves it to each viewer.
  hitstop?: boolean;
  // Called after every sim step, e.g. to stream each step to viewers.
  onStep?: (world: World, events: readonly SimEvent[]) => void;
};

// Fixed 60 Hz simulation with both brains. Shared by local play in the browser and the Jev vs Jev host on the server.
export function createDuelEngine(brains: DuelBrains, options: DuelEngineOptions = {}): DuelEngine {
  const hitstop = options.hitstop ?? true;
  let world = createWorld();
  let previous = world;
  let accumulatorSeconds = 0;
  let hitstopRemainingMs = 0;

  return {
    get world() {
      return world;
    },
    get previous() {
      return previous;
    },
    get alpha() {
      return accumulatorSeconds * config.sim.stepHz;
    },
    advance(rawFrameSeconds, humanInput) {
      const frameSeconds = Math.min(rawFrameSeconds, config.sim.maxCatchUpSeconds);
      const stepSeconds = 1 / config.sim.stepHz;
      const events: SimEvent[] = [];
      let pressesConsumed = false;
      if (hitstopRemainingMs > 0) hitstopRemainingMs -= frameSeconds * 1000;
      else accumulatorSeconds += frameSeconds;

      let stepInput = humanInput;
      while (accumulatorSeconds >= stepSeconds) {
        const demonInput = brains.demon.input(world);
        const warlockInput = brains.warlock ? brains.warlock.input(world) : (stepInput ?? idleInput(world.casters.warlock.aimPoint));
        previous = world;
        const result = stepWorld(world, { warlock: warlockInput, demon: demonInput }, stepSeconds);
        world = result.world;
        brains.demon.observe(world, result.events);
        brains.warlock?.observe(world, result.events);
        events.push(...result.events);
        options.onStep?.(world, result.events);
        accumulatorSeconds -= stepSeconds;
        // A press is seen by exactly one step, even when a frame runs several; the sim buffers it from there.
        if (stepInput && (stepInput.dashPressed || stepInput.castPressed)) {
          pressesConsumed = true;
          stepInput = { ...stepInput, dashPressed: false, castPressed: false };
        }
      }
      if (hitstop && events.some(isHitstopEvent)) hitstopRemainingMs = config.render.hitstopMs;
      return { events, pressesConsumed };
    },
  };
}

export function isHitstopEvent(event: SimEvent): boolean {
  return event.type === "hit" && event.kind === "direct";
}
