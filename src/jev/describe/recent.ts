import type { Element, SimEvent } from "../../sim/types.ts";

// The opponent's last cast and dash, as a watchful human would remember them. Its timers are hidden,
// so this is how state.ts can say "just cast, so it can't cast again yet" or "just dashed, so it can't dash again yet".
export type RecentActions = {
  readonly lastCast: { readonly element: Element; readonly atMs: number } | null;
  readonly lastDashAtMs: number | null;
};

export const noRecentActions: RecentActions = { lastCast: null, lastDashAtMs: null };

// Folds one sim step's events into the record. `nowMs` is the world time after the step.
export function recordRecentActions(recent: RecentActions, nowMs: number, events: readonly SimEvent[]): RecentActions {
  let { lastCast, lastDashAtMs } = recent;
  for (const event of events) {
    if (event.type === "projectileSpawned" && event.projectile.ownerId === "warlock") lastCast = { element: event.projectile.element, atMs: nowMs };
    if (event.type === "earthCharging" && event.casterId === "warlock") lastCast = { element: "earth", atMs: nowMs };
    if (event.type === "dashed" && event.casterId === "warlock") lastDashAtMs = nowMs;
  }
  const unchanged = lastCast === recent.lastCast && lastDashAtMs === recent.lastDashAtMs;
  return unchanged ? recent : { lastCast, lastDashAtMs };
}
