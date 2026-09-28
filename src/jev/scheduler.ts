import { config } from "../config.ts";
import type { BrainErrorKind } from "./protocol.ts";

// When to send the next duel tick. Pure: the caller passes the clock in and keeps the state.

export type SchedulerTuning = {
  readonly baseIntervalMs: number;
  readonly slowIntervalMs: number;
  readonly slowLatencyMs: number;
  readonly healthyStreakToSpeedUp: number;
  readonly maxInFlight: number;
  readonly failuresBeforeBackoff: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly offlineRetryMs: number;
};

export function schedulerTuning(brain = config.brain): SchedulerTuning {
  return {
    baseIntervalMs: brain.duelTick.baseIntervalMs,
    slowIntervalMs: brain.duelTick.slowIntervalMs,
    slowLatencyMs: brain.duelTick.slowLatencyMs,
    healthyStreakToSpeedUp: brain.duelTick.healthyStreakToSpeedUp,
    maxInFlight: brain.maxInFlightRequests,
    failuresBeforeBackoff: brain.backoff.failuresBeforeBackoff,
    backoffBaseMs: brain.backoff.baseMs,
    backoffMaxMs: brain.backoff.maxMs,
    offlineRetryMs: brain.backoff.offlineRetryMs,
  };
}

export type SchedulerState = {
  readonly slow: boolean;
  readonly lastSentAtMs: number;
  readonly inFlight: number;
  readonly pausedUntilMs: number;
  readonly pauseReason: BrainErrorKind | null;
  readonly consecutiveFailures: number;
  readonly healthyStreak: number;
};

export const initialScheduler: SchedulerState = {
  slow: false,
  lastSentAtMs: Number.NEGATIVE_INFINITY,
  inFlight: 0,
  pausedUntilMs: 0,
  pauseReason: null,
  consecutiveFailures: 0,
  healthyStreak: 0,
};

export type RequestOutcome = { readonly ok: true; readonly latencyMs: number } | { readonly ok: false; readonly error: BrainErrorKind; readonly retryAfterMs?: number };

export const currentIntervalMs = (state: SchedulerState, tuning: SchedulerTuning): number => (state.slow ? tuning.slowIntervalMs : tuning.baseIntervalMs);

export const isPaused = (state: SchedulerState, nowMs: number): boolean => nowMs < state.pausedUntilMs;

export function canSend(state: SchedulerState, nowMs: number, tuning: SchedulerTuning): boolean {
  return !isPaused(state, nowMs) && state.inFlight < tuning.maxInFlight && nowMs - state.lastSentAtMs >= currentIntervalMs(state, tuning);
}

export function markSent(state: SchedulerState, nowMs: number): SchedulerState {
  return { ...state, lastSentAtMs: nowMs, inFlight: state.inFlight + 1 };
}

// Tolerates a couple of failures in a row, then pauses for a doubling stretch.
function backoffMs(consecutiveFailures: number, tuning: SchedulerTuning): number {
  const beyond = consecutiveFailures - tuning.failuresBeforeBackoff;
  if (beyond < 0) return 0;
  return Math.min(tuning.backoffMaxMs, tuning.backoffBaseMs * 2 ** beyond);
}

export function markSettled(state: SchedulerState, nowMs: number, outcome: RequestOutcome, tuning: SchedulerTuning): SchedulerState {
  const settled = { ...state, inFlight: Math.max(0, state.inFlight - 1) };
  if (outcome.ok) {
    if (outcome.latencyMs > tuning.slowLatencyMs) return { ...settled, slow: true, healthyStreak: 0, consecutiveFailures: 0 };
    const healthyStreak = settled.healthyStreak + 1;
    const recovered = healthyStreak >= tuning.healthyStreakToSpeedUp;
    return { ...settled, slow: settled.slow && !recovered, healthyStreak: recovered ? 0 : healthyStreak, consecutiveFailures: 0 };
  }

  const pauseFor = (durationMs: number): SchedulerState => ({
    ...settled,
    pausedUntilMs: Math.max(settled.pausedUntilMs, nowMs + durationMs),
    pauseReason: outcome.error,
  });
  switch (outcome.error) {
    case "aborted":
      return settled;
    case "no_api_key":
      return pauseFor(tuning.offlineRetryMs);
    case "budget_exceeded":
      return pauseFor(outcome.retryAfterMs ?? 60_000);
    case "rate_limited":
    case "overloaded": {
      const consecutiveFailures = settled.consecutiveFailures + 1;
      const waitMs = Math.max(outcome.retryAfterMs ?? 0, backoffMs(consecutiveFailures, tuning), tuning.backoffBaseMs);
      return { ...pauseFor(Math.min(waitMs, 60_000)), slow: true, healthyStreak: 0, consecutiveFailures };
    }
    case "timeout": {
      const consecutiveFailures = settled.consecutiveFailures + 1;
      return { ...pauseFor(backoffMs(consecutiveFailures, tuning)), slow: true, healthyStreak: 0, consecutiveFailures };
    }
    case "bad_request":
    case "upstream": {
      const consecutiveFailures = settled.consecutiveFailures + 1;
      return { ...pauseFor(backoffMs(consecutiveFailures, tuning)), healthyStreak: 0, consecutiveFailures };
    }
  }
}
