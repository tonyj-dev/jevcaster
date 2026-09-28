import { config } from "../config.ts";
import { clampToArena, createCaster, stepCaster, type SpikeRequest } from "./caster.ts";
import { resolveSpikes, separateCasters, stepBurn, stepProjectiles } from "./combat.ts";
import type { Caster, CasterId, CasterInput, Projectile, RoundState, SimEvent, SimTuning, StepResult, World } from "./types.ts";

export type Inputs = Readonly<Record<CasterId, CasterInput>>;

export function createWorld(tuning: SimTuning = config.sim): World {
  return {
    tick: 0,
    timeMs: 0,
    casters: { warlock: createCaster("warlock", tuning), demon: createCaster("demon", tuning) },
    projectiles: [],
    nextEntityId: 1,
    round: { number: 1, wins: { warlock: 0, demon: 0 }, phase: "fighting", winner: null, phaseElapsedMs: 0 },
  };
}

// Pure: the same world, inputs and delta always give the same result.
export function stepWorld(world: World, inputs: Inputs, deltaSeconds: number, tuning: SimTuning = config.sim): StepResult {
  const deltaMs = deltaSeconds * 1000;
  const fighting = world.round.phase === "fighting";
  const events: SimEvent[] = [];

  let nextEntityId = world.nextEntityId;
  const spawned: Projectile[] = [];
  const spikeLines: SpikeRequest[] = [];
  const stepOne = (caster: Caster): Caster => {
    if (!fighting) return caster;
    const result = stepCaster(caster, inputs[caster.id], deltaSeconds, tuning, nextEntityId);
    if (result.spawned) {
      spawned.push(result.spawned);
      nextEntityId += 1;
    }
    if (result.spikeLine) spikeLines.push(result.spikeLine);
    events.push(...result.events);
    return result.caster;
  };
  const movedCasters = separateCasters({ warlock: stepOne(world.casters.warlock), demon: stepOne(world.casters.demon) }, tuning);

  const projectileStep = stepProjectiles(movedCasters, world.projectiles, deltaSeconds, tuning, fighting);
  events.push(...projectileStep.events);

  const spikeStep = resolveSpikes(projectileStep.casters, spikeLines, tuning, fighting);
  events.push(...spikeStep.events);

  const settledCasters = {
    warlock: settle(spikeStep.casters.warlock, fighting, deltaSeconds, tuning),
    demon: settle(spikeStep.casters.demon, fighting, deltaSeconds, tuning),
  };

  const steppedWorld: World = {
    ...world,
    tick: world.tick + 1,
    timeMs: world.timeMs + deltaMs,
    casters: settledCasters,
    projectiles: [...projectileStep.projectiles, ...spawned],
    nextEntityId,
    round: { ...world.round, phaseElapsedMs: world.round.phaseElapsedMs + deltaMs },
  };
  const rounded = advanceRound(world, steppedWorld, tuning);
  return { world: rounded.world, events: [...events, ...rounded.events] };
}

function settle(caster: Caster, fighting: boolean, deltaSeconds: number, tuning: SimTuning): Caster {
  const burned = fighting ? stepBurn(caster, deltaSeconds, tuning) : caster;
  return { ...burned, position: clampToArena(burned.position, tuning) };
}

function advanceRound(previous: World, current: World, tuning: SimTuning): StepResult {
  const round = current.round;
  if (round.phase === "fighting") {
    const deaths: SimEvent[] = Object.values(current.casters)
      .filter((caster) => !caster.alive && previous.casters[caster.id].alive)
      .map((caster) => ({ type: "casterDied", casterId: caster.id, position: caster.position }));
    const { warlock, demon } = current.casters;
    if (warlock.alive && demon.alive) return { world: current, events: deaths };
    // A double knockout goes to the demon: the house wins ties.
    const winner: CasterId = warlock.alive ? "warlock" : "demon";
    const endedRound: RoundState = { ...round, phase: "ended", winner, phaseElapsedMs: 0, wins: { ...round.wins, [winner]: round.wins[winner] + 1 } };
    return { world: { ...current, round: endedRound }, events: [...deaths, { type: "roundEnded", winner, round: round.number }] };
  }

  if (round.phaseElapsedMs < tuning.roundResetDelayMs) return { world: current, events: [] };
  const matchOver = Math.max(round.wins.warlock, round.wins.demon) >= tuning.roundsToWinMatch;
  const nextRound: RoundState = matchOver
    ? { number: 1, wins: { warlock: 0, demon: 0 }, phase: "fighting", winner: null, phaseElapsedMs: 0 }
    : { ...round, number: round.number + 1, phase: "fighting", winner: null, phaseElapsedMs: 0 };
  const resetWorld: World = {
    ...current,
    casters: { warlock: createCaster("warlock", tuning), demon: createCaster("demon", tuning) },
    projectiles: [],
    round: nextRound,
  };
  return { world: resetWorld, events: [{ type: "roundStarted", round: nextRound.number }] };
}
