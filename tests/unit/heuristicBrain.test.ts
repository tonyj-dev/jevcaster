import { describe, expect, it } from "vitest";
import { createHeuristicMemory, elementWeight, heuristicDemonInput, type HeuristicMemory } from "../../src/brain/heuristicBrain.ts";
import { findThreats } from "../../src/sim/threats.ts";
import { config } from "../../src/config.ts";
import { idleInput } from "../../src/sim/caster.ts";
import type { CasterInput, Element, SimEvent, World } from "../../src/sim/types.ts";
import { dot, length, vector } from "../../src/sim/vector.ts";
import { createWorld, stepWorld } from "../../src/sim/world.ts";

const tuning = config.heuristicBrain;
const simTuning = config.sim;
const stepSeconds = 1 / simTuning.stepHz;
const reactionSteps = Math.ceil(tuning.reactionDelayMs / 1000 / stepSeconds);

// Standing-still demon that never casts, so only its reaction is tested.
const passive = { ...tuning, castChancePerSecond: 0, distanceTolerance: 20, strafeWeight: 0 };

function playOut(start: World, steps: number, warlockInput: (world: World, step: number) => Partial<CasterInput>, brainTuning = tuning) {
  let world = start;
  let memory: HeuristicMemory = createHeuristicMemory(3);
  const events: SimEvent[] = [];
  const demonInputs: CasterInput[] = [];
  for (let step = 0; step < steps; step += 1) {
    const decision = heuristicDemonInput(world, memory, brainTuning);
    memory = decision.memory;
    demonInputs.push(decision.input);
    const warlock = { ...idleInput(world.casters.demon.position), ...warlockInput(world, step) };
    const result = stepWorld(world, { warlock, demon: decision.input }, stepSeconds);
    world = result.world;
    events.push(...result.events);
  }
  return { world, events, demonInputs, memory };
}

const withWarlockElement = (element: Element): World => {
  const world = createWorld();
  return { ...world, casters: { ...world.casters, warlock: { ...world.casters.warlock, carried: element } } };
};

describe("threat detection", () => {
  it("sees an incoming fireball as a threat and a sideways one as harmless", () => {
    const start = createWorld();
    const aimedAtDemon = stepWorld(start, { warlock: { ...idleInput(start.casters.demon.position), castHeld: true }, demon: idleInput(start.casters.warlock.position) }, stepSeconds).world;
    expect(findThreats(aimedAtDemon, aimedAtDemon.casters.demon, 5, simTuning)).toEqual([expect.objectContaining({ element: "fire" })]);
    const aimedAway = stepWorld(start, { warlock: { ...idleInput(vector(8, 5)), castHeld: true }, demon: idleInput(start.casters.warlock.position) }, stepSeconds).world;
    expect(findThreats(aimedAway, aimedAway.casters.demon, 5, simTuning)).toEqual([]);
  });

  it("sees a earth charge aimed at it", () => {
    const start = withWarlockElement("earth");
    const charging = stepWorld(start, { warlock: { ...idleInput(start.casters.demon.position), castHeld: true }, demon: idleInput(start.casters.warlock.position) }, stepSeconds).world;
    expect(findThreats(charging, charging.casters.demon, 1, simTuning)).toEqual([expect.objectContaining({ element: "earth", key: "earth-warlock" })]);
  });
});

