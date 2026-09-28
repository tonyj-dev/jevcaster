import { config } from "../config.ts";
import { canCastSoon, idleInput, isFrozen, isOffCooldown } from "../sim/caster.ts";
import { createRandom, nextRandom, randomBetween, type RandomState } from "../sim/random.ts";
import { aimPointFor, findThreats } from "../sim/threats.ts";
import type { Caster, CasterInput, Element, SimTuning, World } from "../sim/types.ts";
import { beats, elements } from "../sim/types.ts";
import { add, distance, dot, length, normalize, perpendicular, scale, subtract, vector, zeroVector, type Vector2 } from "../sim/vector.ts";

// The hand-written demon: the baseline Jev is compared against (F1), and the fallback whenever Jev has no fresh
// decision (no answer yet, offline, backing off). It reads the world directly instead of the words Jev gets.

export type HeuristicTuning = typeof config.heuristicBrain;

type Reaction =
  | { readonly kind: "dodge"; readonly threatKey: string; readonly direction: Vector2 }
  | { readonly kind: "cloak"; readonly threatKey: string; readonly carry: Element };

export type HeuristicMemory = {
  readonly random: RandomState;
  readonly strafeSign: 1 | -1;
  readonly nextStrafeFlipAtMs: number;
  readonly noticedAtMs: Readonly<Record<string, number>>;
  readonly ignoredThreatKeys: readonly string[];
  readonly reaction: Reaction | null;
  readonly plannedElement: Element | null;
  readonly aimError: Vector2;
};

export function createHeuristicMemory(seed: number = config.heuristicBrain.seed): HeuristicMemory {
  return { random: createRandom(seed), strafeSign: 1, nextStrafeFlipAtMs: 0, noticedAtMs: {}, ignoredThreatKeys: [], reaction: null, plannedElement: null, aimError: zeroVector };
}

// Sidestep across the threat's path, toward whichever side keeps the demon away from the arena edge.
function dodgeDirection(travelDirection: Vector2, self: Caster): Vector2 {
  const side = normalize(perpendicular(travelDirection));
  return dot(side, scale(self.position, -1)) >= 0 ? side : scale(side, -1);
}

function positioningMove(self: Caster, target: Caster, strafeSign: 1 | -1, tuning: HeuristicTuning, simTuning: SimTuning): Vector2 {
  const toTarget = subtract(target.position, self.position);
  const gap = length(toTarget);
  const forward = normalize(toTarget);
  const rangeCorrection = gap > tuning.preferredDistance + tuning.distanceTolerance ? 1 : gap < tuning.preferredDistance - tuning.distanceTolerance ? -1 : 0;
  const strafe = scale(perpendicular(forward), strafeSign * tuning.strafeWeight);
  const edgeProximity = length(self.position) / simTuning.arenaRadius;
  const edgePull = edgeProximity > 0.75 ? scale(normalize(scale(self.position, -1)), (edgeProximity - 0.75) * 6) : zeroVector;
  const combined = add(add(scale(forward, rangeCorrection), scale(strafe, rangeCorrection === 0 ? 1 : 0.5)), edgePull);
  return length(combined) > 1 ? normalize(combined) : combined;
}

// How much the demon likes casting `element` at a target carrying `targetElement`: more when it counters
// what the target carries, less when carrying it would expose the demon to the target's attack.
export function elementWeight(element: Element, targetElement: Element, tuning: HeuristicTuning): number {
  const counters = beats[element] === targetElement ? tuning.counterPreference : 1;
  const exposed = beats[targetElement] === element ? tuning.exposedPreference : 1;
  return tuning.spellWeights[element] * counters * exposed;
}

// Picks what to cast next: earth on a frozen target when available, otherwise a weighted roll
// over spells that are off cooldown and make sense at the current range.
function chooseElement(self: Caster, target: Caster, roll: number, tuning: HeuristicTuning, simTuning: SimTuning): Element | null {
  const gap = distance(self.position, target.position);
  const inRange = (element: Element): boolean => element !== "earth" || gap <= simTuning.spells.earth.range * 0.9;
  if (isFrozen(target) && isOffCooldown(self, "earth") && inRange("earth")) return "earth";

  const candidates = elements.filter((element) => isOffCooldown(self, element) && inRange(element));
  const weights = candidates.map((element) => elementWeight(element, target.carried, tuning));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let threshold = roll * totalWeight;
  for (const [index, element] of candidates.entries()) {
    threshold -= weights[index]!;
    if (threshold <= 0) return element;
  }
  return candidates[0] ?? null;
}

