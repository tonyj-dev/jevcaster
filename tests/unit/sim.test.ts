import { describe, expect, it } from "vitest";
import { config } from "../../src/config.ts";
import { idleInput } from "../../src/sim/caster.ts";
import type { Caster, CasterId, CasterInput, Element, SimEvent, World } from "../../src/sim/types.ts";
import { beatenBy, beats, elements } from "../../src/sim/types.ts";
import { distance, length, vector, zeroVector } from "../../src/sim/vector.ts";
import { createWorld, stepWorld, type Inputs } from "../../src/sim/world.ts";

const tuning = config.sim;
const spells = tuning.spells;
const cloak = tuning.cloak;
const stepSeconds = 1 / tuning.stepHz;
const stepsFor = (milliseconds: number) => Math.ceil(milliseconds / 1000 / stepSeconds);

type InputScript = (world: World, step: number) => Partial<Record<CasterId, Partial<CasterInput>>>;

function run(world: World, steps: number, script: InputScript = () => ({})) {
  let current = world;
  const events: SimEvent[] = [];
  for (let step = 0; step < steps; step += 1) {
    const overrides = script(current, step);
    const inputs: Inputs = {
      warlock: { ...idleInput(current.casters.demon.position), ...overrides.warlock },
      demon: { ...idleInput(current.casters.warlock.position), ...overrides.demon },
    };
    const result = stepWorld(current, inputs, stepSeconds);
    current = result.world;
    events.push(...result.events);
  }
  return { world: current, events };
}

function withCaster(world: World, casterId: CasterId, changes: Partial<Caster>): World {
  return { ...world, casters: { ...world.casters, [casterId]: { ...world.casters[casterId], ...changes } } };
}

const carrying = (warlock: Element, demon: Element = "frost"): World => withCaster(withCaster(createWorld(), "warlock", { carried: warlock }), "demon", { carried: demon });

const hitsOn = (events: readonly SimEvent[], casterId: CasterId) =>
  events.filter((event): event is Extract<SimEvent, { type: "hit" }> => event.type === "hit" && event.casterId === casterId);
const count = (events: readonly SimEvent[], type: SimEvent["type"]) => events.filter((event) => event.type === type).length;
const maxHealth = tuning.caster.maxHealth;
const castOnce = (atStep = 0) => (_world: World, step: number) => ({ warlock: { castHeld: step === atStep } });

describe("movement and dash", () => {
  it("moves at move speed and never leaves the arena", () => {
    const oneSecond = run(createWorld(), tuning.stepHz, () => ({ warlock: { move: vector(1, 0) } }));
    expect(oneSecond.world.casters.warlock.position.x).toBeCloseTo(tuning.caster.moveSpeed * tuning.carryMoveFactor.fire, 1);
    const tenSeconds = run(createWorld(), tuning.stepHz * 10, () => ({ warlock: { move: vector(1, 0) } }));
    expect(length(tenSeconds.world.casters.warlock.position)).toBeLessThanOrEqual(tuning.arenaRadius - tuning.caster.radius + 1e-9);
  });

  it.each(elements)("moves at the speed of the carried spell: %s", (element) => {
    const { world } = run(carrying(element), tuning.stepHz, () => ({ warlock: { move: vector(1, 0) } }));
    expect(world.casters.warlock.position.x).toBeCloseTo(tuning.caster.moveSpeed * tuning.carryMoveFactor[element], 1);
  });

  it("dashes the configured distance, once per cooldown", () => {
    const dashed = run(createWorld(), stepsFor(tuning.dash.durationMs), (_world, step) => ({ warlock: { move: vector(-1, 0), dashPressed: step === 0 } }));
    expect(-dashed.world.casters.warlock.position.x).toBeCloseTo(tuning.dash.distance, 0);
    const spammed = run(createWorld(), stepsFor(tuning.dash.durationMs) * 2, () => ({ warlock: { dashPressed: true } }));
    expect(count(spammed.events, "dashed")).toBe(1);
  });
});

