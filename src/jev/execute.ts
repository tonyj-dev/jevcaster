import { config } from "../config.ts";
import { aimPointFor, findThreats } from "../sim/threats.ts";
import type { CasterInput, Element, SimEvent, SimTuning, World } from "../sim/types.ts";
import { elements } from "../sim/types.ts";
import { add, length, normalize, scale, zeroVector, type Vector2 } from "../sim/vector.ts";
import { moveFamilies, type DemonDecision, type PickedAnswer } from "./decide.ts";
import { facingFrame, sideDirection } from "./describe/geometry.ts";
import type { AimOption, MoveOption } from "./questions.ts";

// DemonDecision → the demon's CasterInput, every sim step (60 Hz) until a fresher decision arrives (~5 per second).
// This is where Jev's words become game actions:
//
//   demon_move  → input.move       a direction in the demon's own frame (toward, away from or beside the warlock)
//   demon_spell → input.carry      the spell it holds, unless the act needs another one (see below)
//   demon_act   → castHeld | cloakHeld | dashPressed, once per decision for a cast or a dash
//   demon_aim   → input.aimPoint   worked out in code from positions and speeds; Jev never sees coordinates
//
// The memory also smooths between ticks, so near ties don't flip-flop.

export type ContinuityTuning = typeof config.brain.continuity;

export type ActiveDecision = {
  readonly decision: DemonDecision;
  readonly appliedAtMs: number;
  // A cast or dash happens once per decision; afterwards the demon just keeps moving.
  readonly actDone: boolean;
};

export type ExecutorMemory = {
  readonly active: ActiveDecision | null;
  // When the current walk and the current cloak began, for the minimum holds.
  readonly moveSinceMs: number;
  readonly cloakSinceMs: number;
};

export const emptyExecutorMemory: ExecutorMemory = {
  active: null,
  moveSinceMs: Number.NEGATIVE_INFINITY,
  cloakSinceMs: Number.NEGATIVE_INFINITY,
};

// Makes a fresh decision the active one, keeping continuity with the last.
export function adoptDecision(memory: ExecutorMemory, incoming: DemonDecision, nowMs: number, tuning: ContinuityTuning = config.brain.continuity): ExecutorMemory {
  // A decision the heuristic has since taken over from is too old to continue.
  const previous = memory.active && nowMs - memory.active.appliedAtMs <= config.brain.duelTick.decisionExpiryMs ? memory.active.decision : null;
  const decision = previous ? withContinuity(previous, incoming, memory, nowMs, tuning) : incoming;
  const moveSinceMs = previous?.move.option === decision.move.option ? memory.moveSinceMs : nowMs;
  const cloakSinceMs = decision.act.option !== "cloak" ? Number.NEGATIVE_INFINITY : previous?.act.option === "cloak" ? memory.cloakSinceMs : nowMs;
  return { ...memory, active: { decision, appliedAtMs: nowMs, actDone: false }, moveSinceMs, cloakSinceMs };
}

// Settles near ties toward what the demon is already doing. Only options Jev still rates at keepShare or more
// are kept, so this never picks something Jev dislikes; it just stops fresh picks from flip-flopping.
function withContinuity(previous: DemonDecision, next: DemonDecision, memory: ExecutorMemory, nowMs: number, tuning: ContinuityTuning): DemonDecision {
  const stillRated = (answer: PickedAnswer<string>, option: string) => (answer.probabilities[option] ?? 0) >= tuning.keepShare;
  const currentMove = previous.move.option;
  const flipsStrafeSide = moveFamilies[currentMove] === "strafe" && moveFamilies[next.move.option] === "strafe";
  const moveTooSoon = nowMs - memory.moveSinceMs < tuning.moveMinHoldMs;
  const keepMove = next.move.option !== currentMove && stillRated(next.move, currentMove) && (flipsStrafeSide || moveTooSoon);
  // Only "wait" gives way to a held cloak: a cast or a dash is a real decision to drop it.
  const keepCloak = previous.act.option === "cloak" && next.act.option === "wait" && stillRated(next.act, "cloak") && nowMs - memory.cloakSinceMs < tuning.cloakMinHoldMs;
  return {
    ...next,
    move: keepMove ? { ...next.move, option: currentMove } : next.move,
    act: keepCloak ? { ...next.act, option: "cloak" } : next.act,
  };
}

