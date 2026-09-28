import type { Caster, Element, SimTuning, World } from "./types.ts";
import { opponentOf } from "./types.ts";
import { add, distance, dot, length, normalize, scale, subtract, type Vector2 } from "./vector.ts";

// Predictions about spells in flight, shared by every brain and by the words Jev is shown.

export type Threat = {
  readonly key: string;
  readonly element: Element;
  readonly secondsToImpact: number;
  readonly travelDirection: Vector2;
};

// Opponent spells that will hit or splash `self` within the window, soonest first.
export function findThreats(world: World, self: Caster, windowSeconds: number, tuning: SimTuning): Threat[] {
  const projectileThreats = world.projectiles
    .filter((projectile) => projectile.ownerId !== self.id)
    .flatMap((projectile): Threat[] => {
      const spell = tuning.spells[projectile.element];
      const speed = length(projectile.velocity);
      const toSelf = subtract(self.position, projectile.position);
      const secondsToClosest = dot(toSelf, projectile.velocity) / (speed * speed);
      const secondsToEnd = projectile.remainingDistance / speed;
      const closestPoint = add(projectile.position, scale(projectile.velocity, Math.max(0, secondsToClosest)));
      const directHit = secondsToClosest > 0 && secondsToClosest <= secondsToEnd && distance(closestPoint, self.position) <= tuning.caster.radius + spell.radius;
      const areaRadius = projectile.element === "fire" ? tuning.spells.fire.splashRadius : 0;
      const areaHit = areaRadius > 0 && distance(projectile.detonationPoint, self.position) <= areaRadius + tuning.caster.radius;
      if (!directHit && !areaHit) return [];
      const secondsToImpact = directHit ? secondsToClosest : secondsToEnd;
      if (secondsToImpact > windowSeconds) return [];
      return [{ key: `projectile-${projectile.id}`, element: projectile.element, secondsToImpact, travelDirection: normalize(projectile.velocity) }];
    });

  const opponent = world.casters[opponentOf(self.id)];
  const charge = opponent.charge;
  const earthThreats: Threat[] = [];
  if (charge) {
    const toSelf = subtract(self.position, opponent.position);
    const along = dot(toSelf, charge.direction);
    const offLine = length(subtract(toSelf, scale(charge.direction, along)));
    const onLine = along >= 0 && along <= tuning.spells.earth.range && offLine <= tuning.caster.radius + tuning.spells.earth.hitRadius + 0.2;
    if (onLine && charge.remainingMs / 1000 <= windowSeconds) {
      earthThreats.push({ key: `earth-${opponent.id}`, element: "earth", secondsToImpact: charge.remainingMs / 1000, travelDirection: charge.direction });
    }
  }
  return [...projectileThreats, ...earthThreats].sort((left, right) => left.secondsToImpact - right.secondsToImpact);
}

// Leads a moving target by the time the spell takes to reach it.
export function aimPointFor(element: Element, self: Caster, target: Caster, tuning: SimTuning): Vector2 {
  const leadSeconds = element === "earth" ? tuning.spells.earth.chargeMs / 1000 : distance(self.position, target.position) / tuning.spells[element].speed;
  return add(target.position, scale(target.velocity, leadSeconds));
}
