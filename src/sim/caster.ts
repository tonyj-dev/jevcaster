import type { Caster, CasterId, CasterInput, Cloak, Element, Projectile, ProjectileElement, SimEvent, SimTuning } from "./types.ts";
import { add, clampLength, length, normalize, scale, subtract, vector, zeroVector, type Vector2 } from "./vector.ts";

export const idleInput = (aimPoint: Vector2): CasterInput => ({
  move: zeroVector,
  aimPoint,
  castHeld: false,
  castPressed: false,
  cloakHeld: false,
  dashPressed: false,
  carry: null,
});

const noCloak: Cloak = { phase: "none", guards: "earth", elapsedMs: 0 };
const readyCooldowns: Record<Element, number> = { fire: 0, frost: 0, earth: 0 };

export function spawnPosition(casterId: CasterId, tuning: SimTuning): Vector2 {
  // The warlock starts nearer the camera (positive z), the demon across the arena.
  return vector(0, casterId === "warlock" ? tuning.spawnDistanceFromCenter : -tuning.spawnDistanceFromCenter);
}

export function createCaster(casterId: CasterId, tuning: SimTuning): Caster {
  return {
    id: casterId,
    position: spawnPosition(casterId, tuning),
    velocity: zeroVector,
    aimPoint: spawnPosition(casterId === "warlock" ? "demon" : "warlock", tuning),
    health: tuning.caster.maxHealth,
    alive: true,
    carried: "fire",
    switchRemainingMs: 0,
    recoveryRemainingMs: 0,
    cooldownsMs: readyCooldowns,
    dashCooldownMs: 0,
    dashRemainingMs: 0,
    dashDirection: zeroVector,
    cloak: noCloak,
    charge: null,
    burnRemainingMs: 0,
    freezeRemainingMs: 0,
    bufferedCastMs: 0,
    bufferedDashMs: 0,
  };
}

export function clampToArena(position: Vector2, tuning: SimTuning): Vector2 {
  return clampLength(position, tuning.arenaRadius - tuning.caster.radius);
}

export function aimDirection(caster: Caster): Vector2 {
  const direction = normalize(subtract(caster.aimPoint, caster.position));
  return length(direction) > 0 ? direction : vector(0, caster.id === "warlock" ? -1 : 1);
}

export const isFrozen = (caster: Caster): boolean => caster.freezeRemainingMs > 0;
export const isCloaking = (caster: Caster): boolean => caster.cloak.phase !== "none";
export const cloakBlocks = (caster: Caster, element: Element): boolean => caster.cloak.phase === "up" && caster.cloak.guards === element;

// Its own cooldown is over, ignoring whether it is carried and the shared cast recovery.
export const isOffCooldown = (caster: Caster, element: Element): boolean => caster.cooldownsMs[element] === 0;

// Castable as soon as it is carried and settled.
export const canCastSoon = (caster: Caster, element: Element): boolean => caster.recoveryRemainingMs === 0 && isOffCooldown(caster, element);

export type SpikeRequest = { readonly casterId: CasterId; readonly from: Vector2; readonly direction: Vector2 };
export type CasterStep = { caster: Caster; spawned: Projectile | null; spikeLine: SpikeRequest | null; events: SimEvent[] };

function tickTimers(caster: Caster, deltaMs: number, events: SimEvent[]): Caster {
  const countDown = (value: number) => Math.max(0, value - deltaMs);
  const freezeRemainingMs = countDown(caster.freezeRemainingMs);
  if (caster.freezeRemainingMs > 0 && freezeRemainingMs === 0) events.push({ type: "thawed", casterId: caster.id });
  return {
    ...caster,
    switchRemainingMs: countDown(caster.switchRemainingMs),
    recoveryRemainingMs: countDown(caster.recoveryRemainingMs),
    cooldownsMs: {
      fire: countDown(caster.cooldownsMs.fire),
      frost: countDown(caster.cooldownsMs.frost),
      earth: countDown(caster.cooldownsMs.earth),
    },
    dashCooldownMs: countDown(caster.dashCooldownMs),
    freezeRemainingMs,
  };
}

export function dropCloak(caster: Caster, events: SimEvent[]): Caster {
  if (!isCloaking(caster)) return caster;
  events.push({ type: "cloakDropped", casterId: caster.id, guards: caster.cloak.guards });
  return { ...caster, cloak: noCloak };
}