describe("carrying, cooldowns and recovery", () => {
  it("respects the cooldown while the button is held", () => {
    // The wait between held casts is the longer of the spell cooldown and the shared recovery.
    const interval = Math.max(spells.fire.cooldownMs, tuning.castRecoveryMs);
    const { events } = run(createWorld(), stepsFor(interval * 2.5), () => ({ warlock: { castHeld: true } }));
    expect(count(events, "projectileSpawned")).toBe(3);
  });

  it("rewards rotating spells over repeating one", () => {
    // Every spell's own cooldown outlasts the shared recovery, so the recovery alone never paces a single spell.
    for (const element of elements) expect(spells[element].cooldownMs).toBeGreaterThanOrEqual(tuning.castRecoveryMs * 2);
    const window = stepsFor(6000);
    const repeated = run(carrying("frost"), window, () => ({ warlock: { castHeld: true } }));
    // Rotate fire -> frost -> earth, moving on to the next spell after each cast.
    let next = 0;
    const rotated = run(carrying("fire"), window, (world) => {
      const warlock = world.casters.warlock;
      if (warlock.cooldownsMs[elements[next]!] > 0) next = (next + 1) % elements.length;
      return { warlock: { carry: elements[next]!, castHeld: true } };
    });
    const attacks = (events: readonly SimEvent[]) => count(events, "projectileSpawned") + count(events, "earthCharging");
    expect(attacks(rotated.events)).toBeGreaterThanOrEqual(attacks(repeated.events) * 1.5);
  });

  it("shows a new spell at once but delays casting it by the switch time", () => {
    const { events } = run(createWorld(), stepsFor(400), () => ({ warlock: { carry: "frost", castHeld: true } }));
    expect(events.find((event) => event.type === "carryChanged")).toMatchObject({ casterId: "warlock", from: "fire", to: "frost" });
    const early = run(createWorld(), stepsFor(tuning.switchMs) - 1, () => ({ warlock: { carry: "frost", castHeld: true } }));
    expect(count(early.events, "projectileSpawned")).toBe(0);
    expect(events.find((event) => event.type === "projectileSpawned")).toMatchObject({ projectile: { element: "frost" } });
  });

  it("blocks every attack for the shared recovery after a cast, even a different one", () => {
    // Fire at once, then switch to frost and hold: the switch settles first, the recovery decides.
    let world = carrying("fire");
    const spawns: { step: number; element: string }[] = [];
    for (let step = 0; step < stepsFor(Math.max(tuning.castRecoveryMs, tuning.switchMs) + 500); step += 1) {
      const result = run(world, 1, () => ({ warlock: { carry: step === 0 ? "fire" : "frost", castHeld: true } }));
      for (const event of result.events) if (event.type === "projectileSpawned") spawns.push({ step, element: event.projectile.element });
      world = result.world;
    }
    expect(spawns.map((spawn) => spawn.element)).toEqual(["fire", "frost"]);
    expect(spawns[1]!.step).toBeGreaterThan(stepsFor(tuning.switchMs) + 1);
    expect(spawns[1]!.step).toBeGreaterThanOrEqual(stepsFor(tuning.castRecoveryMs) - 1);
  });


});

describe("counters", () => {
  it("hits a mage carrying the element the attack beats harder", () => {
    const countered = run(carrying("fire", "frost"), stepsFor(1500), castOnce());
    expect(hitsOn(countered.events, "demon")[0]).toMatchObject({ countered: true, damage: spells.fire.directDamage * tuning.counterDamageMultiplier });
    const neutral = run(carrying("fire", "earth"), stepsFor(1500), castOnce());
    expect(hitsOn(neutral.events, "demon")[0]).toMatchObject({ countered: false, damage: spells.fire.directDamage });
  });

  it("is a closed triangle", () => {
    for (const element of elements) {
      expect(beatenBy[beats[element]]).toBe(element);
      expect(beats[element]).not.toBe(element);
    }
  });

  it("follows the triangle: frost beats earth, earth beats fire", () => {
    const frostOnEarth = run(carrying("frost", "earth"), stepsFor(1000), castOnce());
    expect(hitsOn(frostOnEarth.events, "demon")[0]).toMatchObject({ countered: true });
    const earthOnFire = run(carrying("earth", "fire"), stepsFor(1000), castOnce());
    expect(hitsOn(earthOnFire.events, "demon")[0]).toMatchObject({ countered: true, damage: spells.earth.damage * tuning.counterDamageMultiplier });
    const earthOnEarth = run(carrying("earth", "earth"), stepsFor(1000), castOnce());
    expect(hitsOn(earthOnEarth.events, "demon")[0]).toMatchObject({ countered: false, damage: spells.earth.damage });
  });
});

