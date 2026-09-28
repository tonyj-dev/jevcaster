import { config } from "../../config.ts";
import { aimDirection } from "../../sim/caster.ts";
import type { Caster, SimTuning } from "../../sim/types.ts";
import { add, dot, length, normalize, perpendicular, scale, subtract, vector, type Vector2 } from "../../sim/vector.ts";
import type { DescribeTuning } from "./buckets.ts";

export type Side = "left" | "right";

// A mage's own view of the duel: forward points at the opponent, left is its left hand.
export type FacingFrame = { readonly forward: Vector2; readonly left: Vector2 };

export function facingFrame(self: Caster, opponent: Caster): FacingFrame {
  const toOpponent = normalize(subtract(opponent.position, self.position));
  const forward = length(toOpponent) > 0 ? toOpponent : vector(0, self.id === "warlock" ? -1 : 1);
  return { forward, left: perpendicular(forward) };
}

export const sideDirection = (frame: FacingFrame, side: Side): Vector2 => (side === "left" ? frame.left : scale(frame.left, -1));

export const sideOf = (frame: FacingFrame, direction: Vector2): Side => (dot(direction, frame.left) >= 0 ? "left" : "right");

// Open when a full dash that way would still land inside the arena with some room to spare.
export function isSideOpen(self: Caster, frame: FacingFrame, side: Side, simTuning: SimTuning = config.sim, tuning: DescribeTuning = config.brain.describe): boolean {
  const landing = add(self.position, scale(sideDirection(frame, side), simTuning.dash.distance));
  return length(landing) <= simTuning.arenaRadius - simTuning.caster.radius - tuning.openSideMargin;
}

export function angleBetweenDegrees(first: Vector2, second: Vector2): number {
  const magnitudes = length(first) * length(second);
  if (magnitudes < 1e-9) return 180;
  const cosine = Math.min(1, Math.max(-1, dot(first, second) / magnitudes));
  return (Math.acos(cosine) * 180) / Math.PI;
}

// How far off target a mage is aiming, in degrees.
export const aimOffsetDegrees = (caster: Caster, target: Caster): number => angleBetweenDegrees(aimDirection(caster), subtract(target.position, caster.position));
