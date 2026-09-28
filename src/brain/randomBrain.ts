import { config } from "../config.ts";
import { idleInput } from "../sim/caster.ts";
import { createRandom, nextRandom, randomBetween, type RandomState } from "../sim/random.ts";
import type { CasterInput, Element, World } from "../sim/types.ts";
import { elements } from "../sim/types.ts";
import { add, vector, zeroVector, type Vector2 } from "../sim/vector.ts";

// A baseline with no plan at all: every so often it re-rolls a direction, a spell and an action.
export type RandomBrainTuning = typeof config.randomBrain;

type RandomAction = "cast" | "cloak" | "dash" | "wait";
const actions: readonly RandomAction[] = ["cast", "cloak", "dash", "wait", "wait"];

export type RandomBrainMemory = {
  readonly random: RandomState;
  readonly nextRollAtMs: number;
  readonly move: Vector2;
  readonly carry: Element;
  readonly action: RandomAction;
  readonly aimOffset: Vector2;
  readonly acted: boolean;
};

export function createRandomBrainMemory(seed: number = config.randomBrain.seed): RandomBrainMemory {
  return { random: createRandom(seed), nextRollAtMs: 0, move: zeroVector, carry: "fire", action: "wait", aimOffset: zeroVector, acted: false };
}

function pickFrom<Item>(items: readonly Item[], random: RandomState): [Item, RandomState] {
  const [value, nextState] = nextRandom(random);
  return [items[Math.min(items.length - 1, Math.floor(value * items.length))]!, nextState];
}

function reroll(memory: RandomBrainMemory, nowMs: number, tuning: RandomBrainTuning): RandomBrainMemory {
  const [holdMs, afterHold] = randomBetween(memory.random, tuning.minHoldMs, tuning.maxHoldMs);
  const [angle, afterAngle] = randomBetween(afterHold, 0, Math.PI * 2);
  const [still, afterStill] = nextRandom(afterAngle);
  const [carry, afterCarry] = pickFrom(elements, afterStill);
  const [action, afterAction] = pickFrom(actions, afterCarry);
  const [offsetX, afterOffsetX] = randomBetween(afterAction, -2, 2);
  const [offsetZ, afterOffsetZ] = randomBetween(afterOffsetX, -2, 2);
  return {
    random: afterOffsetZ,
    nextRollAtMs: nowMs + holdMs,
    move: still < 0.2 ? zeroVector : vector(Math.cos(angle), Math.sin(angle)),
    carry,
    action,
    aimOffset: vector(offsetX, offsetZ),
    acted: false,
  };
}

export function randomDemonInput(world: World, memory: RandomBrainMemory, tuning: RandomBrainTuning = config.randomBrain): { input: CasterInput; memory: RandomBrainMemory } {
  const target = world.casters.warlock;
  if (world.round.phase !== "fighting") return { input: idleInput(target.position), memory };
  const current = world.timeMs >= memory.nextRollAtMs ? reroll(memory, world.timeMs, tuning) : memory;
  const oneShot = (current.action === "cast" || current.action === "dash") && !current.acted;
  return {
    input: {
      move: current.move,
      aimPoint: add(target.position, current.aimOffset),
      castHeld: current.action === "cast" && oneShot,
      castPressed: false,
      cloakHeld: current.action === "cloak",
      dashPressed: current.action === "dash" && oneShot,
      carry: current.carry,
    },
    // A dash press is used at once; a held cast stays held until the roll ends, so it fires once the spell is ready.
    memory: current.action === "dash" ? { ...current, acted: true } : current,
  };
}
