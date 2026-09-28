import { config } from "../config.ts";
import type { Caster, Element, SimTuning, World } from "../sim/types.ts";
import { elements } from "../sim/types.ts";
import type { DescribeTuning } from "./describe/buckets.ts";
import { facingFrame, isSideOpen, type Side } from "./describe/geometry.ts";
import type { RecentActions } from "./describe/recent.ts";
import type { BrainRequest, ChoiceQuestion } from "./protocol.ts";
import { describeDuel } from "./state.ts";

// The four questions Jev answers about the demon every tick (about five a second), next to the duel state (state.ts).
// Each is a multiple choice; every option carries a short criterion saying when it is the right call, written against
// the fields of the state. Jev returns a probability per option, decide.ts picks the top one, and execute.ts acts on it:
//
//   demon_move   advance · back_off · strafe_left · strafe_right · hold      how to walk, relative to the warlock
//   demon_spell  fire · frost · earth                                         which spell to carry (and cloak with)
//   demon_act    cast · cloak · dash_left · dash_right · wait                 the one commitment for this tick
//   demon_aim    straight_at_warlock · lead_warlock_movement
//
// Options that are impossible right now (a cast on cooldown, a dash into the wall) are left out, so Jev can't pick them.

export const moveOptions = [
  "advance",
  "back_off",
  "strafe_left",
  "strafe_right",
  "hold",
] as const;
export const actOptions = [
  "cast",
  "cloak",
  "dash_left",
  "dash_right",
  "wait",
] as const;
export const aimOptions = [
  "straight_at_warlock",
  "lead_warlock_movement",
] as const;

export type MoveOption = (typeof moveOptions)[number];
export type ActOption = (typeof actOptions)[number];
export type AimOption = (typeof aimOptions)[number];

export const tickQuestionKeys = {
  move: "demon_move",
  spell: "demon_spell",
  act: "demon_act",
  aim: "demon_aim",
} as const;

// The options offered this tick.
export type TickOptions = {
  readonly move: readonly MoveOption[];
  readonly spell: readonly Element[];
  readonly act: readonly ActOption[];
  readonly aim: readonly AimOption[];
};

const moveCriteria: Record<MoveOption, string> = {
  advance:
    "Walk toward the warlock. Right when `between.distance` is far, or `round` says the demon is ahead on health, or `warlock.health` is critical.",
  back_off:
    "Walk away from the warlock. Right when `between.distance` is close, `demon.health` is critical, or most spells are in `demon.onCooldown`. Wrong when `demon.position` is near the edge.",
  strafe_left:
    "Sidestep to the demon's left. Right when `between.warlockAim` is straight at or near the demon, or something is in `between.incomingToDemon`, and `demon.openSides` says left is open.",
  strafe_right:
    "Sidestep to the demon's right. Right when `between.warlockAim` is straight at or near the demon, or something is in `between.incomingToDemon`, and `demon.openSides` says right is open.",
  hold: "Stand still. Right when `between.distance` is mid and nothing is incoming, or while a cloak that blocks what is incoming is up.",
};

// What each spell does, so Jev can play to its strengths instead of treating the three as interchangeable.
const spellTraits: Record<Element, string> = {
  fire: "a slow orb whose splash and burn still catch a late dodge",
  frost:
    "the fastest shot; a hit freezes the warlock for about a second, long enough for an earthspike to land",
  earth:
    "the heaviest hit, along a line after a short charge that roots the demon; best when the warlock is frozen, rooted or standing still",
};

const spellCriteria = (element: Element): string =>
  `Carry ${element}: ${spellTraits[element]}. Right when \`counters.warlockWeakTo\` is ${element} and ${element} is ready, or to cloak against incoming ${element}.` +
  ` Wrong when \`counters.riskyForDemonToCarry\` is ${element}, unless cloaking. Wrong for casting when \`counters.warlockCloakBlocks\` is ${element}.`;

const actCriteria: Record<ActOption, string> = {
  cast:
    "Cast at the warlock. Right when `demon.canCast` starts with now or in a moment and nothing in `between.incomingToDemon` is imminent. Best when `warlock.openings` is not none, `warlock.status` says frozen or rooted, or `counters.demonHasWarlockWeaknessReady` is yes. " +
    "A warlock cloak is an opening, not a reason to hold back: it stops only `counters.warlockCloakBlocks` and the warlock can't cast behind it. Wrong when `counters.warlockCloakBlocks` is the spell named in `demon.canCast`.",
  cloak:
    "Raise the cloak and hold it. Right when an item in `between.incomingToDemon` has `cloakCanBlock` starting with yes. " +
    "Also right before a shot, when `between.warlockAim` is straight at the demon and `warlock.carrying` is frost (too fast to cloak after the cast); " +
    "the cloak then guards against `warlock.carrying`. Wrong when every incoming item says too late.",
  dash_left:
    "Dash to the demon's left. Right when an item in `between.incomingToDemon` arrives imminent or in about half a second and its `cloakCanBlock` does not start with yes, and `demon.openSides` says left is open.",
  dash_right:
    "Dash to the demon's right. Right when an item in `between.incomingToDemon` arrives imminent or in about half a second and its `cloakCanBlock` does not start with yes, and `demon.openSides` says right is open.",
  wait: "Keep moving, don't cast. Right when nothing is incoming and `demon.canCast` does not start with now.",
};