// Marks the decided cast or dash as done once the sim reports it.
export function observeDemonEvents(memory: ExecutorMemory, events: readonly SimEvent[]): ExecutorMemory {
  const active = memory.active;
  if (!active || active.actDone) return memory;
  const act = active.decision.act.option;
  const done = events.some(
    (event) =>
      (act === "cast" && ((event.type === "projectileSpawned" && event.projectile.ownerId === "demon") || (event.type === "earthCharging" && event.casterId === "demon"))) ||
      ((act === "dash_left" || act === "dash_right") && event.type === "dashed" && event.casterId === "demon"),
  );
  return done ? { ...memory, active: { ...active, actDone: true } } : memory;
}

// Turns the active decision into this step's input. Null when there is no decision to follow.
export function decisionInput(memory: ExecutorMemory, world: World, simTuning: SimTuning = config.sim): CasterInput | null {
  const active = memory.active;
  if (!active) return null;
  const { decision, actDone } = active;
  const demon = world.casters.demon;
  const act = decision.act.option;

  const carry = act === "cloak" ? cloakElement(world, simTuning) : act === "cast" && !actDone ? castElement(world, decision.spell, config.brain.describe.castSoonMs) : decision.spell.option;
  const dashing = (act === "dash_left" || act === "dash_right") && !actDone && demon.dashCooldownMs === 0 && demon.dashRemainingMs === 0;
  const move = dashing ? sideDirection(facingFrame(demon, world.casters.warlock), act === "dash_left" ? "left" : "right") : withEdgePull(moveDirection(decision.move.option, world), demon.position, simTuning);

  return {
    move,
    aimPoint: aimPoint(decision.aim.option, demon.carried, world, simTuning),
    castHeld: act === "cast" && !actDone,
    castPressed: false,
    cloakHeld: act === "cloak",
    dashPressed: dashing,
    carry,
  };
}

function moveDirection(move: MoveOption, world: World): Vector2 {
  const frame = facingFrame(world.casters.demon, world.casters.warlock);
  if (move === "advance") return frame.forward;
  if (move === "back_off") return scale(frame.forward, -1);
  if (move === "strafe_left") return sideDirection(frame, "left");
  if (move === "strafe_right") return sideDirection(frame, "right");
  return zeroVector;
}

// Near the edge, bend the walk back toward the middle so strafing and backing off don't grind along the rim.
function withEdgePull(move: Vector2, position: Vector2, simTuning: SimTuning): Vector2 {
  const edgeProximity = length(position) / simTuning.arenaRadius;
  if (edgeProximity <= 0.8) return move;
  const pulled = add(move, scale(normalize(scale(position, -1)), (edgeProximity - 0.8) * 5));
  return length(pulled) > 1 ? normalize(pulled) : pulled;
}

// Cloaking means guarding against what is actually coming: the soonest threat that a cloak can still stop.
// With nothing in flight it is a cloak raised ahead of time, so it guards against the spell the warlock carries.
function cloakElement(world: World, simTuning: SimTuning): Element {
  const demon = world.casters.demon;
  const threats = findThreats(world, demon, config.brain.describe.threatWindowSeconds, simTuning);
  const blockable = threats.find((threat) => threat.secondsToImpact * 1000 >= simTuning.cloak.windUpMs || (demon.cloak.phase === "up" && demon.cloak.guards === threat.element));
  return blockable?.element ?? threats[0]?.element ?? world.casters.warlock.carried;
}

// Casting means casting now: if the chosen spell isn't ready, take the ready one Jev liked best.
function castElement(world: World, spell: PickedAnswer<Element>, soonMs: number): Element {
  const demon = world.casters.demon;
  const ready = elements.filter((element) => demon.cooldownsMs[element] <= soonMs);
  if (ready.includes(spell.option) || ready.length === 0) return spell.option;
  return ready.reduce((best, element) => ((spell.probabilities[element] ?? 0) > (spell.probabilities[best] ?? 0) ? element : best));
}

function aimPoint(aim: AimOption, element: Element, world: World, simTuning: SimTuning): Vector2 {
  const { warlock, demon } = world.casters;
  if (aim === "straight_at_warlock") return warlock.position;
  return aimPointFor(element, demon, warlock, simTuning);
}
