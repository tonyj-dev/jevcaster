import { describe, expect, it } from "vitest";
import { aimBucket, arrivalBucket, distanceBucket, healthBucket } from "../../src/jev/describe/buckets.ts";
import { facingFrame, isSideOpen, sideOf } from "../../src/jev/describe/geometry.ts";
import { noRecentActions, recordRecentActions } from "../../src/jev/describe/recent.ts";
import { describeDuel } from "../../src/jev/state.ts";
import { config } from "../../src/config.ts";
import { idleInput } from "../../src/sim/caster.ts";
import type { Caster, SimEvent, World } from "../../src/sim/types.ts";
import { vector } from "../../src/sim/vector.ts";
import { createWorld, stepWorld } from "../../src/sim/world.ts";
import { buildProbeRecent, buildProbeWorld } from "../fixtures/probeSituation.ts";

const tuning = config.brain.describe;
const stepSeconds = 1 / config.sim.stepHz;

function withCasters(world: World, changes: { warlock?: Partial<Caster>; demon?: Partial<Caster> }): World {
  return { ...world, casters: { warlock: { ...world.casters.warlock, ...changes.warlock }, demon: { ...world.casters.demon, ...changes.demon } } };
}

describe("buckets", () => {
  it("puts distances, arrivals, health and aim on the documented edges", () => {
    expect(distanceBucket(tuning.closeDistance - 0.01)).toBe("close");
    expect(distanceBucket(tuning.closeDistance)).toBe("mid");
    expect(distanceBucket(tuning.farDistance)).toBe("mid");
    expect(distanceBucket(tuning.farDistance + 0.01)).toBe("far");

    expect(arrivalBucket(0.29)).toBe("imminent");
    expect(arrivalBucket(0.3)).toBe("in about half a second");
    expect(arrivalBucket(0.79)).toBe("in about half a second");
    expect(arrivalBucket(0.8)).toBe("later");

    expect(healthBucket(100, 100)).toBe("healthy");
    expect(healthBucket(65, 100)).toBe("hurt");
    expect(healthBucket(31, 100)).toBe("hurt");
    expect(healthBucket(30, 100)).toBe("critical");

    expect(aimBucket(8)).toBe("straight at");
    expect(aimBucket(-8.5)).toBe("near");
    expect(aimBucket(25)).toBe("near");
    expect(aimBucket(26)).toBe("away from");
  });
});

describe("facing frame", () => {
  it("gives each mage its own left while facing the other", () => {
    const world = createWorld();
    const { warlock, demon } = world.casters;
    // The warlock (near the camera) faces away from it, so its left is -x; the demon faces the camera, so its left is +x.
    expect(facingFrame(warlock, demon).left.x).toBeCloseTo(-1);
    expect(facingFrame(demon, warlock).left.x).toBeCloseTo(1);
    expect(sideOf(facingFrame(warlock, demon), vector(-1, 0))).toBe("left");
    expect(sideOf(facingFrame(demon, warlock), vector(-1, 0))).toBe("right");
  });

  it("closes a side when a dash that way would reach the arena edge", () => {
    const world = withCasters(createWorld(), { demon: { position: vector(-8.5, -2) } });
    const frame = facingFrame(world.casters.demon, world.casters.warlock);
    expect(isSideOpen(world.casters.demon, frame, "left")).toBe(true);
    expect(isSideOpen(world.casters.demon, frame, "right")).toBe(false);
  });
});

describe("recent actions", () => {
  const cast = (element: "fire" | "frost"): SimEvent => ({
    type: "projectileSpawned",
    projectile: { id: 1, ownerId: "warlock", element, position: vector(0, 0), velocity: vector(0, -1), detonationPoint: vector(0, -5), remainingDistance: 5 },
  });

  it("remembers the warlock's last cast and dash", () => {
    let recent = recordRecentActions(noRecentActions, 1500, [cast("frost")]);
    recent = recordRecentActions(recent, 2000, [{ type: "dashed", casterId: "warlock", from: vector(0, 0), direction: vector(-1, 0) }]);
    recent = recordRecentActions(recent, 3000, [{ type: "earthCharging", casterId: "warlock", from: vector(0, 0), direction: vector(0, -1) }]);
    expect(recent).toEqual({ lastCast: { element: "earth", atMs: 3000 }, lastDashAtMs: 2000 });
    // The demon's own actions are not recorded.
    expect(recordRecentActions(recent, 4000, [{ type: "earthCharging", casterId: "demon", from: vector(0, 0), direction: vector(0, 1) }])).toBe(recent);
  });
});