const aimCriteria: Record<AimOption, string> = {
  straight_at_warlock:
    "Aim where the warlock is now. Right when `warlock.movement` is standing still or `warlock.status` says rooted or frozen.",
  lead_warlock_movement:
    "Aim ahead of the warlock. Right when `warlock.movement` is walking, strafing or dashing.",
};

const pick = <Option extends string>(
  criteria: Record<Option, string>,
  options: readonly Option[],
): Record<string, string> =>
  Object.fromEntries(options.map((option) => [option, criteria[option]]));

// Ready within `soonMs`: a decision lands about one round trip after the request, so "almost ready" counts.
function castableSoon(demon: Caster, soonMs: number): boolean {
  if (demon.charge || demon.recoveryRemainingMs > soonMs) return false;
  return elements.some((element) => demon.cooldownsMs[element] <= soonMs);
}

function openDashSides(
  demon: Caster,
  warlock: Caster,
  simTuning: SimTuning,
  tuning: DescribeTuning,
): Side[] {
  const frame = facingFrame(demon, warlock);
  const open = (["left", "right"] as const).filter((side) =>
    isSideOpen(demon, frame, side, simTuning, tuning),
  );
  // Pinned against the edge on both sides, a dash either way is still better than none.
  return open.length ? open : ["left", "right"];
}

export function tickOptions(
  world: World,
  simTuning: SimTuning = config.sim,
  tuning: DescribeTuning = config.brain.describe,
): TickOptions {
  const { warlock, demon } = world.casters;
  // A dash also breaks off an earthspike charge, so it stays on offer while charging; the cloak doesn't (charging drops it).
  const dashReady = demon.dashCooldownMs <= tuning.castSoonMs;
  const dashes: ActOption[] = dashReady
    ? openDashSides(demon, warlock, simTuning, tuning).map((side) =>
        side === "left" ? "dash_left" : "dash_right",
      )
    : [];
  const act: ActOption[] = [
    ...(castableSoon(demon, tuning.castSoonMs) ? (["cast"] as const) : []),
    ...(demon.charge ? [] : (["cloak"] as const)),
    ...dashes,
    "wait",
  ];
  return { move: moveOptions, spell: elements, act, aim: aimOptions };
}

export function tickQuestions(
  options: TickOptions,
): Record<string, ChoiceQuestion> {
  const act: ChoiceQuestion = {
    type: "choice",
    instructions:
      "You control `demon`, a mage dueling `warlock` in a round arena; a round is won by bringing the other to zero health (`round` has the score). " +
      "What should the demon do right now? A dash keeps a raised cloak up and breaks off an earthspike charge.",
    criteria: pick(actCriteria, options.act),
  };
  return {
    [tickQuestionKeys.move]: {
      type: "choice",
      instructions: "How should the demon move next? Keep away from the edge, where dodges run out.",
      criteria: pick(moveCriteria, options.move),
    },
    [tickQuestionKeys.spell]: {
      type: "choice",
      instructions:
        "Which spell should the demon carry? It casts only the carried spell, and its cloak blocks only that element. Fire beats frost, frost beats earth, earth beats fire: an attack hits 1.5× harder on a mage carrying what it beats (`counters` works this out).",
      criteria: Object.fromEntries(
        options.spell.map((element) => [element, spellCriteria(element)]),
      ),
    },
    [tickQuestionKeys.act]: act,
    [tickQuestionKeys.aim]: {
      type: "choice",
      instructions: "If the demon casts now, where should it aim?",
      criteria: pick(aimCriteria, options.aim),
    },
  };
}

export type TickRequest = {
  readonly request: BrainRequest;
  readonly options: TickOptions;
};

export function buildTickRequest(
  world: World,
  recent: RecentActions,
  simTuning: SimTuning = config.sim,
): TickRequest {
  const options = tickOptions(world, simTuning);
  return {
    request: {
      kind: "tick",
      state: describeDuel(world, recent, simTuning),
      questions: tickQuestions(options),
    },
    options,
  };
}