describe("heuristic demon reactions", () => {
  it("dodges sideways after its reaction delay when it always chooses to dodge", () => {
    const { events, demonInputs } = playOut(createWorld(), simTuning.stepHz * 2, (_world, step) => ({ castHeld: step === 0 }), { ...passive, dodgeChance: 1, cloakChance: 0 });
    expect(events.some((event) => event.type === "hit" && event.casterId === "demon")).toBe(false);
    expect(Math.abs(demonInputs[reactionSteps + 2]!.move.x)).toBeGreaterThan(0.9);
  });

  it("switches to the threat's element, raises that cloak, and takes no damage", () => {
    const start = createWorld();
    const carryingFrost = { ...start, casters: { ...start.casters, demon: { ...start.casters.demon, carried: "frost" as const } } };
    const { events, world } = playOut(carryingFrost, simTuning.stepHz * 2, (_world, step) => ({ castHeld: step === 0 }), { ...passive, reactionDelayMs: 100, threatWindowSeconds: 3, dodgeChance: 0, cloakChance: 1 });
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "carryChanged", casterId: "demon", to: "fire" }), expect.objectContaining({ type: "cloakRaising", casterId: "demon", guards: "fire" })]),
    );
    expect(events.find((event) => event.type === "hit" && event.casterId === "demon")).toMatchObject({ blocked: true, damage: 0 });
    expect(world.casters.demon.health).toBe(simTuning.caster.maxHealth);
  });

  it("dodges a earth charge when it reacts fast enough", () => {
    const quick = { ...passive, reactionDelayMs: 50, dodgeChance: 1, cloakChance: 0 };
    const { events } = playOut(withWarlockElement("earth"), simTuning.stepHz, (_world, step) => ({ castHeld: step === 0 }), quick);
    expect(events.find((event) => event.type === "earthStrike")).toMatchObject({ hitCasterId: null });
  });

  it("remembers a shot it chose to take and does not react to it later", () => {
    const { memory } = playOut(createWorld(), Math.round(simTuning.stepHz * 0.6), (_world, step) => ({ castHeld: step === 0 }), { ...passive, dodgeChance: 0, cloakChance: 0 });
    expect(memory.reaction).toBeNull();
    expect(memory.ignoredThreatKeys).toHaveLength(1);
  });

});

describe("heuristic demon offence", () => {
  it("closes distance when far and casts several different elements over time", () => {
    const start = createWorld();
    const far: World = { ...start, casters: { ...start.casters, demon: { ...start.casters.demon, position: vector(0, -8.4) } } };
    const { demonInputs, events } = playOut(far, simTuning.stepHz * 20, () => ({}));
    expect(dot(demonInputs[1]!.move, vector(0, 1))).toBeGreaterThan(0.5);
    const castElements = new Set(
      events.flatMap((event) =>
        event.type === "projectileSpawned" && event.projectile.ownerId === "demon" ? [event.projectile.element] : event.type === "earthCharging" && event.casterId === "demon" ? ["earth"] : [],
      ),
    );
    expect(castElements.size).toBeGreaterThanOrEqual(3);
  });

  it("goes for earth when the warlock is frozen", () => {
    const start = createWorld();
    const frozen: World = { ...start, casters: { warlock: { ...start.casters.warlock, freezeRemainingMs: 1100 }, demon: { ...start.casters.demon, position: vector(0, -2) } } };
    const eager = { ...tuning, castChancePerSecond: 1000 };
    const { events } = playOut(frozen, 30, () => ({}), eager);
    expect(events.find((event) => event.type === "earthCharging" || event.type === "projectileSpawned")).toMatchObject({ type: "earthCharging" });
  });

  it("favours the attack that counters what the warlock carries, and avoids being countered", () => {
    expect(elementWeight("earth", "fire", tuning)).toBeGreaterThan(elementWeight("earth", "earth", tuning));
    expect(elementWeight("frost", "fire", tuning)).toBeLessThan(elementWeight("frost", "frost", tuning));
    expect(elementWeight("fire", "fire", tuning)).toBe(tuning.spellWeights.fire);
  });

  it("stands idle when the round is over", () => {
    const start = createWorld();
    const ended: World = { ...start, round: { ...start.round, phase: "ended", winner: "warlock" } };
    const decision = heuristicDemonInput(ended, createHeuristicMemory());
    expect(length(decision.input.move)).toBe(0);
    expect(decision.input.castHeld).toBe(false);
  });

  it("is deterministic for a given seed", () => {
    const script = (_world: World, step: number) => ({ castHeld: step % 50 === 10 });
    expect(playOut(createWorld(), 400, script).world).toEqual(playOut(createWorld(), 400, script).world);
  });
});
