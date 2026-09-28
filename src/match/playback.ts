import { config } from "../config.ts";
import type { CasterId, SimEvent, World } from "../sim/types.ts";
import { isHitstopEvent } from "./engine.ts";
import type { BrainBadge } from "./protocol.ts";

export type PlaybackStep = {
  readonly world: World;
  readonly events: readonly SimEvent[];
  readonly badges: Readonly<Record<CasterId, BrainBadge>>;
};

export type PlaybackFrame = {
  readonly previous: World;
  readonly current: World;
  readonly alpha: number;
  // Events of every step that became current since the last frame, each exactly once.
  readonly events: readonly SimEvent[];
  readonly badges: Readonly<Record<CasterId, BrainBadge>>;
};

export type Playback = {
  reset(world: World): void;
  push(step: PlaybackStep): void;
  advance(frameSeconds: number): PlaybackFrame | null;
};

const noBadges: Readonly<Record<CasterId, BrainBadge>> = {
  warlock: { label: "Jev", outOfMana: null },
  demon: { label: "Jev", outOfMana: null },
};
// Ten seconds of steps; a hidden tab stops rendering but keeps receiving.
const maxBufferedSteps = 600;

// Plays the server's step stream a few steps behind the newest one, interpolating between steps.
// It speeds up or slows slightly to hold that delay, jumps when far off, and applies hitstop locally.
export function createPlayback(): Playback {
  let steps: PlaybackStep[] = [];
  let renderTick = 0;
  let firedTick = 0;
  let hitstopRemainingMs = 0;

  return {
    reset(world) {
      steps = [{ world, events: [], badges: noBadges }];
      renderTick = world.tick;
      firedTick = world.tick;
      hitstopRemainingMs = 0;
    },

    push(step) {
      const newest = steps[steps.length - 1];
      if (newest && step.world.tick <= newest.world.tick) return;
      steps.push(step);
      if (steps.length > maxBufferedSteps) steps = steps.slice(-maxBufferedSteps);
    },

    advance(frameSeconds) {
      const oldest = steps[0];
      const newest = steps[steps.length - 1];
      if (!oldest || !newest) return null;
      const tuning = config.duel;
      const targetTick = newest.world.tick - tuning.interpolationDelaySteps;
      const error = targetTick - renderTick;
      const jumped = Math.abs(error) > tuning.snapSteps;
      if (jumped) {
        renderTick = targetTick;
        hitstopRemainingMs = 0;
      } else if (hitstopRemainingMs > 0) {
        hitstopRemainingMs -= frameSeconds * 1000;
      } else {
        const rate = 1 + Math.max(-tuning.maxCatchUp, Math.min(tuning.maxCatchUp, error * tuning.catchUpPerStep));
        renderTick += frameSeconds * config.sim.stepHz * rate;
      }
      renderTick = Math.max(oldest.world.tick, Math.min(newest.world.tick, renderTick));

      // The last step at or before renderTick, and the next one after it (steps can have gaps).
      let previousIndex = 0;
      while (previousIndex + 1 < steps.length && steps[previousIndex + 1]!.world.tick <= renderTick) previousIndex += 1;
      const previous = steps[previousIndex]!;
      const current = steps[previousIndex + 1] ?? previous;
      const span = current.world.tick - previous.world.tick;
      const alpha = span > 0 ? (renderTick - previous.world.tick) / span : 0;

      // A jump skips the events in between: replaying them all at once would be noise.
      const events = jumped
        ? current.world.tick > firedTick
          ? current.events
          : []
        : steps.filter((step) => step.world.tick > firedTick && step.world.tick <= current.world.tick).flatMap((step) => step.events);
      firedTick = Math.max(firedTick, current.world.tick);
      if (events.some(isHitstopEvent)) hitstopRemainingMs = config.render.hitstopMs;

      // Keep one step behind the one in use, for interpolation after a small backwards correction.
      if (previousIndex > 1) steps = steps.slice(previousIndex - 1);
      return { previous: previous.world, current: current.world, alpha, events, badges: current.badges };
    },
  };
}
