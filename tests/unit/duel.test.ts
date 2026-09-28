import { afterEach, describe, expect, it } from "vitest";
import type { BrainTransport } from "../../src/jev/jevBrain.ts";
import type { BrainRequest, BrainResponse } from "../../src/jev/protocol.ts";
import { createDemonBrain } from "../../src/brain/demonBrain.ts";
import { createJevBrain } from "../../src/jev/jevBrain.ts";
import { config } from "../../src/config.ts";
import { createDuelEngine } from "../../src/match/engine.ts";
import { createPlayback, type PlaybackStep } from "../../src/match/playback.ts";
import type { ServerMessage } from "../../src/match/protocol.ts";
import { adoptTunables, applyTune, readTunable } from "../../src/match/tuning.ts";
import type { SimEvent, World } from "../../src/sim/types.ts";
import { createWorld } from "../../src/sim/world.ts";
import { createDuelHost, matchWinner, type DuelViewer } from "../../server/duelHost.ts";
import { loadFixtures } from "../fixtures/fixtureFormat.ts";

const recorded = loadFixtures()[0]!.response;
const stepMs = 1000 / config.sim.stepHz;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("duel engine", () => {
  it("runs one step per 1/60 s and reports each step", () => {
    const steps: World[] = [];
    const offline: BrainTransport = async () => ({ ok: false, error: "no_api_key", message: "" });
    const demon = createDemonBrain(createJevBrain({ transport: offline }), "heuristic");
    const engine = createDuelEngine({ demon, warlock: null }, { onStep: (world) => steps.push(world) });
    engine.advance(stepMs * 2.5 / 1000);
    expect(engine.world.tick).toBe(2);
    expect(steps.map((world) => world.tick)).toEqual([1, 2]);
    expect(engine.alpha).toBeCloseTo(0.5, 5);
  });

  it("reports a press as consumed once", () => {
    const demon = createDemonBrain(createJevBrain({ transport: async () => recorded }), "random");
    const engine = createDuelEngine({ demon, warlock: null });
    const press = { move: { x: 0, z: 0 }, aimPoint: { x: 0, z: 0 }, castHeld: false, castPressed: true, cloakHeld: false, dashPressed: false, carry: null };
    expect(engine.advance(0.001, press).pressesConsumed).toBe(false);
    expect(engine.advance(stepMs / 1000, press).pressesConsumed).toBe(true);
  });
});

function step(world: World, tick: number, events: SimEvent[] = []): PlaybackStep {
  return { world: { ...world, tick }, events, badges: { warlock: { label: "Jev", outOfMana: null }, demon: { label: "Jev", outOfMana: null } } };
}

describe("playback", () => {
  const world = createWorld();
  const died: SimEvent = { type: "roundStarted", round: 2 };

  it("renders a few steps behind the newest and fires each event once", () => {
    const playback = createPlayback();
    playback.reset(world);
    for (let tick = 1; tick <= 10; tick += 1) playback.push(step(world, tick, tick === 5 ? [died] : []));
    // 10 steps arrived at once: 7 behind target is within the snap range, so it catches up gradually.
    let fired = 0;
    let lastTick = 0;
    for (let frame = 0; frame < 20; frame += 1) {
      const played = playback.advance(stepMs / 1000)!;
      fired += played.events.length;
      expect(played.current.tick).toBeGreaterThanOrEqual(lastTick);
      lastTick = played.current.tick;
    }
    expect(fired).toBe(1);
    expect(lastTick).toBeLessThanOrEqual(10);
  });

  it("jumps when far behind, without replaying the skipped events", () => {
    const playback = createPlayback();
    playback.reset(world);
    for (let tick = 1; tick <= 200; tick += 1) playback.push(step(world, tick, [died]));
    const played = playback.advance(stepMs / 1000)!;
    expect(played.current.tick).toBeGreaterThanOrEqual(200 - config.duel.interpolationDelaySteps);
    expect(played.events).toHaveLength(1);
  });

  it("ignores steps older than the newest", () => {
    const playback = createPlayback();
    playback.reset({ ...world, tick: 50 });
    playback.push(step(world, 49));
    expect(playback.advance(1)!.current.tick).toBe(50);
  });
});

