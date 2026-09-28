import { createJevBrain, type BrainTransport } from "../src/jev/jevBrain.ts";
import { brainLabel, createDemonBrain, mirroredBrain, type DemonBrain } from "../src/brain/demonBrain.ts";
import { config } from "../src/config.ts";
import { createDuelEngine } from "../src/match/engine.ts";
import { emptySpend, type BrainBadge, type ClientMessage, type DuelStats, type InspectorPayload, type InspectSide, type ServerMessage, type SideSpend } from "../src/match/protocol.ts";
import { applyTune, readTunable } from "../src/match/tuning.ts";
import type { CasterId, SimEvent, World } from "../src/sim/types.ts";

// The side that just won the match with this step, or null. `world` is the step's result, with the round's wins counted.
export function matchWinner(world: World, events: readonly SimEvent[]): CasterId | null {
  for (const event of events) {
    if (event.type === "roundEnded" && world.round.wins[event.winner] >= config.sim.roundsToWinMatch) return event.winner;
  }
  return null;
}

// One viewer's connection. Messages arrive already serialised, so a step is stringified once for everyone.
export type DuelViewer = {
  send(data: string): void;
  // False while the viewer's socket is backed up; steps are skipped for it until it drains.
  canTakeSteps?(): boolean;
};

export type ViewerConnection = {
  receive(data: string): void;
  close(): void;
};

export type DuelHostOptions = {
  transport: BrainTransport;
  jevOnline: () => boolean;
  // Accept dev panel edits from viewers. Off on the public server, where nobody may change the shared duel.
  tuning?: boolean;
  now?: () => number;
  // Runs `run` every `intervalMs` until the returned function is called. Tests drive it by hand.
  every?: (intervalMs: number, run: () => void) => () => void;
};

export type DuelHost = {
  addViewer(viewer: DuelViewer): ViewerConnection;
  readonly running: boolean;
  stats(): DuelStats;
  // Saves the totals and stops the loop, e.g. when the HTTP server closes.
  shutdown(): void;
};

type ViewerState = { inspect: InspectSide | null };

const defaultEvery = (intervalMs: number, run: () => void) => {
  const handle = setInterval(run, intervalMs);
  return () => clearInterval(handle);
};