export function heuristicDemonInput(
  world: World,
  memory: HeuristicMemory,
  tuning: HeuristicTuning = config.heuristicBrain,
  simTuning: SimTuning = config.sim,
): { input: CasterInput; memory: HeuristicMemory } {
  const self = world.casters.demon;
  const target = world.casters.warlock;
  if (world.round.phase !== "fighting" || !self.alive || isFrozen(self)) {
    return { input: idleInput(target.position), memory: { ...memory, reaction: null, noticedAtMs: {}, plannedElement: null } };
  }

  let random = memory.random;
  const roll = (): number => {
    const [value, nextState] = nextRandom(random);
    random = nextState;
    return value;
  };

  // Strafe direction flips at random intervals so the demon isn't a metronome.
  let strafeSign = memory.strafeSign;
  let nextStrafeFlipAtMs = memory.nextStrafeFlipAtMs;
  if (world.timeMs >= nextStrafeFlipAtMs) {
    const [flipDelay, afterDelay] = randomBetween(random, tuning.strafeFlipMinMs, tuning.strafeFlipMaxMs);
    random = afterDelay;
    strafeSign = strafeSign === 1 ? -1 : 1;
    nextStrafeFlipAtMs = world.timeMs + flipDelay;
  }

  // Threats become actionable only after the reaction delay, like a person noticing a shot.
  const threats = findThreats(world, self, tuning.threatWindowSeconds, simTuning);
  const liveKeys = new Set(threats.map((threat) => threat.key));
  const noticedAtMs: Record<string, number> = Object.fromEntries([
    ...Object.entries(memory.noticedAtMs).filter(([key]) => liveKeys.has(key)),
    ...threats.filter((threat) => memory.noticedAtMs[threat.key] === undefined).map((threat) => [threat.key, world.timeMs]),
  ]);
  let ignoredThreatKeys = memory.ignoredThreatKeys.filter((key) => liveKeys.has(key));

  let reaction = memory.reaction && liveKeys.has(memory.reaction.threatKey) ? memory.reaction : null;
  const reactable = threats.find(
    (threat) => world.timeMs - (noticedAtMs[threat.key] ?? world.timeMs) >= tuning.reactionDelayMs && !ignoredThreatKeys.includes(threat.key),
  );
  if (!reaction && reactable) {
    const choice = roll();
    if (choice < tuning.dodgeChance) {
      reaction = { kind: "dodge", threatKey: reactable.key, direction: dodgeDirection(reactable.travelDirection, self) };
    } else if (choice < tuning.dodgeChance + tuning.cloakChance) {
      // Only the cloak of the same element blocks it.
      reaction = { kind: "cloak", threatKey: reactable.key, carry: reactable.element };
    } else {
      ignoredThreatKeys = [...ignoredThreatKeys, reactable.key];
    }
  }

  const reactedThreat = reaction ? threats.find((threat) => threat.key === reaction?.threatKey) : undefined;
  const dashReady = self.dashCooldownMs === 0 && self.dashRemainingMs === 0;
  const dodgeDash = reaction?.kind === "dodge" && reactedThreat !== undefined && reactedThreat.secondsToImpact <= tuning.dashThreatWindowSeconds;
  const dashPressed = dashReady && dodgeDash;

  const move = reaction?.kind === "dodge" ? reaction.direction : positioningMove(self, target, strafeSign, tuning, simTuning);

  // Cloaking: carry the threat's element so its cloak guards against it (it can't block until the switch and wind-up finish), then hold it.
  if (reaction?.kind === "cloak") {
    return {
      input: { move, aimPoint: target.position, castHeld: false, castPressed: false, cloakHeld: true, dashPressed: false, carry: reaction.carry },
      memory: { random, strafeSign, nextStrafeFlipAtMs, noticedAtMs, ignoredThreatKeys, reaction, plannedElement: memory.plannedElement, aimError: memory.aimError },
    };
  }

  // Casting is a per-second rate. The demon first carries the planned element, then fires once the switch settles.
  let plannedElement = memory.plannedElement;
  let aimError = memory.aimError;
  const stepSeconds = 1 / simTuning.stepHz;
  if (!plannedElement && !reaction && !self.charge && roll() < tuning.castChancePerSecond * stepSeconds) {
    plannedElement = chooseElement(self, target, roll(), tuning, simTuning);
    const [errorX, afterErrorX] = randomBetween(random, -tuning.aimErrorMeters, tuning.aimErrorMeters);
    const [errorZ, afterErrorZ] = randomBetween(afterErrorX, -tuning.aimErrorMeters, tuning.aimErrorMeters);
    random = afterErrorZ;
    aimError = vector(errorX, errorZ);
  }
  const readyToCast = plannedElement !== null && self.carried === plannedElement && self.switchRemainingMs === 0 && canCastSoon(self, plannedElement);
  const castHeld = readyToCast && !reaction && !dashPressed;
  const aimElement = plannedElement ?? self.carried;

  return {
    input: {
      move,
      aimPoint: add(aimPointFor(aimElement, self, target, simTuning), aimError),
      castHeld,
      castPressed: false,
      cloakHeld: false,
      dashPressed,
      carry: plannedElement,
    },
    memory: { random, strafeSign, nextStrafeFlipAtMs, noticedAtMs, ignoredThreatKeys, reaction, plannedElement: castHeld ? null : plannedElement, aimError },
  };
}