describe("tuning", () => {
  afterEach(() => {
    config.sim.dash.cooldownMs = 1500;
  });

  it("applies known paths of the same type", () => {
    expect(applyTune(["sim", "dash", "cooldownMs"], 900)).toBe(true);
    expect(config.sim.dash.cooldownMs).toBe(900);
  });

  it.each([
    [["sim", "dash", "cooldownMs"], "fast"],
    [["sim", "dash", "cooldownMs"], Number.NaN],
    [["sim", "nope"], 1],
    [["__proto__", "polluted"], 1],
    [["brain", "maxTokensPerMinute"], 1e12],
    [["brain", "dollarsPerMillionInputTokens"], 0],
  ])("refuses %j = %j", (path, value) => {
    expect(applyTune(path, value)).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("adopts a server config leaf by leaf", () => {
    const root = { sim: { a: 1, nested: { b: true } } };
    adoptTunables({ sim: { a: 2, nested: { b: "no" }, extra: 5 } }, root);
    expect(root).toEqual({ sim: { a: 2, nested: { b: true } } });
    expect(readTunable(["sim", "a"], root)).toBe(2);
  });
});

function hostHarness(transportResponse: BrainResponse = recorded, tuning?: boolean) {
  const clock = { nowMs: 0 };
  const requests: BrainRequest[] = [];
  const aborted: AbortSignal[] = [];
  let pump: (() => void) | null = null;
  const host = createDuelHost({
    transport: async (request, signal) => {
      requests.push(request);
      aborted.push(signal);
      return transportResponse;
    },
    jevOnline: () => true,
    tuning,
    now: () => clock.nowMs,
    every: (_intervalMs, run) => {
      pump = run;
      return () => {
        pump = null;
      };
    },
  });
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      clock.nowMs += stepMs;
      pump?.();
      await flush();
    }
  };
  const viewer = () => {
    const received: ServerMessage[] = [];
    const connection = host.addViewer({ send: (data) => received.push(JSON.parse(data) as ServerMessage) } satisfies DuelViewer);
    return { received, connection };
  };
  return { clock, requests, aborted, host, advance, viewer, isPumping: () => pump !== null };
}

const host0Stats = () => hostHarness().host.stats();

