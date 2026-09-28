import { describe, expect, it } from "vitest";
import { noRecentActions } from "../../src/jev/describe/recent.ts";
import { describeDuel } from "../../src/jev/state.ts";
import { createJevBrain, type BrainTransport } from "../../src/jev/jevBrain.ts";
import { mirrorEvents, mirrorWorld } from "../../src/brain/mirror.ts";
import { createDemonBrain, mirroredBrain } from "../../src/brain/demonBrain.ts";
import { config } from "../../src/config.ts";
import type { SimEvent, World } from "../../src/sim/types.ts";
import { createWorld, stepWorld } from "../../src/sim/world.ts";
import { loadFixtures } from "../fixtures/fixtureFormat.ts";
import { buildProbeWorld } from "../fixtures/probeSituation.ts";

const stepSeconds = 1 / config.sim.stepHz;

describe("mirroring", () => {
  it("swaps who is who and nothing else, and undoes itself", () => {
    const world = buildProbeWorld();
    const mirrored = mirrorWorld(world);
    expect(mirrored.casters.demon.position).toEqual(world.casters.warlock.position);
    expect(mirrored.casters.demon.id).toBe("demon");
    expect(mirrored.projectiles[0]!.ownerId).toBe("demon");
    expect(mirrored.round.wins).toEqual({ warlock: 0, demon: 1 });
    expect(mirrorWorld(mirrored)).toEqual(world);
  });

  it("swaps every caster reference in events", () => {
    const events: SimEvent[] = [
      { type: "hit", casterId: "demon", sourceId: "warlock", element: "fire", kind: "direct", damage: 18, blocked: false, countered: true, position: { x: 0, z: 0 } },
      { type: "earthStrike", casterId: "warlock", from: { x: 0, z: 0 }, to: { x: 0, z: 1 }, hitCasterId: null },
      { type: "roundEnded", winner: "warlock", round: 2 },
      { type: "carryChanged", casterId: "warlock", from: "fire", to: "earth" },
      { type: "roundStarted", round: 3 },
    ];
    const mirrored = mirrorEvents(events);
    expect(mirrored[0]).toMatchObject({ casterId: "warlock", sourceId: "demon" });
    expect(mirrored[1]).toMatchObject({ casterId: "demon", hitCasterId: null });
    expect(mirrored[2]).toMatchObject({ winner: "demon" });
    expect(mirrored[3]).toMatchObject({ casterId: "demon" });
    expect(mirrorEvents(mirrored)).toEqual(events);
  });

  it("describes the duel from the blue mage's side", () => {
    const situation = describeDuel(mirrorWorld(buildProbeWorld()), noRecentActions);
    // Blue (described as `demon`) carries fire and has its fireball flying at red (described as `warlock`).
    expect(situation.demon.carrying).toBe("fire");
    expect(situation.warlock.carrying).toBe("frost");
    expect(situation.between.incomingToDemon).toEqual([]);
    expect(describeDuel(buildProbeWorld(), noRecentActions).between.incomingToDemon.map((incoming) => incoming.element)).toEqual(["fire"]);
    expect(situation.round).toBe("round 2 of 5; demon leads 1–0; warlock ahead on health");
  });
});

describe("Jev vs Jev", () => {
  it("plays a whole exchange with both mages driven by Jev brains", async () => {
    // Every request is answered at once with a recorded response, its act answer rotated between leaning to
    // cast, dash and cloak so both mages do all three; the clock follows sim time.
    const recorded = loadFixtures()[0]!.response;
    const leanings = [
      { cast: 0.7, cloak: 0.1, dash_left: 0.1, dash_right: 0.1 },
      { cast: 0.1, cloak: 0.1, dash_left: 0.4, dash_right: 0.4 },
      { cast: 0.1, cloak: 0.8, dash_left: 0.05, dash_right: 0.05 },
    ];
    const sent = { red: 0, blue: 0 };
    const transportFor = (side: keyof typeof sent): BrainTransport => async () => {
      const probabilities = leanings[sent[side] % leanings.length]!;
      sent[side] += 1;
      return { ...recorded, answers: { ...recorded.answers, demon_act: { ...recorded.answers.demon_act!, probabilities } } };
    };
    let world: World = createWorld();
    const clock = () => world.timeMs;
    const red = createDemonBrain(createJevBrain({ transport: transportFor("red"), now: clock }));
    const blue = mirroredBrain(createDemonBrain(createJevBrain({ transport: transportFor("blue"), now: clock }), "jev", 99));
    const events: SimEvent[] = [];
    for (let step = 0; step < config.sim.stepHz * 8; step += 1) {
      const inputs = { warlock: blue.input(world), demon: red.input(world) };
      const result = stepWorld(world, inputs, stepSeconds);
      world = result.world;
      red.observe(world, result.events);
      blue.observe(world, result.events);
      events.push(...result.events);
      if (step % 6 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(sent.red).toBeGreaterThan(10);
    expect(sent.blue).toBeGreaterThan(10);
    expect(red.snapshot(world).applied).toBeGreaterThan(10);
    expect(blue.snapshot(world).applied).toBeGreaterThan(10);
    expect(blue.fallbackStats().jevSteps).toBeGreaterThan(blue.fallbackStats().fallbackSteps);
    // Blue's brain remembers red's actions, not its own.
    expect(blue.snapshot(world).recent).not.toEqual(noRecentActions);
    const dashers = new Set(events.flatMap((event) => (event.type === "dashed" ? [event.casterId] : [])));
    expect(dashers).toEqual(new Set(["warlock", "demon"]));
  });
});
