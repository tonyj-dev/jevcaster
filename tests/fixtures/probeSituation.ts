import type { RecentActions } from "../../src/jev/describe/recent.ts";
import type { BrainRequest } from "../../src/jev/protocol.ts";
import { buildTickRequest, type TickOptions } from "../../src/jev/questions.ts";
import { config } from "../../src/config.ts";
import { idleInput } from "../../src/sim/caster.ts";
import type { Caster, CasterInput, World } from "../../src/sim/types.ts";
import { vector } from "../../src/sim/vector.ts";
import { createWorld, stepWorld } from "../../src/sim/world.ts";

// The canned duel for `pnpm brain:probe`, played out in the real sim and described by the real code,
// so the recorded fixtures match what the game sends.
//
// Round 2, the warlock leads 1–0 and is hurt. The warlock just switched from frost to fire and cast a
// fireball at the demon, which arrives in about half a second. The demon carries frost, which fire beats,
// so the fireball would hit it 1.5×; a frost cloak can't stop it, but switching to fire and cloaking can.
// The demon's right is near the arena edge.

const stepSeconds = 1 / config.sim.stepHz;

function withCasters(world: World, changes: { warlock?: Partial<Caster>; demon?: Partial<Caster> }): World {
  return {
    ...world,
    casters: {
      warlock: { ...world.casters.warlock, ...changes.warlock },
      demon: { ...world.casters.demon, ...changes.demon },
    },
  };
}

export function buildProbeWorld(): World {
  const start = createWorld();
  let world: World = withCasters(
    { ...start, round: { ...start.round, number: 2, wins: { warlock: 1, demon: 0 } } },
    {
      warlock: { position: vector(-2, 2), carried: "frost", health: 58 },
      demon: { position: vector(-7.5, -3), carried: "frost", health: 88, cooldownsMs: { fire: 0, frost: 0, earth: 2600 } },
    },
  );
  const castStep = Math.ceil(config.sim.switchMs / 1000 / stepSeconds) + 1;
  // Switch to fire, strafe to the warlock's left while it settles, cast at the demon, then let the fireball fly for a moment.
  for (let step = 0; step < castStep + 8; step += 1) {
    const demon = world.casters.demon;
    const warlock: CasterInput = { ...idleInput(demon.position), carry: "fire", move: vector(-0.68, 0.73), castHeld: step === castStep };
    world = stepWorld(world, { warlock, demon: idleInput(world.casters.warlock.position) }, stepSeconds).world;
  }
  return world;
}

// What the demon saw the warlock do just now, timed relative to the probe world.
export function buildProbeRecent(world: World): RecentActions {
  const nowMs = world.timeMs;
  return {
    lastCast: { element: "fire", atMs: nowMs - 130 },
    lastDashAtMs: null,
  };
}

function buildProbe(): { request: BrainRequest; options: TickOptions } {
  const world = buildProbeWorld();
  const tick = buildTickRequest(world, buildProbeRecent(world));
  return { request: { ...tick.request, kind: "probe" }, options: tick.options };
}

const probe = buildProbe();
export const probeSituation: BrainRequest = probe.request;
export const probeTickOptions: TickOptions = probe.options;
