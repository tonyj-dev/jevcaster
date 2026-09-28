import { describe, expect, it } from "vitest";
import {
  actFamilies,
  decideFromAnswers,
  pickOption,
  restrictProbabilities,
  staleReason,
  type DemonDecision,
  type PickedAnswer,
} from "../../src/jev/decide.ts";
import { adoptDecision, decisionInput, emptyExecutorMemory, observeDemonEvents } from "../../src/jev/execute.ts";
import { facingFrame } from "../../src/jev/describe/geometry.ts";
import type { ChoiceAnswer } from "../../src/jev/protocol.ts";
import type { ActOption } from "../../src/jev/questions.ts";
import { config } from "../../src/config.ts";
import { idleInput } from "../../src/sim/caster.ts";
import type { CasterInput, Element, SimEvent, World } from "../../src/sim/types.ts";
import { dot, length } from "../../src/sim/vector.ts";
import { createWorld, stepWorld } from "../../src/sim/world.ts";
import { loadFixtures } from "../fixtures/fixtureFormat.ts";
import { buildProbeWorld, probeTickOptions } from "../fixtures/probeSituation.ts";

const continuity = config.brain.continuity;
const stepSeconds = 1 / config.sim.stepHz;
const fixtures = loadFixtures();

describe("picking", () => {
  it("restricts to offered options and renormalises", () => {
    const restricted = restrictProbabilities({ cast: 0.5, cloak: 0.3, bogus: 0.2 }, ["cast", "cloak"]);
    expect(Object.keys(restricted)).toEqual(["cast", "cloak"]);
    expect(restricted.cast).toBeCloseTo(0.625);
    expect(restricted.cloak).toBeCloseTo(0.375);
    expect(restrictProbabilities({ bogus: 1 }, ["cast", "wait"])).toEqual({ cast: 0.5, wait: 0.5 });
  });

  it("picks the most likely option", () => {
    expect(pickOption({ cast: 0.3, cloak: 0.6, wait: 0.1 }, actFamilies)).toBe("cloak");
    expect(pickOption({ fire: 0.2, frost: 0.2, earth: 0.6 }, {})).toBe("earth");
  });

  it("treats a left/right dodge split as one dash, then takes the likelier side", () => {
    // Recorded answers showed this: Jev was sure it should dodge, just not which way.
    expect(pickOption({ dash_left: 0.28, dash_right: 0.32, cloak: 0.4 }, actFamilies)).toBe("dash_right");
    expect(pickOption({ dash_left: 0.28, dash_right: 0.32, cloak: 0.4 }, {})).toBe("cloak");
  });
});

describe("recorded fixtures → decisions", () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s gives a valid decision", (_name, fixture) => {
    const decision = decideFromAnswers(fixture.response.answers, probeTickOptions);
    expect(decision).not.toBeNull();
    expect(probeTickOptions.act).toContain(decision!.act.option);
    expect(probeTickOptions.move).toContain(decision!.move.option);
  });

  it("returns null when an answer is missing or of the wrong type", () => {
    const answers = fixtures[0]!.response.answers;
    const { demon_aim: _aim, ...withoutAim } = answers;
    expect(decideFromAnswers(withoutAim, probeTickOptions)).toBeNull();
    // The proxy only forwards choice questions, but a malformed answer must still be refused.
    const wrongType = { ...answers, demon_act: { type: "noul", noul: 0.5 } as unknown as ChoiceAnswer };
    expect(decideFromAnswers(wrongType, probeTickOptions)).toBeNull();
  });
});