// The cloak takes the carried spell's form and, once fully up, blocks attacks of that same element.
// It never stops the other two, so the attack that counters the carried spell always gets through.
// It costs nothing and can be held for as long as the button is.
function stepCloak(caster: Caster, wantsCloak: boolean, deltaMs: number, tuning: SimTuning, events: SimEvent[]): Caster {
  if (caster.cloak.phase === "none") {
    if (!wantsCloak) return caster;
    const guards = caster.carried;
    events.push({ type: "cloakRaising", casterId: caster.id, guards });
    return { ...caster, cloak: { phase: "raising", guards, elapsedMs: 0 } };
  }
  if (!wantsCloak) return dropCloak(caster, events);

  const elapsedMs = caster.cloak.elapsedMs + deltaMs;
  const phase = elapsedMs >= tuning.cloak.windUpMs ? "up" : "raising";
  if (phase === "up" && caster.cloak.phase === "raising") events.push({ type: "cloakRaised", casterId: caster.id, guards: caster.cloak.guards });
  return { ...caster, cloak: { ...caster.cloak, phase, elapsedMs } };
}

export function movementSpeedFactor(caster: Caster, tuning: SimTuning): number {
  if (caster.charge) return 0;
  const cloaking = isCloaking(caster) ? tuning.cloak.moveFactor : 1;
  return cloaking * tuning.carryMoveFactor[caster.carried];
}

// Movement, dash, switching, the cloak, the earth charge and casting for one mage.
// `entityId` is the id a spawned projectile would take; the caller advances the counter.
export function stepCaster(caster: Caster, input: CasterInput, deltaSeconds: number, tuning: SimTuning, entityId: number): CasterStep {
  const step = actOnInput(caster, input, deltaSeconds, tuning, entityId);
  return { ...step, caster: settleBuffers(caster, step, input, deltaSeconds * 1000, tuning) };
}

// A press fills its buffer; an unused buffer drains and reports when it runs out. A buffered cast
// doesn't drain while the cloak is held or a switch is settling, so it fires on release or once settled.
function settleBuffers(before: Caster, step: CasterStep, input: CasterInput, deltaMs: number, tuning: SimTuning): Caster {
  const after = step.caster;
  if (!after.alive) return { ...after, bufferedCastMs: 0, bufferedDashMs: 0 };
  const cast = step.events.some((event) => event.type === "projectileSpawned" || event.type === "earthCharging");
  const dashed = step.events.some((event) => event.type === "dashed");
  const drain = (ms: number) => Math.max(0, ms - deltaMs);
  const castWaits = input.cloakHeld || after.switchRemainingMs > 0;
  const bufferedCastMs = cast ? 0 : input.castPressed ? tuning.inputBuffer.castMs : castWaits ? before.bufferedCastMs : drain(before.bufferedCastMs);
  const bufferedDashMs = dashed ? 0 : input.dashPressed ? tuning.inputBuffer.dashMs : drain(before.bufferedDashMs);
  if (before.bufferedCastMs > 0 && bufferedCastMs === 0 && !cast) step.events.push({ type: "pressExpired", casterId: after.id, action: "cast" });
  if (before.bufferedDashMs > 0 && bufferedDashMs === 0 && !dashed) step.events.push({ type: "pressExpired", casterId: after.id, action: "dash" });
  return { ...after, bufferedCastMs, bufferedDashMs };
}

