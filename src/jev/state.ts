import { config } from "../config.ts";
import { isFrozen, isOffCooldown } from "../sim/caster.ts";
import { findThreats } from "../sim/threats.ts";
import type { Caster, Element, SimTuning, World } from "../sim/types.ts";
import { beatenBy, beats, elements } from "../sim/types.ts";
import { distance, dot, length } from "../sim/vector.ts";
import {
  aimBucket,
  arrivalBucket,
  distanceBucket,
  healthBucket,
  positionBucket,
  type ArrivalBucket,
  type DescribeTuning,
  type DistanceBucket,
  type HealthBucket,
  type PositionBucket,
} from "./describe/buckets.ts";
import { aimOffsetDegrees, facingFrame, isSideOpen, sideOf } from "./describe/geometry.ts";
import type { RecentActions } from "./describe/recent.ts";

// What Jev sees: the duel from the demon's side, in words and buckets. Jev is weak at numbers, distances and
// multi-step reasoning, so there are no coordinates or timers here. All the maths happens in code (describe/),
// and the counter triangle arrives already worked out. The criteria in questions.ts refer to these field names.

export type IncomingDescription = {
  element: Element;
  arrives: ArrivalBucket;
  cloakCanBlock: string;
};

export type DuelSituation = {
  // The opponent, as a watchful human would see it: its orb and its moves, but not its hidden timers.
  warlock: {
    health: HealthBucket;
    carrying: string;
    cloak: string;
    movement: string;
    status: string;
    // Weaknesses a watchful human would read off the last cast and dash, knowing the rules.
    openings: string;
  };
  // The mage Jev controls, including its own cooldowns.
  demon: {
    health: HealthBucket;
    carrying: string;
    canCast: string;
    onCooldown: string[];
    cloak: string;
    position: PositionBucket;
    openSides: string;
  };
  // Range, the warlock's aim, and attacks in flight toward the demon.
  between: {
    distance: DistanceBucket;
    warlockAim: string;
    incomingToDemon: IncomingDescription[];
  };
  // The counter triangle worked out in code, so Jev never has to chain "a beats b" itself.
  // "Weak to x": attacks of element x hit that mage 1.5× harder.
  counters: {
    warlockWeakTo: Element;
    demonHasWarlockWeaknessReady: "yes" | "no";
    riskyForDemonToCarry: Element;
    // The one element the warlock's cloak (up or raising) stops; the other two go through.
    warlockCloakBlocks: Element | "nothing";
  };
  round: string;
};

function describeCarrying(caster: Caster): string {
  return caster.switchRemainingMs > 0 ? `${caster.carried} (switching, can't cast it yet)` : caster.carried;
}

function describeCloak(caster: Caster): string {
  if (caster.cloak.phase === "none") return "no cloak up";
  if (caster.cloak.phase === "raising") return `raising a ${caster.cloak.guards} cloak (not blocking yet)`;
  return `${caster.cloak.guards} cloak up`;
}

// The opponent's cloak says what it doesn't stop, so Jev doesn't read any cloak as "the warlock is safe".
function describeOpponentCloak(caster: Caster): string {
  if (caster.cloak.phase === "none") return "no cloak up";
  const guards = caster.cloak.guards;
  const others = elements.filter((element) => element !== guards).join(" and ");
  const state = caster.cloak.phase === "raising" ? `raising a ${guards} cloak` : `${guards} cloak up`;
  return `${state}: blocks only ${guards} (${others} go through), and it can't cast while cloaked`;
}

function describeStatus(caster: Caster): string {
  if (!caster.alive) return "defeated";
  if (isFrozen(caster)) return "frozen, can't act";
  const conditions = [
    caster.charge ? "rooted while charging an earthspike" : null,
    caster.burnRemainingMs > 0 ? "burning" : null,
  ].filter((condition): condition is string => condition !== null);
  return conditions.length ? conditions.join(", ") : "normal";
}

const readySpells = (caster: Caster): Element[] => elements.filter((element) => isOffCooldown(caster, element));

function describeDemonCanCast(demon: Caster, tuning: DescribeTuning): string {
  if (demon.charge) return "charging an earthspike now";
  const waitMs = Math.max(demon.recoveryRemainingMs, demon.switchRemainingMs, demon.cooldownsMs[demon.carried]);
  if (waitMs === 0) return `now (${demon.carried})`;
  if (waitMs <= tuning.castSoonMs) return `in a moment (${demon.carried})`;
  return demon.cooldownsMs[demon.carried] > demon.recoveryRemainingMs ? `not soon: ${demon.carried} is on cooldown` : "not yet: recovering from its last cast";
}

// Not the hidden timers: the known recovery and dash cooldown, counted from the cast and dash it saw.
function describeWarlockOpenings(recent: RecentActions, nowMs: number, simTuning: SimTuning): string {
  const lastCastMs = recent.lastCast?.atMs;
  const openings = [
    lastCastMs !== undefined && nowMs - lastCastMs < simTuning.castRecoveryMs ? "just cast, so it can't cast again yet" : null,
    recent.lastDashAtMs !== null && nowMs - recent.lastDashAtMs < simTuning.dash.cooldownMs ? "just dashed, so it can't dash again yet" : null,
  ].filter((opening): opening is string => opening !== null);
  return openings.length ? openings.join("; ") : "none";
}

