import { describe, expect, it } from "vitest";
import { describeDuel } from "../../src/jev/state.ts";
import type { ChoiceQuestion } from "../../src/jev/protocol.ts";
import { buildTickRequest, tickOptions, tickQuestions } from "../../src/jev/questions.ts";
import type { Caster, World } from "../../src/sim/types.ts";
import { vector } from "../../src/sim/vector.ts";
import { createWorld } from "../../src/sim/world.ts";
import { buildProbeRecent, buildProbeWorld, probeSituation } from "../fixtures/probeSituation.ts";

const withDemon = (changes: Partial<Caster>, world: World = createWorld()): World => ({ ...world, casters: { ...world.casters, demon: { ...world.casters.demon, ...changes } } });

describe("tick options", () => {
  it("offers everything on a fresh duel", () => {
    const options = tickOptions(createWorld());
    expect(options.move).toEqual(["advance", "back_off", "strafe_left", "strafe_right", "hold"]);
    expect(options.spell).toEqual(["fire", "frost", "earth"]);
    expect(options.act).toEqual(["cast", "cloak", "dash_left", "dash_right", "wait"]);
    expect(options.aim).toEqual(["straight_at_warlock", "lead_warlock_movement"]);
  });

  it("leaves out casting during the recovery or with every spell cooling down, and dashing on cooldown", () => {
    expect(tickOptions(withDemon({ recoveryRemainingMs: 1000 })).act).not.toContain("cast");
    expect(tickOptions(withDemon({ cooldownsMs: { fire: 2000, frost: 1000, earth: 3000 } })).act).not.toContain("cast");
    // While charging earth only a dash (which breaks the charge off) or waiting make sense.
    expect(tickOptions(withDemon({ charge: { remainingMs: 200, direction: vector(0, 1) } })).act).toEqual(["dash_left", "dash_right", "wait"]);
    expect(tickOptions(withDemon({ dashCooldownMs: 1000 })).act).toEqual(["cast", "cloak", "wait"]);
    // Almost ready counts: the answer arrives about a round trip later.
    expect(tickOptions(withDemon({ recoveryRemainingMs: 150, dashCooldownMs: 150 })).act).toEqual(["cast", "cloak", "dash_left", "dash_right", "wait"]);
  });

  it("only offers a dash toward an open side, unless both are closed", () => {
    expect(tickOptions(withDemon({ position: vector(-8.5, -2) })).act).toEqual(["cast", "cloak", "dash_left", "wait"]);
    // Squeezed at the edge with the warlock straight across the middle: both sides run along the rim.
    const start = createWorld();
    const pinned = withDemon({ position: vector(0, -9.9) }, { ...start, casters: { ...start.casters, warlock: { ...start.casters.warlock, position: vector(0, -7.5) } } });
    expect(tickOptions(pinned).act).toEqual(["cast", "cloak", "dash_left", "dash_right", "wait"]);
  });
});

// Every `field.path` a question names must exist in the state, or Jev is pointed at nothing.
function referencedPaths(question: ChoiceQuestion): string[] {
  const texts = [String(question.instructions), ...Object.values(question.criteria).map(String)];
  return texts.flatMap((text) => [...text.matchAll(/`([a-zA-Z.]+)`/g)].map((match) => match[1]!));
}

function resolvePath(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), state);
}

describe("tick questions", () => {
  const world = buildProbeWorld();
  const recent = buildProbeRecent(world);
  const { request } = buildTickRequest(world, recent);

  it("points only at fields that exist in the state", () => {
    const state = describeDuel(world, recent);
    // `cloakCanBlock` and `arrives` belong to items of the incoming lists.
    const itemFields = new Set(["cloakCanBlock", "arrives"]);
    for (const question of Object.values(request.questions) as ChoiceQuestion[]) {
      for (const path of referencedPaths(question)) {
        if (itemFields.has(path)) continue;
        expect(resolvePath(state, path), path).not.toBeUndefined();
      }
    }
  });

  it("asks one choice per decision with only the offered options", () => {
    const options = { move: ["advance", "hold"] as const, spell: ["fire"] as const, act: ["cloak", "wait"] as const, aim: ["straight_at_warlock", "lead_warlock_movement"] as const };
    const questions = tickQuestions(options);
    expect(Object.keys(questions)).toEqual(["demon_move", "demon_spell", "demon_act", "demon_aim"]);
    expect(Object.keys(questions.demon_act!.criteria)).toEqual(["cloak", "wait"]);
    expect(Object.keys(questions.demon_spell!.criteria)).toEqual(["fire"]);
  });

  it("matches the snapshot of the probe request", () => {
    expect(request.kind).toBe("tick");
    expect({ ...request, kind: "probe" }).toEqual(probeSituation);
    expect(request).toMatchSnapshot();
  });

  it("stays small", () => {
    // Roughly four characters per token; the plan budgets about 1.5k tokens per tick.
    expect(JSON.stringify(request).length / 4).toBeLessThan(1500);
  });
});