// The single shared Jev vs Jev duel. It only runs (and only spends) while at least one viewer is connected.
export function createDuelHost(options: DuelHostOptions): DuelHost {
  const now = options.now ?? (() => performance.now());
  const every = options.every ?? defaultEvery;
  // What each Jev has been billed since this server started.
  const spend: Record<CasterId, SideSpend> = { warlock: emptySpend, demon: emptySpend };
  const matchWins: Record<CasterId, number> = { warlock: 0, demon: 0 };
  // Time Jev has been spending tokens since this server started, and when either Jev was last billed.
  let activeMs = 0;
  let lastBilledAtMs = Number.NEGATIVE_INFINITY;

  // Counts what each Jev is billed for: input tokens of answered requests (output is free).
  function metered(side: CasterId): BrainTransport {
    return async (request, signal) => {
      const response = await options.transport(request, signal);
      if (response.ok) {
        lastBilledAtMs = now();
        const tokens = response.usage.inputTokens;
        const previous = spend[side];
        spend[side] = {
          requests: previous.requests + 1,
          tokens: previous.tokens + tokens,
          dollars: previous.dollars + (tokens * config.brain.dollarsPerMillionInputTokens) / 1_000_000,
        };
      }
      return response;
    };
  }

  const demon = createDemonBrain(createJevBrain({ transport: metered("demon"), now }));
  // Its own heuristic seed, so the two fallbacks don't mirror each other.
  const warlock = mirroredBrain(createDemonBrain(createJevBrain({ transport: metered("warlock"), now }), "jev", config.heuristicBrain.seed + 1));
  const brains: Record<CasterId, DemonBrain> = { demon, warlock };
  const engine = createDuelEngine({ demon, warlock }, { hitstop: false, onStep: broadcastStep });
  const viewers = new Map<DuelViewer, ViewerState>();

  let stopLoop: (() => void) | null = null;
  let lastPumpMs = 0;
  let lastStatsMs = 0;
  let lastInspectMs = 0;
  let lastSaveMs = 0;

  // Jev counts as spending while an answered request is recent; an outage or an empty room stops the clock.
  const spending = () => stopLoop !== null && now() - lastBilledAtMs <= config.duel.spendingWindowMs;

  function stats(): DuelStats {
    return { spend: { ...spend }, matchWins: { ...matchWins }, activeMs, spending: spending(), running: stopLoop !== null, viewers: viewers.size, jevOnline: options.jevOnline() };
  }

  function send(viewer: DuelViewer, message: ServerMessage): void {
    viewer.send(JSON.stringify(message));
  }

  function broadcast(message: ServerMessage, except?: DuelViewer): void {
    const data = JSON.stringify(message);
    for (const viewer of viewers.keys()) if (viewer !== except) viewer.send(data);
  }

  function badge(brain: DemonBrain, world: World): BrainBadge {
    return { label: brainLabel(brain), outOfMana: brain.outOfMana() };
  }

  function broadcastStep(world: World, events: readonly SimEvent[]): void {
    const winner = matchWinner(world, events);
    if (winner) matchWins[winner] += 1;
    const message: ServerMessage = { type: "step", world, events, badges: { warlock: badge(warlock, world), demon: badge(demon, world) } };
    const data = JSON.stringify(message);
    for (const viewer of viewers.keys()) if (viewer.canTakeSteps?.() ?? true) viewer.send(data);
  }

  function inspectorPayload(side: InspectSide): InspectorPayload {
    const brain = brains[side];
    return { mode: brain.mode, controller: brain.controller, fallback: brain.fallbackStats(), snapshot: brain.snapshot(engine.world) };
  }

  function sendInspectors(): void {
    const payloads = new Map<InspectSide, string>();
    for (const [viewer, state] of viewers) {
      if (!state.inspect) continue;
      let data = payloads.get(state.inspect);
      if (data === undefined) {
        data = JSON.stringify({ type: "inspect", side: state.inspect, view: inspectorPayload(state.inspect) } satisfies ServerMessage);
        payloads.set(state.inspect, data);
      }
      viewer.send(data);
    }
  }

  function pump(): void {
    const nowMs = now();
    const elapsedMs = nowMs - lastPumpMs;
    lastPumpMs = nowMs;
    if (spending()) activeMs += elapsedMs;
    engine.advance(elapsedMs / 1000);
    if (nowMs - lastStatsMs >= config.duel.statsIntervalMs) {
      lastStatsMs = nowMs;
      broadcast({ type: "stats", stats: stats() });
    }
    if (nowMs - lastInspectMs >= config.brain.inspector.refreshMs) {
      lastInspectMs = nowMs;
      sendInspectors();
    }
  }

  function start(): void {
    if (stopLoop) return;
    const nowMs = now();
    lastPumpMs = nowMs;
    lastStatsMs = nowMs;
    lastInspectMs = nowMs;
    stopLoop = every(1000 / config.sim.stepHz, pump);
  }

  function stop(): void {
    if (!stopLoop) return;
    stopLoop();
    stopLoop = null;
    // Nobody is watching: stop asking Jev, so an empty room costs nothing.
    demon.cancel();
    warlock.cancel();
  }

  function receive(viewer: DuelViewer, data: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(data) as ClientMessage;
    } catch {
      return;
    }
    const state = viewers.get(viewer);
    if (!state || typeof message !== "object" || message === null) return;
    if (message.type === "inspect") {
      state.inspect = message.side === "warlock" || message.side === "demon" ? message.side : null;
      return;
    }
    if (message.type === "tune" && options.tuning !== false && Array.isArray(message.path) && message.path.every((key) => typeof key === "string")) {
      if (applyTune(message.path, message.value)) {
        broadcast({ type: "tune", path: message.path, value: message.value }, viewer);
        return;
      }
      // Refused (locked, or the wrong type): put the viewer's panel back to the server's value.
      const current = readTunable(message.path);
      if (current !== undefined) send(viewer, { type: "tune", path: message.path, value: current });
    }
  }

  return {
    addViewer(viewer) {
      viewers.set(viewer, { inspect: null });
      start();
      send(viewer, { type: "hello", world: engine.world, config, stats: stats() });
      return {
        receive: (data) => receive(viewer, data),
        close() {
          if (!viewers.delete(viewer)) return;
          if (viewers.size === 0) stop();
        },
      };
    },
    get running() {
      return stopLoop !== null;
    },
    stats,
    shutdown() {
      viewers.clear();
      stop();
    },
  };
}
