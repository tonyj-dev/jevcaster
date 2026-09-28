import { cloakBlocks, dropCloak, type SpikeRequest } from "./caster.ts";
import type { Caster, CasterId, Element, HitKind, Projectile, SimEvent, SimTuning } from "./types.ts";
import { beats, opponentOf } from "./types.ts";
import { add, distance, dot, length, normalize, scale, subtract } from "./vector.ts";

type Casters = Readonly<Record<CasterId, Caster>>;

export function applyDamage(caster: Caster, damage: number): Caster {
  if (!caster.alive) return caster;
  const health = Math.max(0, caster.health - damage);
  return { ...caster, health, alive: health > 0 };
}

// The target carries the element this attack beats.
export const isCountered = (target: Caster, element: Element): boolean => beats[element] === target.carried;

export type ElementalHit = { caster: Caster; damage: number; blocked: boolean };

// A fully raised cloak blocks `blockFraction` of the element it guards.
export function applyElementalDamage(target: Caster, element: Element, amount: number, tuning: SimTuning): ElementalHit {
  if (!cloakBlocks(target, element)) return { caster: applyDamage(target, amount), damage: amount, blocked: false };
  const damage = amount * (1 - tuning.cloak.blockFraction);
  return { caster: applyDamage(target, damage), damage, blocked: true };
}

// A direct attack: the counter bonus applies, then the cloak, and a hit event is emitted.
function strike(target: Caster, sourceId: CasterId, element: Element, kind: HitKind, baseDamage: number, tuning: SimTuning, events: SimEvent[]): ElementalHit {
  const countered = isCountered(target, element);
  const hit = applyElementalDamage(target, element, countered ? baseDamage * tuning.counterDamageMultiplier : baseDamage, tuning);
  events.push({ type: "hit", casterId: target.id, sourceId, element, kind, damage: hit.damage, blocked: hit.blocked, countered, position: target.position });
  return hit;
}

// A frost hit freezes. A frost cloak stops it.
function applyFrostEffects(target: Caster, blocked: boolean, tuning: SimTuning, events: SimEvent[]): Caster {
  if (blocked || !target.alive) return target;
  events.push({ type: "frozen", casterId: target.id });
  return dropCloak({ ...target, freezeRemainingMs: tuning.spells.frost.freezeMs, charge: null }, events);
}

export type ProjectileStep = {
  casters: Casters;
  projectiles: readonly Projectile[];
  events: SimEvent[];
};

export function stepProjectiles(casters: Casters, projectiles: readonly Projectile[], deltaSeconds: number, tuning: SimTuning, damageEnabled: boolean): ProjectileStep {
  let currentCasters = casters;
  const events: SimEvent[] = [];
  const survivors: Projectile[] = [];

  for (const projectile of projectiles) {
    const spell = tuning.spells[projectile.element];
    const position = add(projectile.position, scale(projectile.velocity, deltaSeconds));
    const remainingDistance = projectile.remainingDistance - spell.speed * deltaSeconds;
    const opponent = currentCasters[opponentOf(projectile.ownerId)];
    const directHit = opponent.alive && distance(opponent.position, position) <= tuning.caster.radius + spell.radius;

    if (!directHit && remainingDistance > 0) {
      survivors.push({ ...projectile, position, remainingDistance });
      continue;
    }

    if (projectile.element === "frost") {
      if (!directHit) {
        events.push({ type: "projectileFaded", projectileId: projectile.id, element: "frost", position });
        continue;
      }
      events.push({ type: "exploded", projectileId: projectile.id, ownerId: projectile.ownerId, element: "frost", position });
      if (!damageEnabled) continue;
      const hit = strike(opponent, projectile.ownerId, "frost", "direct", tuning.spells.frost.damage, tuning, events);
      currentCasters = { ...currentCasters, [opponent.id]: applyFrostEffects(hit.caster, hit.blocked, tuning, events) };
      continue;
    }

    const burstPoint = directHit ? position : projectile.detonationPoint;
    events.push({ type: "exploded", projectileId: projectile.id, ownerId: projectile.ownerId, element: projectile.element, position: burstPoint });
    if (!damageEnabled) continue;
    const fire = tuning.spells.fire;
    const inSplash = distance(opponent.position, burstPoint) <= fire.splashRadius + tuning.caster.radius;
    if (!opponent.alive || (!directHit && !inSplash)) continue;
    const kind: HitKind = directHit ? "direct" : "splash";
    const hit = strike(opponent, projectile.ownerId, "fire", kind, directHit ? fire.directDamage : fire.splashDamage, tuning, events);
    const burned = hit.blocked ? hit.caster : { ...hit.caster, burnRemainingMs: fire.burnDurationMs };
    currentCasters = { ...currentCasters, [opponent.id]: burned };
  }
  return { casters: currentCasters, projectiles: survivors, events };
}

// Spikes erupt instantly along the locked direction; they hit the opponent if it is close enough to the line.
export function resolveSpikes(casters: Casters, spikeLines: readonly SpikeRequest[], tuning: SimTuning, damageEnabled: boolean) {
  const earth = tuning.spells.earth;
  let currentCasters = casters;
  const events: SimEvent[] = [];
  for (const spikeLine of spikeLines) {
    const target = currentCasters[opponentOf(spikeLine.casterId)];
    const toTarget = subtract(target.position, spikeLine.from);
    const along = dot(toTarget, spikeLine.direction);
    const offLine = length(subtract(toTarget, scale(spikeLine.direction, along)));
    const connects = target.alive && along >= 0 && along <= earth.range && offLine <= tuning.caster.radius + earth.hitRadius;
    const endPoint = add(spikeLine.from, scale(spikeLine.direction, connects ? along : earth.range));
    events.push({ type: "earthStrike", casterId: spikeLine.casterId, from: spikeLine.from, to: endPoint, hitCasterId: connects ? target.id : null });
    if (!connects || !damageEnabled) continue;
    const hit = strike(target, spikeLine.casterId, "earth", "spikes", earth.damage, tuning, events);
    currentCasters = { ...currentCasters, [target.id]: hit.caster };
  }
  return { casters: currentCasters, events };
}

// Burn ticks are fire damage without the counter bonus; a fire cloak still blocks them.
export function stepBurn(caster: Caster, deltaSeconds: number, tuning: SimTuning): Caster {
  if (caster.burnRemainingMs <= 0 || !caster.alive) return caster;
  const burning = applyElementalDamage(caster, "fire", tuning.spells.fire.burnDamagePerSecond * deltaSeconds, tuning).caster;
  return { ...burning, burnRemainingMs: Math.max(0, caster.burnRemainingMs - deltaSeconds * 1000) };
}

// Keeps the two mages from standing inside each other.
export function separateCasters(casters: Casters, tuning: SimTuning): Casters {
  const { warlock, demon } = casters;
  const minimumGap = tuning.caster.radius * 2;
  const gap = distance(warlock.position, demon.position);
  if (gap >= minimumGap || gap < 1e-6) return casters;
  const push = scale(normalize(subtract(warlock.position, demon.position)), (minimumGap - gap) / 2);
  return {
    warlock: { ...warlock, position: add(warlock.position, push) },
    demon: { ...demon, position: add(demon.position, scale(push, -1)) },
  };
}
