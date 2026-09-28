// 2D vectors on the arena floor (x to the right, z toward the camera).
export type Vector2 = { readonly x: number; readonly z: number };

export const zeroVector: Vector2 = { x: 0, z: 0 };

export const vector = (x: number, z: number): Vector2 => ({ x, z });
export const add = (left: Vector2, right: Vector2): Vector2 => ({ x: left.x + right.x, z: left.z + right.z });
export const subtract = (left: Vector2, right: Vector2): Vector2 => ({ x: left.x - right.x, z: left.z - right.z });
export const scale = (value: Vector2, factor: number): Vector2 => ({ x: value.x * factor, z: value.z * factor });
export const dot = (left: Vector2, right: Vector2): number => left.x * right.x + left.z * right.z;
export const length = (value: Vector2): number => Math.hypot(value.x, value.z);
export const distance = (left: Vector2, right: Vector2): number => length(subtract(left, right));

export function normalize(value: Vector2): Vector2 {
  const magnitude = length(value);
  return magnitude > 1e-9 ? scale(value, 1 / magnitude) : zeroVector;
}

export function clampLength(value: Vector2, maxLength: number): Vector2 {
  const magnitude = length(value);
  return magnitude > maxLength ? scale(value, maxLength / magnitude) : value;
}

// Rotated 90° counter-clockwise when seen from above.
export const perpendicular = (value: Vector2): Vector2 => ({ x: value.z, z: -value.x });

export const lerpVector = (from: Vector2, to: Vector2, amount: number): Vector2 => ({
  x: from.x + (to.x - from.x) * amount,
  z: from.z + (to.z - from.z) * amount,
});