describe("duel host", () => {
  it("counts a match win only on the round that reaches the winning score", () => {
    const toWin = config.sim.roundsToWinMatch;
    const world = (warlock: number, demon: number): World => {
      const start = createWorld(config.sim);
      return { ...start, round: { ...start.round, phase: "ended", wins: { warlock, demon } } };
    };
    const demonTakesRound: SimEvent[] = [{ type: "roundEnded", winner: "demon", round: 3 }];
    expect(matchWinner(world(1, toWin - 1), demonTakesRound)).toBeNull();
    expect(matchWinner(world(1, toWin), demonTakesRound)).toBe("demon");
    expect(matchWinner(world(toWin, toWin), [])).toBeNull();
    expect(host0Stats().matchWins).toEqual({ warlock: 0, demon: 0 });
  });

  it("only runs while someone watches, and cancels Jev when the last viewer leaves", async () => {
    const { host, viewer, advance, requests, aborted, isPumping } = hostHarness();
    expect(host.running).toBe(false);
    const first = viewer();
    const second = viewer();
    expect(isPumping()).toBe(true);
    await advance(500);
    expect(requests.length).toBeGreaterThan(0);

    first.connection.close();
    expect(host.running).toBe(true);
    second.connection.close();
    expect(host.running).toBe(false);
    const sentBeforeLeaving = requests.length;
    await advance(1000);
    expect(requests.length).toBe(sentBeforeLeaving);
    expect(aborted.length).toBeGreaterThan(0);
  });

  it("greets with the world, then streams the same steps to everyone", async () => {
    const { viewer, advance } = hostHarness();
    const first = viewer();
    await advance(100);
    const second = viewer();
    await advance(100);
    expect(first.received[0]!.type).toBe("hello");
    expect(second.received[0]!.type).toBe("hello");
    const ticks = (messages: ServerMessage[]) => messages.flatMap((message) => (message.type === "step" ? [message.world.tick] : []));
    const helloTick = (second.received[0] as Extract<ServerMessage, { type: "hello" }>).world.tick;
    expect(ticks(second.received)).toEqual(ticks(first.received).filter((tick) => tick > helloTick));
  });

  it("counts both Jevs' spend and the running time from the server's start", async () => {
    const { viewer, advance, host } = hostHarness();
    viewer();
    await advance(2000);
    const stats = host.stats();
    // The clock starts at zero with this server and only runs once Jev answers (not during the round intro).
    expect(stats.activeMs).toBeGreaterThan(0);
    expect(stats.activeMs).toBeLessThan(2000);
    expect(stats.spending).toBe(true);
    expect(stats.spend.demon.requests).toBeGreaterThan(0);
    expect(stats.spend.warlock.requests).toBeGreaterThan(0);
    expect(stats.spend.demon.tokens).toBe(stats.spend.demon.requests * recorded.usage.inputTokens);
    expect(stats.spend.demon.dollars).toBeCloseTo((stats.spend.demon.tokens * config.brain.dollarsPerMillionInputTokens) / 1e6, 12);
  });

  it("does not bill failed requests, and keeps the clock stopped while Jev isn't spending", async () => {
    const { viewer, advance, host } = hostHarness({ ok: false, error: "no_api_key", message: "" });
    viewer();
    await advance(1000);
    expect(host.stats().spend.demon).toEqual({ requests: 0, tokens: 0, dollars: 0 });
    expect(host.stats().activeMs).toBe(0);
    expect(host.stats().spending).toBe(false);
  });

  it("shares tunable edits with the other viewers and restores refused ones", async () => {
    const { viewer } = hostHarness();
    const editor = viewer();
    const watcher = viewer();
    editor.connection.receive(JSON.stringify({ type: "tune", path: ["sim", "dash", "cooldownMs"], value: 1400 }));
    expect(config.sim.dash.cooldownMs).toBe(1400);
    expect(watcher.received.at(-1)).toEqual({ type: "tune", path: ["sim", "dash", "cooldownMs"], value: 1400 });
    expect(editor.received.some((message) => message.type === "tune")).toBe(false);

    editor.connection.receive(JSON.stringify({ type: "tune", path: ["brain", "maxTokensPerMinute"], value: 1e12 }));
    expect(editor.received.at(-1)).toEqual({ type: "tune", path: ["brain", "maxTokensPerMinute"], value: config.brain.maxTokensPerMinute });
    editor.connection.receive("not json");
    config.sim.dash.cooldownMs = 1500;
  });

  it("ignores tunable edits when tuning is off", () => {
    const { viewer } = hostHarness(recorded, false);
    const editor = viewer();
    const watcher = viewer();
    editor.connection.receive(JSON.stringify({ type: "tune", path: ["sim", "dash", "cooldownMs"], value: 1400 }));
    expect(config.sim.dash.cooldownMs).toBe(1500);
    expect(watcher.received.some((message) => message.type === "tune")).toBe(false);
  });

  it("sends inspector snapshots only to viewers who asked for that side", async () => {
    const { viewer, advance } = hostHarness();
    const curious = viewer();
    const other = viewer();
    curious.connection.receive(JSON.stringify({ type: "inspect", side: "warlock" }));
    await advance(500);
    const inspects = curious.received.filter((message) => message.type === "inspect");
    expect(inspects.length).toBeGreaterThan(0);
    expect(inspects.every((message) => message.type === "inspect" && message.side === "warlock")).toBe(true);
    expect(other.received.some((message) => message.type === "inspect")).toBe(false);
  });
});