describe("fireball", () => {
  it("deals direct damage plus burn to a standing target, never to its caster", () => {
    const { world, events } = run(carrying("fire", "earth"), tuning.stepHz * 3, castOnce());
    expect(hitsOn(events, "demon")).toEqual([expect.objectContaining({ kind: "direct", damage: spells.fire.directDamage, blocked: false })]);
    const burnDamage = (spells.fire.burnDamagePerSecond * spells.fire.burnDurationMs) / 1000;
    expect(world.casters.demon.health).toBeCloseTo(maxHealth - spells.fire.directDamage - burnDamage, 1);
    expect(world.casters.warlock.health).toBe(maxHealth);
  });

  it("detonates at the aimed point and splashes a nearby target", () => {
    const start = createWorld();
    const demonPosition = start.casters.demon.position;
    const nearMiss = vector(demonPosition.x + spells.fire.splashRadius, demonPosition.z + 1);
    const { events } = run(start, tuning.stepHz * 2, (_world, step) => ({ warlock: { castHeld: step === 0, aimPoint: nearMiss } }));
    const explosion = events.find((event) => event.type === "exploded");
    expect(explosion && distance(explosion.position, nearMiss)).toBeLessThan(0.01);
    expect(hitsOn(events, "demon")).toEqual([expect.objectContaining({ kind: "splash" })]);
  });

  it("can be dodged by stepping out of its path", () => {
    const { events } = run(createWorld(), tuning.stepHz * 2, (_world, step) => ({ warlock: { castHeld: step === 0 }, demon: { move: vector(1, 0) } }));
    expect(hitsOn(events, "demon")).toEqual([]);
  });
});

describe("frost lance", () => {
  it("freezes on a single hit", () => {
    const { events, world } = run(carrying("frost", "fire"), stepsFor(700), castOnce());
    expect(count(events, "frozen")).toBe(1);
    expect(world.casters.demon.freezeRemainingMs).toBeGreaterThan(0);
    expect(world.casters.demon.freezeRemainingMs).toBeLessThanOrEqual(spells.frost.freezeMs);
  });

  it("stops a frozen mage from moving or casting until it thaws", () => {
    const frozen = withCaster(createWorld(), "demon", { freezeRemainingMs: spells.frost.freezeMs });
    const whileFrozen = run(frozen, stepsFor(spells.frost.freezeMs) - 2, () => ({ demon: { move: vector(1, 0), castHeld: true } }));
    expect(whileFrozen.world.casters.demon.position).toEqual(frozen.casters.demon.position);
    expect(count(whileFrozen.events, "projectileSpawned")).toBe(0);
    const thawed = run(whileFrozen.world, 5, () => ({ demon: { move: vector(1, 0) } }));
    expect(count(thawed.events, "thawed")).toBe(1);
    expect(thawed.world.casters.demon.position.x).toBeGreaterThan(0);
  });
});

