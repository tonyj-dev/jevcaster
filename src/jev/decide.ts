import { isFrozen } from "../sim/caster.ts";
import type { Element, World } from "../sim/types.ts";
import type { ChoiceAnswer } from "./protocol.ts";
import { tickQuestionKeys, type ActOption, type AimOption, type MoveOption, type TickOptions } from "./questions.ts";

// Jev's answers → one DemonDecision. Jev returns a probability per option; the demon takes its top pick.

export type Probabilities = Readonly<Record<string, number>>;

export type PickedAnswer<Option extends string> = {
  readonly option: Option;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

// One pick per question. execute.ts turns this into the demon's input every sim step.
export type DemonDecision = {
  readonly move: PickedAnswer<MoveOption>;
  readonly spell: PickedAnswer<Element>;
  readonly act: PickedAnswer<ActOption>;
  readonly aim: PickedAnswer<AimOption>;
};

// Mirrored options count as one family when picking, so dash_left 0.3 + dash_right 0.3 beats cloak 0.4:
// Jev often splits a dodge evenly between the sides when it is sure it should dodge.
export const actFamilies: Readonly<Record<ActOption, string>> = { cast: "cast", cloak: "cloak", dash_left: "dash", dash_right: "dash", wait: "wait" };
export const moveFamilies: Readonly<Record<MoveOption, string>> = { advance: "advance", back_off: "back_off", strafe_left: "strafe", strafe_right: "strafe", hold: "hold" };

// Picks one option per question. Null when an answer is missing or of the wrong type.
export function decideFromAnswers(answers: Readonly<Record<string, ChoiceAnswer>>, options: TickOptions): DemonDecision | null {
  const move = pickAnswer(answers[tickQuestionKeys.move], options.move, moveFamilies);
  const spell = pickAnswer(answers[tickQuestionKeys.spell], options.spell, {});
  const act = pickAnswer(answers[tickQuestionKeys.act], options.act, actFamilies);
  const aim = pickAnswer(answers[tickQuestionKeys.aim], options.aim, {});
  if (!move || !spell || !act || !aim) return null;
  return { move, spell, act, aim };
}

function pickAnswer<Option extends string>(answer: ChoiceAnswer | undefined, options: readonly Option[], families: Readonly<Record<string, string>>): PickedAnswer<Option> | null {
  if (!answer || answer.type !== "choice" || options.length === 0) return null;
  const probabilities = restrictProbabilities(answer.probabilities, options);
  return { option: pickOption(probabilities, families) as Option, probabilities, confidence: answer.confidence };
}

// Keeps only the offered options and renormalises, so a stray label can't be picked.
export function restrictProbabilities(probabilities: Probabilities, options: readonly string[]): Record<string, number> {
  const kept = options.map((option) => [option, Math.max(0, probabilities[option] ?? 0)] as const);
  const total = kept.reduce((sum, [, probability]) => sum + probability, 0);
  if (total <= 0) return Object.fromEntries(options.map((option) => [option, 1 / options.length]));
  return Object.fromEntries(kept.map(([option, probability]) => [option, probability / total]));
}

// The most likely family, then its most likely option. Ties go to the option listed first.
export function pickOption(probabilities: Probabilities, families: Readonly<Record<string, string>>): string {
  const familyTotals = new Map<string, number>();
  for (const [option, probability] of Object.entries(probabilities)) {
    const family = families[option] ?? option;
    familyTotals.set(family, (familyTotals.get(family) ?? 0) + probability);
  }
  const topFamily = [...familyTotals].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  const inFamily = Object.entries(probabilities).filter(([option]) => (families[option] ?? option) === topFamily);
  return inFamily.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

// ---- Staleness: an answer describes the world as it was when the request left ----

export type RequestStamp = { readonly tick: number; readonly timeMs: number; readonly roundEpoch: number };
// roundEpoch advances on every roundEnded and roundStarted; lastDemonFrozenTick is the tick of the demon's last freeze.
export type StalenessMarkers = { readonly roundEpoch: number; readonly lastDemonFrozenTick: number };
export type StaleReason = "round_changed" | "demon_frozen" | "too_old";

export function staleReason(stamp: RequestStamp, world: World, markers: StalenessMarkers, maxAgeMs: number): StaleReason | null {
  if (markers.roundEpoch !== stamp.roundEpoch || world.round.phase !== "fighting") return "round_changed";
  if (markers.lastDemonFrozenTick >= stamp.tick || isFrozen(world.casters.demon)) return "demon_frozen";
  if (world.timeMs - stamp.timeMs > maxAgeMs) return "too_old";
  return null;
}
