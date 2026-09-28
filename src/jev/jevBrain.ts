import { config } from "../config.ts";
import { isFrozen } from "../sim/caster.ts";
import type { CasterInput, SimEvent, World } from "../sim/types.ts";
import { decideFromAnswers, staleReason, type RequestStamp } from "./decide.ts";
import { noRecentActions, recordRecentActions, type RecentActions } from "./describe/recent.ts";
import { adoptDecision, decisionInput, emptyExecutorMemory, observeDemonEvents } from "./execute.ts";
import type { BrainErrorKind, BrainRequest, BrainResponse, BrainSuccess } from "./protocol.ts";
import { buildTickRequest, type TickOptions } from "./questions.ts";
import { canSend, currentIntervalMs, initialScheduler, isPaused, markSent, markSettled, schedulerTuning } from "./scheduler.ts";
import { createJevStats, type JevBrainSnapshot } from "./stats.ts";

// Jev playing the demon. Called once per sim step (60 Hz); Jev is asked up to five times a second.
//
//   1. apply answers that arrived: drop stale ones, pick a decision (decide.ts), make it the active one (execute.ts)
//   2. when due, ask again: state (state.ts) + questions (questions.ts) → POST /api/brain → Jev
//   3. return the active decision as this step's input (execute.ts), or null so the heuristic fills in
//
// To keep the cost down, a tick whose request would be identical to the last one is skipped (Jev would give the same
// top pick) until the last one is heartbeatMs old. Any change to the state is asked about at the next tick.
//
// Requests are asynchronous and overlap, so the demon keeps acting on its last decision while the next is in flight.

// Sends a request to the brain proxy. Resolves with a failure instead of throwing.
export type BrainTransport = (request: BrainRequest, signal: AbortSignal) => Promise<BrainResponse>;

export type JevBrain = {
  // Folds the step's events into the opponent's recent actions and staleness markers. Call after every sim step, in every brain mode.
  observe(world: World, events: readonly SimEvent[]): void;
  // Applies answers that arrived, sends the next tick when due, and returns the demon's input,
  // or null when there is no fresh decision to follow (the caller falls back to the heuristic).
  input(world: World): CasterInput | null;
  // Stops sending and aborts requests in flight.
  cancel(): void;
  // Why Jev can't be reached right now ("out of mana"), or null while it answers. See outOfMana below.
  outOfMana(): BrainErrorKind | null;
  snapshot(world: World): JevBrainSnapshot;
};

export type JevBrainOptions = {
  transport: BrainTransport;
  now?: () => number;
};

// An answer back from Jev, with the question it answers (the options offered then) and when it was asked.
type SettledAnswer = {
  readonly stamp: RequestStamp;
  readonly options: TickOptions;
  readonly response: BrainSuccess;
};