describe("cloak", () => {
  const baseDamage = (attack: Element) => (attack === "fire" ? spells.fire.directDamage : spells[attack].damage);

  it("takes the form of the carried spell and guards against that same element", () => {
    for (const element of elements) {
      const { events } = run(carrying("fire", element), 3, () => ({ demon: { cloakHeld: true } }));
      expect(events.find((event) => event.type === "cloakRaising")).toMatchObject({ casterId: "demon", guards: element });
    }
  });

  it("blocks all damage from its own element once fully raised, and the fireball does not burn or the lance freeze", () => {
    expect(cloak.blockFraction).toBe(1);
    for (const attack of elements) {
      const { events, world } = run(carrying(attack, attack), tuning.stepHz * 3, (_world, step) => ({
        warlock: { castHeld: step === stepsFor(cloak.windUpMs) },
        demon: { cloakHeld: step < tuning.stepHz * 2 },
      }));
      const expected = baseDamage(attack) * (1 - cloak.blockFraction);
      expect(hitsOn(events, "demon")).toEqual([expect.objectContaining({ element: attack, blocked: true, damage: expect.closeTo(expected, 5) })]);
      expect(world.casters.demon.health).toBe(maxHealth);
      expect(world.casters.demon.freezeRemainingMs).toBe(0);
    }
  });

  it("never stops the other two elements: the counter to the carried spell, nor the one it beats", () => {
    // Frost carries a frost cloak: fire counters frost and hits for the bonus; earth (which frost beats) hits normally.
    const countered = run(carrying("fire", "frost"), tuning.stepHz * 2, (_world, step) => ({ warlock: { castHeld: step === stepsFor(cloak.windUpMs) }, demon: { cloakHeld: true } }));
    expect(hitsOn(countered.events, "demon")[0]).toMatchObject({ blocked: false, countered: true, damage: spells.fire.directDamage * tuning.counterDamageMultiplier });
    const beaten = run(carrying("earth", "frost"), tuning.stepHz * 2, (_world, step) => ({ warlock: { castHeld: step === stepsFor(cloak.windUpMs) }, demon: { cloakHeld: true } }));
    expect(hitsOn(beaten.events, "demon")[0]).toMatchObject({ blocked: false, countered: false, damage: spells.earth.damage });
  });

  it("does not block during the wind-up, but is not held back by the switch time", () => {
    // Switching to earth as the earth charge starts is in time, since the cloak re-forms at once.
    const switched = run(carrying("earth", "fire"), stepsFor(700), (_world, step) => ({ warlock: { castHeld: step === 0 }, demon: { carry: "earth", cloakHeld: true } }));
    expect(hitsOn(switched.events, "demon")[0]).toMatchObject({ blocked: true });
    // Raising the cloak only once the spikes are about to land is too late.
    const late = run(carrying("earth", "earth"), stepsFor(700), (_world, step) => ({
      warlock: { castHeld: step === 0 },
      demon: { cloakHeld: step >= stepsFor(spells.earth.chargeMs - cloak.windUpMs / 2) },
    }));
    expect(hitsOn(late.events, "demon")[0]).toMatchObject({ blocked: false });
  });

  it("slows movement and stays up for as long as it is held", () => {
    const moving = run(carrying("fire", "frost"), tuning.stepHz, () => ({ demon: { cloakHeld: true, move: vector(1, 0) } }));
    expect(moving.world.casters.demon.position.x).toBeCloseTo(tuning.caster.moveSpeed * cloak.moveFactor * tuning.carryMoveFactor.frost, 0);
    const longHold = run(carrying("fire", "frost"), tuning.stepHz * 20, () => ({ demon: { cloakHeld: true } }));
    expect(count(longHold.events, "cloakDropped")).toBe(0);
    expect(longHold.world.casters.demon.cloak.phase).toBe("up");
  });

  it("can be dropped and raised again at once", () => {
    const flicker = run(carrying("fire"), stepsFor(1000), (_world, step) => ({ warlock: { cloakHeld: step % 10 < 5 } }));
    expect(count(flicker.events, "cloakRaising")).toBe(Math.ceil(stepsFor(1000) / 10));
  });

  it("can be raised while the carried spell cools down", () => {
    const afterCast = run(carrying("fire"), 2, (_world, step) => ({ warlock: { castHeld: step === 0 } }));
    expect(afterCast.world.casters.warlock.cooldownsMs.fire).toBeGreaterThan(0);
    const cloaked = run(afterCast.world, 3, () => ({ warlock: { cloakHeld: true } }));
    expect(count(cloaked.events, "cloakRaising")).toBe(1);
  });

  it("re-forms around the new spell when its owner switches, and gives way to a cast once released", () => {
    // Stops halfway through the new cloak's wind-up.
    const switchedAway = run(carrying("fire", "frost"), stepsFor(400 + cloak.windUpMs / 2), (_world, step) => ({ demon: { cloakHeld: true, carry: step < stepsFor(400) ? "frost" : "fire" } }));
    expect(count(switchedAway.events, "cloakDropped")).toBe(1);
    expect(count(switchedAway.events, "cloakRaising")).toBe(2);
    expect(switchedAway.world.casters.demon.cloak).toMatchObject({ phase: "raising", guards: "fire" });
    // Holding both keeps the cloak up; releasing the cloak lets the held cast fire.
    const bothHeld = run(carrying("fire"), stepsFor(600), () => ({ warlock: { cloakHeld: true, castHeld: true } }));
    expect(count(bothHeld.events, "cloakRaising")).toBe(1);
    expect(count(bothHeld.events, "projectileSpawned")).toBe(0);
    const released = run(bothHeld.world, 2, () => ({ warlock: { castHeld: true } }));
    expect(count(released.events, "cloakDropped")).toBe(1);
    expect(count(released.events, "projectileSpawned")).toBe(1);
  });

  it("never breaks, however many hits it blocks", () => {
    // Earth strikes an earth cloak again and again; the cooldowns are cleared before each cast.
    let world = carrying("earth", "earth");
    const events: SimEvent[] = [];
    for (let strike = 0; strike < 5; strike += 1) {
      world = withCaster(world, "warlock", { cooldownsMs: { fire: 0, frost: 0, earth: 0 }, recoveryRemainingMs: 0 });
      const result = run(world, stepsFor(700), (_world, step) => ({ warlock: { castHeld: step === 0 }, demon: { cloakHeld: true } }));
      world = result.world;
      events.push(...result.events);
    }
    expect(hitsOn(events, "demon")).toHaveLength(5);
    expect(hitsOn(events, "demon").every((hit) => hit.blocked)).toBe(true);
    expect(count(events, "cloakDropped")).toBe(0);
  });
});

