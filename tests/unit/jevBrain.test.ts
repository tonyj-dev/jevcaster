import { noRecentActions } from "../../src/jev/describe/recent.ts";
import { describe, expect, it } from "vitest";
import { createJevBrain, type BrainTransport, type JevBrain } from "../../src/jev/jevBrain.ts";
import type { BrainRequest, BrainResponse } from "../../src/jev/protocol.ts";
import { brainModes, createDemonBrain } from "../../src/brain/demonBrain.ts";
import { createRandomBrainMemory, randomDemonInput } from "../../src/brain/randomBrain.ts";
import { config } from "../../src/config.ts";
import type { CasterInput, SimEvent, World } from "../../src/sim/types.ts";
import { createWorld } from "../../src/sim/world.ts";
import { loadFixtures } from "../fixtures/fixtureFormat.ts";

const recorded = loadFixtures()[0]!.response;

type Call = { request: BrainRequest; signal: AbortSignal; resolve: (response: BrainResponse) => void };

// A transport whose answers the test releases by hand, with a fake clock.
function harness() {
  const calls: Call[] = [];
  const clock = { nowMs: 0 };
  const transport: BrainTransport = (request, signal) => new Promise((resolve) => calls.push({ request, signal, resolve }));
  const brain = createJevBrain({ transport, now: () => clock.nowMs });
  return { calls, clock, brain };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const at = (world: World, timeMs: number, tick = Math.round(timeMs / (1000 / config.sim.stepHz))): World => ({ ...world, timeMs, tick });
// The same world with the warlock carrying another spell: a change worth asking Jev about again.
const carrying = (world: World, element: "fire" | "frost" | "earth"): World => ({ ...world, casters: { ...world.casters, warlock: { ...world.casters.warlock, carried: element } } });

async function answer(call: Call, response: BrainResponse = recorded): Promise<void> {
  call.resolve(response);
  await flush();
}

describe("Jev brain", () => {
  it("asks on the first step, follows the answer once it arrives, and asks again when something changes", async () => {
    const { calls, clock, brain } = harness();
    const world = createWorld();
    expect(brain.input(world)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.kind).toBe("tick");
    expect(Object.keys(calls[0]!.request.questions)).toEqual(["demon_move", "demon_spell", "demon_act", "demon_aim"]);

    clock.nowMs = 150;
    await answer(calls[0]!);
    const input = brain.input(at(world, 150));
    expect(input).not.toBeNull();
    expect(brain.snapshot(world).applied).toBe(1);
    expect(brain.snapshot(world).latencies).toEqual([150]);
    expect(calls).toHaveLength(1);

    // Nothing changed: no new request until the heartbeat.
    clock.nowMs = 200;
    brain.input(at(world, 200));
    expect(calls).toHaveLength(1);
    // The warlock switched spells: ask again at once.
    brain.input(at(carrying(world, "earth"), 210));
    expect(calls).toHaveLength(2);
    clock.nowMs = 200 + config.brain.duelTick.heartbeatMs;
    brain.input(at(carrying(world, "earth"), clock.nowMs));
    expect(calls).toHaveLength(3);
  });


  it("keeps at most two requests in flight", async () => {
    const { calls, clock, brain } = harness();
    const world = createWorld();
    brain.input(world);
    await answer(calls[0]!);
    const elements = ["earth", "fire", "frost"] as const;
    for (let nowMs = 50; nowMs <= 2000; nowMs += 50) {
      clock.nowMs = nowMs;
      brain.input(at(carrying(world, elements[(nowMs / 50) % 3]!), nowMs));
    }
    expect(calls).toHaveLength(1 + config.brain.maxInFlightRequests);
  });

  it("drops answers that are too old, from another round, or overtaken by a newer one", async () => {
    const { calls, clock, brain } = harness();
    const world = createWorld();
    brain.input(world);
    clock.nowMs = 700;
    await answer(calls[0]!);
    // The answer to a request sent at 0 ms reaches a world 650 ms later: too old. This step also sends call 1.
    expect(brain.input(at(world, config.brain.duelTick.maxAnswerAgeMs + 50))).toBeNull();
    expect(brain.snapshot(world).stale.too_old).toBe(1);

    // The 700 ms round trip slowed the tick to 400 ms. Calls 1 and 2 are in flight; the newer one lands and
    // is followed first, so the older one is superseded.
    clock.nowMs = 1100;
    brain.input(at(world, 1100));
    expect(calls).toHaveLength(3);
    await answer(calls[2]!);
    expect(brain.input(at(world, 1150))).not.toBeNull();
    await answer(calls[1]!);
    brain.input(at(world, 1160));
    expect(brain.snapshot(world).stale.superseded).toBe(1);

    clock.nowMs = 1500;
    brain.input(at(carrying(world, "earth"), 1500));
    expect(calls).toHaveLength(4);
    const roundEnded: SimEvent = { type: "roundEnded", winner: "warlock", round: 1 };
    brain.observe(at(world, 1520), [roundEnded]);
    await answer(calls[3]!);
    brain.input(at(world, 1550));
    expect(brain.snapshot(world).stale.round_changed).toBe(1);
    expect(brain.snapshot(world).applied).toBe(1);
  });

  it("stops following a decision that has gone unrefreshed for too long", async () => {
    const { calls, clock, brain } = harness();
    const world = createWorld();
    brain.input(world);
    await answer(calls[0]!);
    expect(brain.input(at(world, 100))).not.toBeNull();
    // No fresher answer arrives in time.
    clock.nowMs = 100_000;
    const expiry = config.brain.duelTick.decisionExpiryMs;
    expect(brain.input(at(world, expiry + 101))).toBeNull();
  });

  it("is out of mana after failures in a row, not after one, until an answer gets through", async () => {
    const { calls, clock, brain } = harness();
    const world = createWorld();
    const timeout: BrainResponse = { ok: false, error: "timeout", message: "no answer" };
    brain.input(world);
    await answer(calls[0]!, timeout);
    expect(brain.outOfMana()).toBeNull();
    // The timeout slowed the tick to 400 ms.
    clock.nowMs = 500;
    brain.input(at(world, 500));
    await answer(calls[1]!, { ok: false, error: "upstream", message: "HTTP 503" });
    expect(brain.outOfMana()).toBe("upstream");
    clock.nowMs = 20_000;
    brain.input(at(world, 20_000));
    await answer(calls[2]!);
    expect(brain.outOfMana()).toBeNull();
  });

  it("is out of mana at once without an API key", async () => {
    const { calls, brain } = harness();
    brain.input(createWorld());
    await answer(calls[0]!, { ok: false, error: "no_api_key", message: "TYPESAFE_API_KEY is not set" });
    expect(brain.outOfMana()).toBe("no_api_key");
  });

  it("pauses when the server has no API key, and reports why", async () => {
    const { calls, clock, brain } = harness();
    const world = createWorld();
    brain.input(world);
    await answer(calls[0]!, { ok: false, error: "no_api_key", message: "TYPESAFE_API_KEY is not set" });
    for (let nowMs = 0; nowMs < config.brain.backoff.offlineRetryMs; nowMs += 1000) {
      clock.nowMs = nowMs;
      expect(brain.input(at(world, nowMs))).toBeNull();
    }
    expect(calls).toHaveLength(1);
    const snapshot = brain.snapshot(world);
    expect(snapshot.pausedReason).toBe("no_api_key");
    expect(snapshot.failures).toEqual({ no_api_key: 1 });
  });

  it("doesn't ask while the round is over or the demon is frozen", () => {
    const { calls, brain } = harness();
    const world = createWorld();
    brain.input({ ...world, round: { ...world.round, phase: "ended" } });
    brain.input({ ...world, casters: { ...world.casters, demon: { ...world.casters.demon, freezeRemainingMs: 500 } } });
    expect(calls).toHaveLength(0);
  });

  it("aborts requests in flight when cancelled", () => {
    const { calls, brain } = harness();
    brain.input(createWorld());
    brain.cancel();
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it("remembers the warlock's recent actions from sim events", () => {
    const { brain } = harness();
    const world = createWorld();
    brain.observe(at(world, 100), [{ type: "dashed", casterId: "warlock", from: world.casters.warlock.position, direction: { x: 1, z: 0 } }]);
    expect(brain.snapshot(world).recent.lastDashAtMs).toBe(100);
    // A new match forgets them.
    brain.observe(at(world, 200), [{ type: "roundStarted", round: 1 }]);
    expect(brain.snapshot(world).recent).toEqual(noRecentActions);
  });
});

function fakeJev(inputs: (CasterInput | null)[]): JevBrain & { cancelled: number } {
  let index = 0;
  const fake = {
    cancelled: 0,
    observe() {},
    input: () => inputs[Math.min(index++, inputs.length - 1)] ?? null,
    cancel() {
      fake.cancelled += 1;
    },
    snapshot: () => {
      throw new Error("not used");
    },
    outOfMana: () => null,
  };
  return fake;
}

describe("demon brain modes", () => {
  it("cycles Jev → heuristic → random → Jev and stops Jev when leaving it", () => {
    const jev = fakeJev([null]);
    const demon = createDemonBrain(jev);
    expect(brainModes).toEqual(["jev", "heuristic", "random"]);
    expect(demon.mode).toBe("jev");
    expect(demon.cycleMode()).toBe("heuristic");
    expect(jev.cancelled).toBe(1);
    expect(demon.cycleMode()).toBe("random");
    expect(demon.cycleMode()).toBe("jev");
  });

  it("falls back to the heuristic when Jev has no decision, and counts takeovers", () => {
    const decided: CasterInput = { move: { x: 1, z: 0 }, aimPoint: { x: 0, z: 0 }, castHeld: false, castPressed: false, cloakHeld: true, dashPressed: false, carry: "frost" };
    const demon = createDemonBrain(fakeJev([null, decided, decided, null, null]));
    const world = createWorld();
    demon.input(world);
    expect(demon.controller).toBe("fallback");
    expect(demon.input(world)).toBe(decided);
    expect(demon.controller).toBe("jev");
    demon.input(world);
    demon.input(world);
    demon.input(world);
    expect(demon.controller).toBe("fallback");
    expect(demon.fallbackStats()).toEqual({ takeovers: 1, fallbackSteps: 3, jevSteps: 2 });
  });
});

describe("random brain", () => {
  it("re-rolls its intent every so often and stays inside the input shape", () => {
    let memory = createRandomBrainMemory(2);
    const world = createWorld();
    const seen = new Set<string>();
    for (let timeMs = 0; timeMs < 20_000; timeMs += 100) {
      const decision = randomDemonInput({ ...world, timeMs }, memory);
      memory = decision.memory;
      seen.add(`${decision.input.carry}:${decision.input.cloakHeld}`);
      expect(Math.hypot(decision.input.move.x, decision.input.move.z)).toBeLessThanOrEqual(1.0001);
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});