describe("staleness", () => {
  const world: World = { ...createWorld(), tick: 100, timeMs: 1000 };
  const markers = { roundEpoch: 2, lastDemonFrozenTick: -1 };

  it("keeps fresh answers and drops old ones", () => {
    expect(staleReason({ tick: 90, timeMs: 900, roundEpoch: 2 }, world, markers, 600)).toBeNull();
    expect(staleReason({ tick: 50, timeMs: 350, roundEpoch: 2 }, world, markers, 600)).toBe("too_old");
  });

  it("drops answers from before a round change or a freeze", () => {
    expect(staleReason({ tick: 90, timeMs: 900, roundEpoch: 1 }, world, markers, 600)).toBe("round_changed");
    expect(staleReason({ tick: 90, timeMs: 900, roundEpoch: 2 }, { ...world, round: { ...world.round, phase: "ended" } }, markers, 600)).toBe("round_changed");
    expect(staleReason({ tick: 90, timeMs: 900, roundEpoch: 2 }, world, { ...markers, lastDemonFrozenTick: 95 }, 600)).toBe("demon_frozen");
    const frozenWorld = { ...world, casters: { ...world.casters, demon: { ...world.casters.demon, freezeRemainingMs: 300 } } };
    expect(staleReason({ tick: 90, timeMs: 900, roundEpoch: 2 }, frozenWorld, markers, 600)).toBe("demon_frozen");
  });
});

const picked = <Option extends string>(option: Option, probabilities: Record<string, number> = { [option]: 1 }): PickedAnswer<Option> => ({ option, probabilities, confidence: 1 });

// A decision built by hand: the given act, carrying `spell`, strafing left and leading the warlock.
function decisionWith(act: ActOption, spell: Element = "fire", overrides: Partial<DemonDecision> = {}): DemonDecision {
  return {
    move: picked("strafe_left"),
    spell: picked(spell, { fire: 0.2, frost: 0.3, earth: 0.5, [spell]: 0.6 }),
    act: picked(act),
    aim: picked("lead_warlock_movement"),
    ...overrides,
  };
}

function playDecision(start: World, decision: DemonDecision, steps: number) {
  let world = start;
  let memory = adoptDecision(emptyExecutorMemory, decision, world.timeMs);
  const events: SimEvent[] = [];
  const inputs: CasterInput[] = [];
  for (let step = 0; step < steps; step += 1) {
    const demonInput = decisionInput(memory, world) ?? idleInput(world.casters.warlock.position);
    inputs.push(demonInput);
    const result = stepWorld(world, { warlock: idleInput(world.casters.demon.position), demon: demonInput }, stepSeconds);
    world = result.world;
    memory = observeDemonEvents(memory, result.events);
    events.push(...result.events);
  }
  return { world, events, inputs, memory };
}

const hitsOnDemon = (events: readonly SimEvent[]) => events.filter((event): event is Extract<SimEvent, { type: "hit" }> => event.type === "hit" && event.casterId === "demon");

describe("executing decisions in the probe duel", () => {
  const probeWorld = buildProbeWorld();
  const flightSteps = Math.ceil(1 / stepSeconds);

  it("takes the fireball 1.5× when it just stands and waits with frost", () => {
    const hits = hitsOnDemon(playDecision(probeWorld, decisionWith("wait", "frost", { move: picked("hold") }), flightSteps).events);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ element: "fire", countered: true, blocked: false });
  });

  it("switches to fire and cloaks in time when told to cloak, whatever spell it was told to carry", () => {
    const played = playDecision(probeWorld, decisionWith("cloak", "earth", { move: picked("hold") }), flightSteps);
    expect(played.inputs[0]).toMatchObject({ carry: "fire", cloakHeld: true });
    const hits = hitsOnDemon(played.events);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ element: "fire", blocked: true, damage: 0 });
  });

  it("raises a cloak ahead of time against the spell the warlock carries when nothing is in flight", () => {
    const start = createWorld();
    const fresh: World = { ...start, casters: { ...start.casters, warlock: { ...start.casters.warlock, carried: "frost" } } };
    const input = decisionInput(adoptDecision(emptyExecutorMemory, decisionWith("cloak", "fire"), fresh.timeMs), fresh);
    expect(input).toMatchObject({ cloakHeld: true, carry: "frost" });
  });

  it("dashes once to its open left and escapes the blast", () => {
    const played = playDecision(probeWorld, decisionWith("dash_left", "frost"), flightSteps);
    const dashes = played.events.filter((event) => event.type === "dashed" && event.casterId === "demon");
    expect(dashes).toHaveLength(1);
    const frame = facingFrame(probeWorld.casters.demon, probeWorld.casters.warlock);
    expect(dot(played.inputs[0]!.move, frame.left)).toBeGreaterThan(0.9);
    expect(hitsOnDemon(played.events)).toEqual([]);
    expect(played.memory.active?.actDone).toBe(true);
  });

  it("casts the chosen spell once, or the ready spell Jev liked best when the chosen one is cooling down", () => {
    const fresh = createWorld();
    const casts = playDecision(fresh, decisionWith("cast", "frost"), 30).events.filter((event) => event.type === "projectileSpawned" && event.projectile.ownerId === "demon");
    expect(casts).toHaveLength(1);
    // Earth is on cooldown in the probe world; frost (0.3) beats fire (0.2) among the ready ones.
    const input = decisionInput(adoptDecision(emptyExecutorMemory, decisionWith("cast", "earth"), probeWorld.timeMs), probeWorld);
    expect(input).toMatchObject({ castHeld: true, carry: "frost" });
  });

  it("returns no input without a decision", () => {
    expect(decisionInput(emptyExecutorMemory, probeWorld)).toBeNull();
  });
});