describe("earthspike", () => {
  it("hits only after the visible charge-up, and roots the caster while charging", () => {
    const beforeRelease = run(carrying("earth"), stepsFor(spells.earth.chargeMs) - 2, (_world, step) => ({ warlock: { castHeld: step === 0, move: vector(1, 0) } }));
    expect(count(beforeRelease.events, "earthCharging")).toBe(1);
    expect(hitsOn(beforeRelease.events, "demon")).toEqual([]);
    // One step of movement happens before the charge begins; after that the caster is rooted.
    expect(beforeRelease.world.casters.warlock.position.x).toBeLessThan(tuning.caster.moveSpeed * stepSeconds * 1.01);

    const released = run(beforeRelease.world, 4);
    expect(hitsOn(released.events, "demon")).toEqual([expect.objectContaining({ kind: "spikes", damage: spells.earth.damage })]);
  });

  it("fires along the direction locked at the start, so a sidestep during the charge dodges it", () => {
    const { events } = run(carrying("earth"), stepsFor(700), (_world, step) => ({ warlock: { castHeld: step === 0 }, demon: { move: vector(1, 0) } }));
    expect(events.find((event) => event.type === "earthStrike")).toMatchObject({ hitCasterId: null });
  });
});

describe("buffered presses and combos", () => {
  const buffer = tuning.inputBuffer;

  it("fires a cast pressed just before the recovery ends, and drops one pressed too early", () => {
    const recovering = withCaster(carrying("frost"), "warlock", { recoveryRemainingMs: buffer.castMs / 2 });
    const justInTime = run(recovering, stepsFor(buffer.castMs), (_world, step) => ({ warlock: { castPressed: step === 0 } }));
    expect(count(justInTime.events, "projectileSpawned")).toBe(1);
    expect(count(justInTime.events, "pressExpired")).toBe(0);

    const tooEarly = withCaster(carrying("frost"), "warlock", { recoveryRemainingMs: buffer.castMs * 3 });
    const dropped = run(tooEarly, stepsFor(buffer.castMs * 4), (_world, step) => ({ warlock: { castPressed: step === 0 } }));
    expect(count(dropped.events, "projectileSpawned")).toBe(0);
    expect(dropped.events.filter((event) => event.type === "pressExpired")).toEqual([{ type: "pressExpired", casterId: "warlock", action: "cast" }]);
  });

  it("holds a cast pressed during a switch until the switch settles", () => {
    const { events } = run(createWorld(), stepsFor(tuning.switchMs) + 2, (_world, step) => ({ warlock: { carry: "frost", castPressed: step === 0 } }));
    expect(events.find((event) => event.type === "projectileSpawned")).toMatchObject({ projectile: { element: "frost" } });
  });

  it("fires a cast pressed under the cloak as soon as the cloak is released", () => {
    const cloaked = run(carrying("frost"), stepsFor(1500), (_world, step) => ({ warlock: { cloakHeld: true, castPressed: step === 5 } }));
    expect(count(cloaked.events, "projectileSpawned")).toBe(0);
    const released = run(cloaked.world, 1);
    expect(count(released.events, "cloakDropped")).toBe(1);
    expect(count(released.events, "projectileSpawned")).toBe(1);
  });

  it("dashes when a press lands just before the dash cooldown ends", () => {
    const cooling = withCaster(createWorld(), "warlock", { dashCooldownMs: buffer.dashMs / 2 });
    const { events } = run(cooling, stepsFor(buffer.dashMs), (_world, step) => ({ warlock: { move: vector(1, 0), dashPressed: step === 0 } }));
    expect(count(events, "dashed")).toBe(1);
  });

  it("keeps the cloak up through a dash", () => {
    const raised = run(carrying("fire"), stepsFor(cloak.windUpMs) + 1, () => ({ warlock: { cloakHeld: true } }));
    expect(raised.world.casters.warlock.cloak.phase).toBe("up");
    const dashed = run(raised.world, stepsFor(tuning.dash.durationMs), (_world, step) => ({ warlock: { cloakHeld: true, move: vector(1, 0), dashPressed: step === 0 } }));
    expect(count(dashed.events, "dashed")).toBe(1);
    expect(count(dashed.events, "cloakDropped")).toBe(0);
    expect(dashed.world.casters.warlock.cloak.phase).toBe("up");
  });

  it("cancels an earth charge with a dash, spending the cast", () => {
    const charging = run(carrying("earth"), 3, (_world, step) => ({ warlock: { castHeld: step === 0 } }));
    expect(charging.world.casters.warlock.charge).not.toBeNull();
    const escaped = run(charging.world, stepsFor(700), (_world, step) => ({ warlock: { move: vector(1, 0), dashPressed: step === 0 } }));
    expect(count(escaped.events, "earthCancelled")).toBe(1);
    expect(count(escaped.events, "dashed")).toBe(1);
    expect(count(escaped.events, "earthStrike")).toBe(0);
    expect(escaped.world.casters.warlock.cooldownsMs.earth).toBeGreaterThan(0);
  });
});

