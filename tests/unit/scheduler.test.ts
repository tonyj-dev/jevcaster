import { describe, expect, it } from "vitest";
import { canSend, currentIntervalMs, initialScheduler, isPaused, markSent, markSettled, schedulerTuning, type RequestOutcome, type SchedulerState } from "../../src/jev/scheduler.ts";

const tuning = { ...schedulerTuning(), baseIntervalMs: 200, slowIntervalMs: 400, slowLatencyMs: 350, healthyStreakToSpeedUp: 3, maxInFlight: 2, failuresBeforeBackoff: 2, backoffBaseMs: 500, backoffMaxMs: 4000, offlineRetryMs: 30_000 };
const healthy: RequestOutcome = { ok: true, latencyMs: 150 };

// Drives the scheduler with a fake clock: at each millisecond step it sends when allowed, and every
// request settles `latencyMs` later with the given outcome.
function simulate(durationMs: number, latencyMs: number, outcome: (index: number) => RequestOutcome = () => healthy) {
  let state: SchedulerState = initialScheduler;
  const sentAt: number[] = [];
  let pending: { settlesAt: number; index: number }[] = [];
  for (let nowMs = 0; nowMs <= durationMs; nowMs += 1) {
    for (const request of pending.filter((request) => request.settlesAt === nowMs)) {
      const result = outcome(request.index);
      state = markSettled(state, nowMs, result.ok ? { ok: true, latencyMs } : result, tuning);
    }
    pending = pending.filter((request) => request.settlesAt > nowMs);
    if (canSend(state, nowMs, tuning)) {
      state = markSent(state, nowMs);
      pending.push({ settlesAt: nowMs + latencyMs, index: sentAt.length });
      sentAt.push(nowMs);
    }
  }
  return { state, sentAt };
}

describe("duel tick scheduler", () => {
  it("ticks every 200 ms while answers come back quickly", () => {
    const { sentAt, state } = simulate(1000, 150);
    expect(sentAt).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(state.slow).toBe(false);
  });

  it("never has more than two requests in flight", () => {
    const { sentAt } = simulate(2000, 900);
    // Two go out 200 ms apart; then each new one waits for a slot, at the slowed 400 ms pace.
    expect(sentAt.slice(0, 4)).toEqual([0, 200, 900, 1300]);
  });

  it("slows to 400 ms after a slow answer and speeds back up after a healthy streak", () => {
    let state = markSettled(markSent(initialScheduler, 0), 500, { ok: true, latencyMs: 500 }, tuning);
    expect(currentIntervalMs(state, tuning)).toBe(400);
    for (let index = 0; index < tuning.healthyStreakToSpeedUp - 1; index += 1) state = markSettled(markSent(state, 0), 0, healthy, tuning);
    expect(state.slow).toBe(true);
    state = markSettled(markSent(state, 0), 0, healthy, tuning);
    expect(currentIntervalMs(state, tuning)).toBe(200);
  });

  it("tolerates a couple of failures, then backs off with a doubling pause", () => {
    const fail = (state: SchedulerState, nowMs: number) => markSettled(markSent(state, nowMs), nowMs, { ok: false, error: "upstream" }, tuning);
    let state = fail(initialScheduler, 0);
    expect(isPaused(state, 1)).toBe(false);
    state = fail(state, 100);
    expect(state.pausedUntilMs).toBe(100 + 500);
    state = fail(state, 700);
    expect(state.pausedUntilMs).toBe(700 + 1000);
    for (let failure = 0; failure < 5; failure += 1) state = fail(state, 2000);
    expect(state.pausedUntilMs).toBe(2000 + tuning.backoffMaxMs);
    expect(markSettled(markSent(state, 9000), 9000, healthy, tuning).consecutiveFailures).toBe(0);
  });

  it("honours retryAfterMs on rate limits and slows the tick", () => {
    const state = markSettled(markSent(initialScheduler, 0), 10, { ok: false, error: "rate_limited", retryAfterMs: 2500 }, tuning);
    expect(state.pausedUntilMs).toBe(2510);
    expect(state.pauseReason).toBe("rate_limited");
    expect(state.slow).toBe(true);
    expect(canSend(state, 2509, tuning)).toBe(false);
    expect(canSend(state, 2510, tuning)).toBe(true);
    const overloaded = markSettled(markSent(initialScheduler, 0), 0, { ok: false, error: "overloaded" }, tuning);
    expect(overloaded.pausedUntilMs).toBeGreaterThanOrEqual(tuning.backoffBaseMs);
  });

  it("pauses for a long while without an API key or once the token budget is spent", () => {
    const offline = markSettled(markSent(initialScheduler, 0), 0, { ok: false, error: "no_api_key" }, tuning);
    expect(offline.pausedUntilMs).toBe(tuning.offlineRetryMs);
    const broke = markSettled(markSent(initialScheduler, 0), 0, { ok: false, error: "budget_exceeded", retryAfterMs: 60_000 }, tuning);
    expect(broke.pausedUntilMs).toBe(60_000);
  });

  it("just frees the slot when a request is aborted", () => {
    const state = markSettled(markSent(initialScheduler, 0), 5, { ok: false, error: "aborted" }, tuning);
    expect(state).toEqual({ ...initialScheduler, lastSentAtMs: 0 });
  });
});