function actOnInput(caster: Caster, input: CasterInput, deltaSeconds: number, tuning: SimTuning, entityId: number): CasterStep {
  const deltaMs = deltaSeconds * 1000;
  const events: SimEvent[] = [];
  const timed = tickTimers({ ...caster, aimPoint: input.aimPoint }, deltaMs, events);
  if (!timed.alive) return { caster: { ...timed, velocity: zeroVector }, spawned: null, spikeLine: null, events };
  if (isFrozen(timed)) {
    const helpless = dropCloak({ ...timed, charge: null, velocity: zeroVector, dashRemainingMs: 0 }, events);
    return { caster: helpless, spawned: null, spikeLine: null, events };
  }

  const switching = input.carry !== null && input.carry !== timed.carried && !timed.charge;
  const switched: Caster = switching ? { ...timed, carried: input.carry!, switchRemainingMs: tuning.switchMs } : timed;
  if (switching) events.push({ type: "carryChanged", casterId: caster.id, from: timed.carried, to: switched.carried });

  const settled = switched.switchRemainingMs === 0;
  const wantsDash = input.dashPressed || caster.bufferedDashMs > 0;
  const startsDash = wantsDash && switched.dashCooldownMs === 0 && switched.dashRemainingMs === 0;
  // A dash out of an earth charge cancels it; the spell's cooldown and the recovery are already spent.
  if (startsDash && switched.charge) events.push({ type: "earthCancelled", casterId: caster.id });
  const unrooted: Caster = startsDash ? { ...switched, charge: null } : switched;
  // Holding the cloak wins over holding cast, whatever the spell cooldowns; charging earth drops it, dashing keeps it.
  // The switch time only delays casting: switching drops the cloak, which re-forms at once around the new spell.
  const wantsCloak = input.cloakHeld && !unrooted.charge;
  const cloaked = stepCloak(switching ? dropCloak(unrooted, events) : unrooted, wantsCloak, deltaMs, tuning, events);

  const moveIntent = clampLength(input.move, 1);
  const newDashDirection = length(moveIntent) > 0.1 ? normalize(moveIntent) : aimDirection(cloaked);
  const dashing: Caster = startsDash
    ? { ...cloaked, dashRemainingMs: tuning.dash.durationMs, dashCooldownMs: tuning.dash.cooldownMs, dashDirection: newDashDirection }
    : cloaked;
  if (startsDash) events.push({ type: "dashed", casterId: caster.id, from: caster.position, direction: newDashDirection });

  const dashSpeed = tuning.dash.distance / (tuning.dash.durationMs / 1000);
  const velocity =
    dashing.dashRemainingMs > 0 ? scale(dashing.dashDirection, dashSpeed) : scale(moveIntent, tuning.caster.moveSpeed * movementSpeedFactor(dashing, tuning));
  const moved: Caster = {
    ...dashing,
    velocity,
    position: clampToArena(add(dashing.position, scale(velocity, deltaSeconds)), tuning),
    dashRemainingMs: Math.max(0, dashing.dashRemainingMs - deltaMs),
  };

  // The earth spikes erupt along the direction locked in when the charge began.
  if (moved.charge) {
    const remainingMs = moved.charge.remainingMs - deltaMs;
    if (remainingMs > 0) return { caster: { ...moved, charge: { ...moved.charge, remainingMs } }, spawned: null, spikeLine: null, events };
    const spikeLine: SpikeRequest = { casterId: caster.id, from: moved.position, direction: moved.charge.direction };
    return { caster: { ...moved, charge: null }, spawned: null, spikeLine, events };
  }

  const carried = moved.carried;
  const wantsCast = input.castHeld || input.castPressed || caster.bufferedCastMs > 0;
  const casts = wantsCast && !input.cloakHeld && !isCloaking(moved) && settled && canCastSoon(moved, carried);
  if (!casts) return { caster: moved, spawned: null, spikeLine: null, events };

  const paid: Caster = {
    ...moved,
    cooldownsMs: { ...moved.cooldownsMs, [carried]: tuning.spells[carried].cooldownMs },
    recoveryRemainingMs: tuning.castRecoveryMs,
  };
  if (carried === "earth") {
    const direction = aimDirection(paid);
    events.push({ type: "earthCharging", casterId: caster.id, from: paid.position, direction });
    return { caster: { ...paid, charge: { remainingMs: tuning.spells.earth.chargeMs, direction } }, spawned: null, spikeLine: null, events };
  }
  const spawned = createProjectile(paid, carried, tuning, entityId);
  events.push({ type: "projectileSpawned", projectile: spawned });
  return { caster: paid, spawned, spikeLine: null, events };
}

function projectileRange(caster: Caster, element: ProjectileElement, tuning: SimTuning): number {
  if (element === "frost") return tuning.spells.frost.maxRange;
  const spell = tuning.spells[element];
  const requested = length(subtract(caster.aimPoint, caster.position));
  return Math.min(spell.maxRange, Math.max(spell.minRange, requested));
}

function createProjectile(caster: Caster, element: ProjectileElement, tuning: SimTuning, projectileId: number): Projectile {
  const spell = tuning.spells[element];
  const direction = aimDirection(caster);
  const range = projectileRange(caster, element, tuning);
  const muzzleOffset = tuning.caster.radius + spell.radius;
  return {
    id: projectileId,
    ownerId: caster.id,
    element,
    position: add(caster.position, scale(direction, muzzleOffset)),
    velocity: scale(direction, spell.speed),
    detonationPoint: add(caster.position, scale(direction, range)),
    remainingDistance: range - muzzleOffset,
  };
}