describe("rounds", () => {
  it("ends the round on death, then resets both mages after the delay", () => {
    const nearlyDead = withCaster(createWorld(), "demon", { health: 1 });
    const killed = run(nearlyDead, tuning.stepHz * 2, castOnce());
    expect(killed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["casterDied", "roundEnded"]));
    expect(killed.world.round).toMatchObject({ phase: "ended", winner: "warlock", wins: { warlock: 1, demon: 0 } });

    const reset = run(killed.world, stepsFor(tuning.roundResetDelayMs) + 1);
    expect(reset.world.round).toMatchObject({ number: 2, phase: "fighting", wins: { warlock: 1, demon: 0 } });
    expect(reset.world.casters.demon).toMatchObject({ alive: true, health: maxHealth, carried: "fire" });
    expect(reset.world.projectiles).toEqual([]);
  });

  it("ignores input while the round is over", () => {
    const start = createWorld();
    const ended: World = { ...start, round: { ...start.round, phase: "ended", winner: "demon" } };
    const { world } = run(ended, 10, () => ({ warlock: { move: vector(1, 0), castHeld: true } }));
    expect(world.casters.warlock.position).toEqual(start.casters.warlock.position);
    expect(world.projectiles).toEqual([]);
  });

  it("is deterministic", () => {
    const script: InputScript = (_world, step) => ({
      warlock: { move: vector(Math.sin(step / 7), 0), castHeld: step % 40 < 20, aimPoint: zeroVector, carry: elements[Math.floor(step / 60) % elements.length]!, cloakHeld: step % 90 > 60 },
    });
    expect(run(createWorld(), 480, script).world).toEqual(run(createWorld(), 480, script).world);
  });
});