export function createJevBrain(options: JevBrainOptions): JevBrain {
  const { transport } = options;
  const now = options.now ?? (() => performance.now());
  const tuning = () => schedulerTuning(config.brain);
  const stats = createJevStats();

  let scheduler = initialScheduler;
  let recent: RecentActions = noRecentActions;
  let executor = emptyExecutorMemory;
  let roundEpoch = 0;
  let lastDemonFrozenTick = -1;
  let lastAppliedTick = -1;
  let settledAnswers: SettledAnswer[] = [];
  let lastRequestKey = "";
  // The error of the last request that failed, until one succeeds again.
  let lastFailure: BrainErrorKind | null = null;
  const controllers = new Set<AbortController>();

  function shouldAsk(world: World): boolean {
    const demon = world.casters.demon;
    return world.round.phase === "fighting" && demon.alive && !isFrozen(demon);
  }

  // Sends a tick unless it would repeat the last request word for word while that is still fresh.
  function maybeSend(world: World): void {
    const { request, options: tickOptions } = buildTickRequest(world, recent);
    const key = JSON.stringify([request.state, tickOptions]);
    const heartbeatDue = now() - scheduler.lastSentAtMs >= config.brain.duelTick.heartbeatMs;
    if (key === lastRequestKey && !heartbeatDue && executor.active !== null) return;
    lastRequestKey = key;
    send(world, request, tickOptions);
  }

  function send(world: World, request: BrainRequest, tickOptions: TickOptions): void {
    const stamp: RequestStamp = { tick: world.tick, timeMs: world.timeMs, roundEpoch };
    const sentAtMs = now();
    scheduler = markSent(scheduler, sentAtMs);
    stats.sent(request, sentAtMs);
    const controller = new AbortController();
    controllers.add(controller);
    void transport(request, controller.signal)
      .catch((caught: unknown): BrainResponse => ({ ok: false, error: "upstream", message: caught instanceof Error ? caught.message : "transport failed" }))
      .then((response) => {
        controllers.delete(controller);
        settle(stamp, tickOptions, sentAtMs, response);
      });
  }

  function settle(stamp: RequestStamp, tickOptions: TickOptions, sentAtMs: number, response: BrainResponse): void {
    const settledAtMs = now();
    const roundTripMs = settledAtMs - sentAtMs;
    scheduler = markSettled(scheduler, settledAtMs, response.ok ? { ok: true, latencyMs: roundTripMs } : { ok: false, error: response.error, retryAfterMs: response.retryAfterMs }, tuning());
    stats.settled(response, settledAtMs, roundTripMs);
    if (response.ok) lastFailure = null;
    else if (response.error !== "aborted") lastFailure = response.error;
    if (response.ok) settledAnswers = [...settledAnswers, { stamp, options: tickOptions, response }];
  }

  // Newest answer wins; older ones that arrive late are superseded.
  function applySettledAnswers(world: World): void {
    const pending = [...settledAnswers].sort((left, right) => left.stamp.tick - right.stamp.tick);
    settledAnswers = [];
    for (const answer of pending) {
      if (answer.stamp.tick <= lastAppliedTick) {
        stats.stale("superseded");
        continue;
      }
      const reason = staleReason(answer.stamp, world, { roundEpoch, lastDemonFrozenTick }, config.brain.duelTick.maxAnswerAgeMs);
      if (reason) {
        stats.stale(reason);
        continue;
      }
      const decided = decideFromAnswers(answer.response.answers, answer.options);
      if (!decided) {
        stats.invalid();
        continue;
      }
      executor = adoptDecision(executor, decided, world.timeMs);
      lastAppliedTick = answer.stamp.tick;
      stats.applied(decided, now(), world.timeMs);
    }
  }

  return {
    observe(world, events) {
      recent = recordRecentActions(recent, world.timeMs, events);
      executor = observeDemonEvents(executor, events);
      for (const event of events) {
        if (event.type === "roundEnded" || event.type === "roundStarted") {
          roundEpoch += 1;
          executor = { ...executor, active: null };
        }
        if (event.type === "frozen" && event.casterId === "demon") lastDemonFrozenTick = world.tick;
      }
      if (events.some((event) => event.type === "roundStarted" && event.round === 1)) recent = noRecentActions;
    },

    input(world) {
      applySettledAnswers(world);
      if (shouldAsk(world) && canSend(scheduler, now(), tuning())) maybeSend(world);
      const active = executor.active;
      if (!active || world.timeMs - active.appliedAtMs > config.brain.duelTick.decisionExpiryMs) return null;
      return decisionInput(executor, world);
    },

    cancel() {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      executor = { ...executor, active: null };
      settledAnswers = [];
    },

    // A single slow or failed answer is a hiccup, not an outage: only failuresBeforeBackoff in a row count, or a
    // failure that won't clear by itself (no API key, the token budget spent).
    outOfMana() {
      if (lastFailure === null) return null;
      const lasting = lastFailure === "no_api_key" || lastFailure === "budget_exceeded";
      return lasting || scheduler.consecutiveFailures >= tuning().failuresBeforeBackoff ? lastFailure : null;
    },

    snapshot(world) {
      const nowMs = now();
      return stats.snapshot(nowMs, {
        intervalMs: currentIntervalMs(scheduler, tuning()),
        inFlight: scheduler.inFlight,
        pausedReason: isPaused(scheduler, nowMs) ? scheduler.pauseReason : null,
        recent,
        worldTimeMs: world.timeMs,
      });
    },
  };
}

// The browser's transport: POST to the proxy, which holds the API key and calls Jev (server/brainHandler.ts).
export function createFetchTransport(endpoint: string = config.brain.endpointPath): BrainTransport {
  return async (request, signal) => {
    // A little longer than the server's own timeout, so the server's answer (often a clean "timeout") wins the race.
    const timeoutMs = config.brain.duelTick.timeoutMs + 300;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, timeoutSignal]),
      });
      return (await response.json()) as BrainResponse;
    } catch (caught) {
      if (signal.aborted) return { ok: false, error: "aborted", message: "request cancelled" };
      if (timeoutSignal.aborted) return { ok: false, error: "timeout", message: `no answer within ${timeoutMs} ms` };
      return { ok: false, error: "upstream", message: caught instanceof Error ? caught.message : "network error" };
    }
  };
}