function describeMovement(warlock: Caster, demon: Caster, tuning: DescribeTuning): string {
  const frame = facingFrame(warlock, demon);
  const velocity = warlock.velocity;
  if (warlock.dashRemainingMs > 0) return `dashing to their ${sideOf(frame, velocity)}`;
  if (length(velocity) < tuning.movingSpeed) return "standing still";
  const forward = dot(velocity, frame.forward);
  const sideways = dot(velocity, frame.left);
  if (Math.abs(forward) >= Math.abs(sideways)) return forward > 0 ? "walking toward the demon" : "backing away from the demon";
  return `strafing to their ${sideways > 0 ? "left" : "right"}`;
}

function describeOpenSides(demon: Caster, warlock: Caster, simTuning: SimTuning, tuning: DescribeTuning): string {
  const frame = facingFrame(demon, warlock);
  const leftOpen = isSideOpen(demon, frame, "left", simTuning, tuning);
  const rightOpen = isSideOpen(demon, frame, "right", simTuning, tuning);
  if (leftOpen && rightOpen) return "both sides are open";
  if (leftOpen) return "left is open; right is near the arena edge";
  if (rightOpen) return "right is open; left is near the arena edge";
  return "both sides are near the arena edge";
}

// Whether the target's cloak could stop this attack: it must guard the same element and be fully up in time.
// Raising takes the wind-up, and a decision arrives about one brain round trip after this description;
// the slow (p95) round trip is budgeted so a "yes" rarely turns out too late.
// Switching doesn't delay the cloak (it re-forms at once around the new spell), so a switch still says yes.
function describeCloakCanBlock(target: Caster, element: Element, secondsToImpact: number, simTuning: SimTuning): string {
  if (target.cloak.phase === "up" && target.cloak.guards === element) return "yes, the cloak is already up";
  const neededMs = simTuning.cloak.windUpMs + (config.brain.measuredLatencyP95Ms);
  if (secondsToImpact * 1000 < neededMs) return "no, too late to cloak";
  return target.carried === element ? "yes, if it cloaks now" : `yes, if it cloaks now (switching to ${element} costs no time)`;
}

function describeIncoming(world: World, target: Caster, simTuning: SimTuning, tuning: DescribeTuning): IncomingDescription[] {
  return findThreats(world, target, tuning.threatWindowSeconds, simTuning).map((threat) => ({
    element: threat.element,
    arrives: arrivalBucket(threat.secondsToImpact, tuning),
    cloakCanBlock: describeCloakCanBlock(target, threat.element, threat.secondsToImpact, simTuning),
  }));
}

// The score, who is ahead in this round, and match point: what the demon is playing for.
function describeRound(world: World, simTuning: SimTuning, tuning: DescribeTuning): string {
  const bestOf = simTuning.roundsToWinMatch * 2 - 1;
  const { warlock, demon } = world.round.wins;
  const score = warlock === demon ? `tied ${warlock}–${demon}` : warlock > demon ? `warlock leads ${warlock}–${demon}` : `demon leads ${demon}–${warlock}`;
  const healthGap = world.casters.demon.health - world.casters.warlock.health;
  const leadMargin = simTuning.caster.maxHealth * tuning.healthLeadFraction;
  const health = healthGap > leadMargin ? "demon ahead on health" : healthGap < -leadMargin ? "warlock ahead on health" : "even on health";
  const matchPoint = (["demon", "warlock"] as const).filter((casterId) => world.round.wins[casterId] === simTuning.roundsToWinMatch - 1).map((casterId) => `match point for ${casterId}`);
  return [`round ${world.round.number} of ${bestOf}`, score, health, ...matchPoint].join("; ");
}

export function describeDuel(world: World, recent: RecentActions, simTuning: SimTuning = config.sim, tuning: DescribeTuning = config.brain.describe): DuelSituation {
  const { warlock, demon } = world.casters;
  const maxHealth = simTuning.caster.maxHealth;
  const demonReady = readySpells(demon);
  const demonDashReady = demon.dashCooldownMs === 0;
  const counterToWarlock = beatenBy[warlock.carried];

  return {
    warlock: {
      health: healthBucket(warlock.health, maxHealth, tuning),
      carrying: describeCarrying(warlock),
      cloak: describeOpponentCloak(warlock),
      movement: describeMovement(warlock, demon, tuning),
      status: describeStatus(warlock),
      openings: describeWarlockOpenings(recent, world.timeMs, simTuning),
    },
    demon: {
      health: healthBucket(demon.health, maxHealth, tuning),
      carrying: describeCarrying(demon),
      canCast: describeDemonCanCast(demon, tuning),
      onCooldown: [...elements.filter((element) => !demonReady.includes(element)), ...(demonDashReady ? [] : ["dash"])],
      cloak: describeCloak(demon),
      position: positionBucket(length(demon.position), simTuning.arenaRadius, tuning),
      openSides: describeOpenSides(demon, warlock, simTuning, tuning),
    },
    between: {
      distance: distanceBucket(distance(warlock.position, demon.position), tuning),
      warlockAim: `${aimBucket(aimOffsetDegrees(warlock, demon), tuning)} the demon`,
      incomingToDemon: describeIncoming(world, demon, simTuning, tuning),
    },
    counters: {
      warlockWeakTo: counterToWarlock,
      demonHasWarlockWeaknessReady: isOffCooldown(demon, counterToWarlock) ? "yes" : "no",
      riskyForDemonToCarry: beats[warlock.carried],
      warlockCloakBlocks: warlock.cloak.phase === "none" ? "nothing" : warlock.cloak.guards,
    },
    round: describeRound(world, simTuning, tuning),
  };
}