describe("continuity between ticks", () => {
  const strafe = (option: "strafe_left" | "strafe_right", left: number, right: number) => picked(option, { strafe_left: left, strafe_right: right, hold: 1 - left - right });
  const adoptBoth = (first: DemonDecision, second: DemonDecision, gapMs: number) => adoptDecision(adoptDecision(emptyExecutorMemory, first, 0), second, gapMs);

  it("keeps its strafe side while Jev still rates it, and switches when Jev clearly prefers the other", () => {
    const left = decisionWith("wait", "fire", { move: strafe("strafe_left", 0.5, 0.4) });
    const nearTie = adoptBoth(left, decisionWith("wait", "fire", { move: strafe("strafe_right", 0.45, 0.5) }), 1000 - 1);
    expect(nearTie.active?.decision.move.option).toBe("strafe_left");
    const clear = adoptBoth(left, decisionWith("wait", "fire", { move: strafe("strafe_right", 0.1, 0.9) }), 200);
    expect(clear.active?.decision.move.option).toBe("strafe_right");
  });

  it("holds any other walk only briefly", () => {
    const advancing = decisionWith("wait", "fire", { move: picked("advance", { advance: 0.5, hold: 0.5 }) });
    const holdNext = decisionWith("wait", "fire", { move: picked("hold", { advance: 0.45, hold: 0.55 }) });
    expect(adoptBoth(advancing, holdNext, continuity.moveMinHoldMs - 1).active?.decision.move.option).toBe("advance");
    expect(adoptBoth(advancing, holdNext, continuity.moveMinHoldMs).active?.decision.move.option).toBe("hold");
  });

  it("keeps a fresh cloak over a wait, but never over a cast or a dash", () => {
    const cloaking = decisionWith("cloak", "fire", { act: picked("cloak", { cloak: 0.6, wait: 0.4 }) });
    const waitNext = decisionWith("wait", "fire", { act: picked("wait", { cloak: 0.4, wait: 0.6 }) });
    expect(adoptBoth(cloaking, waitNext, 200).active?.decision.act.option).toBe("cloak");
    expect(adoptBoth(cloaking, waitNext, continuity.cloakMinHoldMs).active?.decision.act.option).toBe("wait");
    const dashNext = decisionWith("dash_left", "fire", { act: picked("dash_left", { cloak: 0.45, dash_left: 0.55 }) });
    expect(adoptBoth(cloaking, dashNext, 200).active?.decision.act.option).toBe("dash_left");
  });

  it("starts fresh after the heuristic has taken over", () => {
    const left = decisionWith("wait", "fire", { move: strafe("strafe_left", 0.5, 0.4) });
    const later = adoptBoth(left, decisionWith("wait", "fire", { move: strafe("strafe_right", 0.45, 0.5) }), 5000);
    expect(later.active?.decision.move.option).toBe("strafe_right");
  });
});