describe("describeDuel", () => {
  const world = buildProbeWorld();
  const situation = describeDuel(world, buildProbeRecent(world));

  it("describes the probe duel in words", () => {
    expect(situation.warlock).toMatchObject({
      health: "hurt",
      carrying: "fire",
      movement: "strafing to their left",
      status: "normal",
    });
    expect(situation.demon).toMatchObject({ health: "healthy", carrying: "frost", canCast: "now (frost)", onCooldown: ["earth"], openSides: "left is open; right is near the arena edge" });
    expect(situation.between).toMatchObject({ distance: "mid", warlockAim: "straight at the demon" });
    expect(situation.between.incomingToDemon).toEqual([{ element: "fire", arrives: "in about half a second", cloakCanBlock: "yes, if it cloaks now (switching to fire costs no time)" }]);
    expect(situation.counters).toEqual({
      warlockWeakTo: "earth",
      demonHasWarlockWeaknessReady: "no",
      riskyForDemonToCarry: "frost",
      warlockCloakBlocks: "nothing",
    });
    expect(situation.round).toBe("round 2 of 5; warlock leads 1–0; demon ahead on health");
    expect(situation.warlock.openings).toBe("just cast, so it can't cast again yet");
    expect(situation.demon.position).toBe("near the edge");
  });

  it("never sends a raw number", () => {
    const numbers: unknown[] = [];
    JSON.stringify(situation, (_key, value: unknown) => {
      if (typeof value === "number") numbers.push(value);
      return value;
    });
    expect(numbers).toEqual([]);
  });

  it("hides the opponent's cooldowns and cast recovery, as the screen does", () => {
    const fresh = createWorld();
    const exhausted = withCasters(fresh, { warlock: { cooldownsMs: { fire: 3000, frost: 2000, earth: 4000 }, recoveryRemainingMs: 900, dashCooldownMs: 4000 } });
    expect(describeDuel(exhausted, noRecentActions).warlock).toEqual(describeDuel(fresh, noRecentActions).warlock);
  });

  it("reports cloaks, burns and charges", () => {
    const busy = withCasters(createWorld(), {
      warlock: { cloak: { phase: "up", guards: "frost", elapsedMs: 400 }, charge: null, burnRemainingMs: 500 },
      demon: { freezeRemainingMs: 400 },
    });
    const described = describeDuel(busy, noRecentActions);
    expect(described.warlock.cloak).toBe("frost cloak up: blocks only frost (fire and earth go through), and it can't cast while cloaked");
    expect(described.counters.warlockCloakBlocks).toBe("frost");
    expect(described.demon.cloak).toBe("no cloak up");
    expect(described.warlock.status).toBe("burning");
    const charging = withCasters(createWorld(), { demon: { charge: { remainingMs: 250, direction: vector(0, 1) }, burnRemainingMs: 200 } });
    const chargingDescription = describeDuel(charging, noRecentActions);
    expect(chargingDescription.demon.canCast).toBe("charging an earthspike now");
  });

  it("reads the warlock's openings from the cast and dash it saw, not from hidden timers", () => {
    const world = createWorld();
    const seen = { ...noRecentActions, lastCast: { element: "fire" as const, atMs: world.timeMs - 300 }, lastDashAtMs: world.timeMs - 500 };
    expect(describeDuel(world, seen).warlock.openings).toBe("just cast, so it can't cast again yet; just dashed, so it can't dash again yet");
    const longAgo = { ...seen, lastCast: { element: "fire" as const, atMs: world.timeMs - 5000 }, lastDashAtMs: world.timeMs - 5000 };
    expect(describeDuel(world, longAgo).warlock.openings).toBe("none");
  });

  it("says where each mage stands, who leads on health and when it is match point", () => {
    const start = createWorld();
    const cornered = withCasters({ ...start, round: { ...start.round, wins: { warlock: 2, demon: 2 } } }, { warlock: { position: vector(0, 0), health: 40 }, demon: { position: vector(0, -10) } });
    const described = describeDuel(cornered, noRecentActions);
    expect(described.demon.position).toBe("near the edge");
    expect(described.round).toBe("round 1 of 5; tied 2–2; demon ahead on health; match point for demon; match point for warlock");
  });

  it("says when the demon must wait before casting", () => {
    const recovering = describeDuel(withCasters(createWorld(), { demon: { recoveryRemainingMs: 900 } }), noRecentActions);
    expect(recovering.demon.canCast).toBe("not yet: recovering from its last cast");
    const cooling = describeDuel(withCasters(createWorld(), { demon: { recoveryRemainingMs: 300, cooldownsMs: { fire: 2000, frost: 0, earth: 0 } } }), noRecentActions);
    expect(cooling.demon.canCast).toBe("not soon: fire is on cooldown");
    const almost = describeDuel(withCasters(createWorld(), { demon: { recoveryRemainingMs: 200 } }), noRecentActions);
    expect(almost.demon.canCast).toBe("in a moment (fire)");
  });
});
