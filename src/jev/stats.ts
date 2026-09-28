import { config } from "../config.ts";
import type { DemonDecision, StaleReason } from "./decide.ts";
import type { RecentActions } from "./describe/recent.ts";
import type { BrainErrorKind, BrainRequest, BrainResponse } from "./protocol.ts";

// Bookkeeping for the brain inspector (F2): latency, spend, and what happened to each answer. Nothing here steers the demon.

export type StaleCounts = Record<StaleReason | "superseded", number>;

export type JevBrainSnapshot = {
  readonly intervalMs: number;
  readonly inFlight: number;
  readonly pausedReason: BrainErrorKind | null;
  readonly latencies: readonly number[];
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  readonly dollarsPerHour: number;
  readonly totalTokens: number;
  readonly totalDollars: number;
  readonly decisionsPerSecond: number;
  readonly applied: number;
  readonly stale: StaleCounts;
  readonly invalid: number;
  readonly failures: Readonly<Partial<Record<BrainErrorKind, number>>>;
  readonly lastError: string | null;
  readonly lastDecision: DemonDecision | null;
  readonly lastDecisionAgeMs: number | null;
  readonly lastRequest: BrainRequest | null;
  readonly lastResponse: BrainResponse | null;
  readonly recent: RecentActions;
};

// What the brain loop itself knows at snapshot time.
export type LoopState = Pick<JevBrainSnapshot, "intervalMs" | "inFlight" | "pausedReason" | "recent"> & { readonly worldTimeMs: number };

const oneMinuteMs = 60_000;
const decisionRateWindowMs = 5_000;

export function createJevStats() {
  let latencies: number[] = [];
  let sentTimesMs: number[] = [];
  let tokenLog: { atMs: number; tokens: number }[] = [];
  let appliedTimesMs: number[] = [];
  let totalTokens = 0;
  let applied = 0;
  let invalid = 0;
  const stale: StaleCounts = { round_changed: 0, demon_frozen: 0, too_old: 0, superseded: 0 };
  const failures: Partial<Record<BrainErrorKind, number>> = {};
  let lastError: string | null = null;
  let lastDecision: DemonDecision | null = null;
  let lastDecisionAtMs: number | null = null;
  let lastRequest: BrainRequest | null = null;
  let lastResponse: BrainResponse | null = null;

  const withinMinute = (nowMs: number) => (atMs: number) => nowMs - atMs <= oneMinuteMs;

  return {
    sent(request: BrainRequest, atMs: number): void {
      sentTimesMs = [...sentTimesMs.filter(withinMinute(atMs)), atMs];
      lastRequest = request;
    },

    settled(response: BrainResponse, atMs: number, roundTripMs: number): void {
      if (!response.ok) {
        if (response.error === "aborted") return;
        failures[response.error] = (failures[response.error] ?? 0) + 1;
        lastError = `${response.error}: ${response.message}`;
        lastResponse = response;
        return;
      }
      lastResponse = response;
      latencies = [...latencies, roundTripMs].slice(-config.brain.inspector.latencySamples);
      tokenLog = [...tokenLog.filter((entry) => withinMinute(atMs)(entry.atMs)), { atMs, tokens: response.usage.inputTokens }];
      totalTokens += response.usage.inputTokens;
    },

    stale(reason: StaleReason | "superseded"): void {
      stale[reason] += 1;
    },

    invalid(): void {
      invalid += 1;
    },

    applied(decision: DemonDecision, atMs: number, worldTimeMs: number): void {
      applied += 1;
      appliedTimesMs = [...appliedTimesMs.filter((appliedAtMs) => atMs - appliedAtMs <= decisionRateWindowMs), atMs];
      lastDecision = decision;
      lastDecisionAtMs = worldTimeMs;
    },

    snapshot(nowMs: number, loop: LoopState): JevBrainSnapshot {
      sentTimesMs = sentTimesMs.filter(withinMinute(nowMs));
      tokenLog = tokenLog.filter((entry) => withinMinute(nowMs)(entry.atMs));
      appliedTimesMs = appliedTimesMs.filter((atMs) => nowMs - atMs <= decisionRateWindowMs);
      // Rates over the time actually observed, up to a minute, so they read sensibly from the first seconds.
      const firstSentMs = sentTimesMs[0];
      const windowMs = firstSentMs === undefined ? oneMinuteMs : Math.min(oneMinuteMs, Math.max(1000, nowMs - firstSentMs));
      const tokensInWindow = tokenLog.reduce((sum, entry) => sum + entry.tokens, 0);
      const tokensPerMinute = (tokensInWindow / windowMs) * oneMinuteMs;
      const summary = summarizeLatencies(latencies);
      const pricePerToken = config.brain.dollarsPerMillionInputTokens / 1_000_000;
      const { worldTimeMs, ...loopFields } = loop;
      return {
        ...loopFields,
        latencies,
        latencyP50Ms: summary.p50Ms,
        latencyP95Ms: summary.p95Ms,
        requestsPerMinute: (sentTimesMs.length / windowMs) * oneMinuteMs,
        tokensPerMinute,
        dollarsPerHour: tokensPerMinute * 60 * pricePerToken,
        totalTokens,
        totalDollars: totalTokens * pricePerToken,
        decisionsPerSecond: appliedTimesMs.length / (decisionRateWindowMs / 1000),
        applied,
        stale: { ...stale },
        invalid,
        failures: { ...failures },
        lastError,
        lastDecision,
        lastDecisionAgeMs: lastDecisionAtMs === null ? null : worldTimeMs - lastDecisionAtMs,
        lastRequest,
        lastResponse,
      };
    },
  };
}

// ---- Latency percentiles (also used by scripts/brainProbe.ts) ----

export type LatencySummary = {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
};

// Nearest-rank percentile; fraction in [0, 1].
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? Number.NaN;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: values.length ? Math.min(...values) : Number.NaN,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : Number.NaN,
    meanMs: values.length ? total / values.length : Number.NaN,
  };
}
