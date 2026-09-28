import { config } from "../../config.ts";

// Every number Jev would otherwise have to compare becomes a word here. One table per quantity.
export type DescribeTuning = typeof config.brain.describe;

export type DistanceBucket = "close" | "mid" | "far";
export type ArrivalBucket = "imminent" | "in about half a second" | "later";
export type HealthBucket = "healthy" | "hurt" | "critical";
export type AimBucket = "straight at" | "near" | "away from";
export type PositionBucket = "centre" | "mid-ring" | "near the edge";

export function distanceBucket(meters: number, tuning: DescribeTuning = config.brain.describe): DistanceBucket {
  if (meters < tuning.closeDistance) return "close";
  if (meters <= tuning.farDistance) return "mid";
  return "far";
}

export function arrivalBucket(seconds: number, tuning: DescribeTuning = config.brain.describe): ArrivalBucket {
  if (seconds < tuning.imminentSeconds) return "imminent";
  if (seconds < tuning.soonSeconds) return "in about half a second";
  return "later";
}

export function healthBucket(health: number, maxHealth: number, tuning: DescribeTuning = config.brain.describe): HealthBucket {
  const fraction = health / maxHealth;
  if (fraction > tuning.healthyFraction) return "healthy";
  if (fraction > tuning.criticalFraction) return "hurt";
  return "critical";
}

export function positionBucket(metersFromCentre: number, arenaRadius: number, tuning: DescribeTuning = config.brain.describe): PositionBucket {
  const fraction = metersFromCentre / arenaRadius;
  if (fraction < tuning.centreFraction) return "centre";
  if (fraction <= tuning.edgeFraction) return "mid-ring";
  return "near the edge";
}

export function aimBucket(offsetDegrees: number, tuning: DescribeTuning = config.brain.describe): AimBucket {
  const offset = Math.abs(offsetDegrees);
  if (offset <= tuning.straightAimDegrees) return "straight at";
  if (offset <= tuning.nearAimDegrees) return "near";
  return "away from";
}
