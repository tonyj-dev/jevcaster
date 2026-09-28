import type { Caster, Projectile, SimEvent, World } from "../sim/types.ts";
import { opponentOf } from "../sim/types.ts";

// Swaps who is who (not where anything is), so a brain written for the demon can drive the warlock's mage.
// In the mirrored world the warlock's mage is "demon" and the demon's mage is "warlock"; positions,
// directions and aim points are untouched, so the input a brain returns applies to the real warlock as is.

const swap = opponentOf;

const mirrorCaster = (caster: Caster): Caster => ({ ...caster, id: swap(caster.id) });
const mirrorProjectile = (projectile: Projectile): Projectile => ({ ...projectile, ownerId: swap(projectile.ownerId) });

export function mirrorWorld(world: World): World {
  const { round } = world;
  return {
    ...world,
    casters: { warlock: mirrorCaster(world.casters.demon), demon: mirrorCaster(world.casters.warlock) },
    projectiles: world.projectiles.map(mirrorProjectile),
    round: { ...round, wins: { warlock: round.wins.demon, demon: round.wins.warlock }, winner: round.winner === null ? null : swap(round.winner) },
  };
}

export function mirrorEvent(event: SimEvent): SimEvent {
  switch (event.type) {
    case "projectileSpawned":
      return { ...event, projectile: mirrorProjectile(event.projectile) };
    case "exploded":
      return { ...event, ownerId: swap(event.ownerId) };
    case "earthStrike":
      return { ...event, casterId: swap(event.casterId), hitCasterId: event.hitCasterId === null ? null : swap(event.hitCasterId) };
    case "hit":
      return { ...event, casterId: swap(event.casterId), sourceId: swap(event.sourceId) };
    case "roundEnded":
      return { ...event, winner: swap(event.winner) };
    case "projectileFaded":
    case "roundStarted":
      return event;
    default:
      return { ...event, casterId: swap(event.casterId) };
  }
}

export const mirrorEvents = (events: readonly SimEvent[]): SimEvent[] => events.map(mirrorEvent);
