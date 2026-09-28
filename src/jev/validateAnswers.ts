import type { ChoiceAnswer, ChoiceQuestion } from "./protocol.ts";

const probabilitySumTolerance = 0.02;

// Checks that every question got a choice answer that names a real option. Used on recorded fixtures and by the probe.
export function findAnswerProblems(
  questions: Readonly<Record<string, ChoiceQuestion>>,
  answers: Readonly<Record<string, ChoiceAnswer>>,
): string[] {
  return Object.entries(questions).flatMap(([questionKey, question]) => {
    const answer = answers[questionKey];
    if (!answer) return [`${questionKey}: missing answer`];
    if (answer.type !== question.type) return [`${questionKey}: expected ${question.type}, got ${answer.type}`];
    const problems: string[] = [];
    if (answer.confidence < 0 || answer.confidence > 1) problems.push(`${questionKey}: confidence out of range`);
    const probabilitySum = Object.values(answer.probabilities).reduce((sum, probability) => sum + probability, 0);
    if (Math.abs(probabilitySum - 1) > probabilitySumTolerance) problems.push(`${questionKey}: probabilities sum to ${probabilitySum.toFixed(3)}`);
    const options = Object.keys(question.criteria);
    if (!options.includes(answer.choice)) problems.push(`${questionKey}: choice "${answer.choice}" is not an option`);
    const unknownLabels = Object.keys(answer.probabilities).filter((label) => !options.includes(label));
    if (unknownLabels.length) problems.push(`${questionKey}: probabilities for unknown options ${unknownLabels.join(", ")}`);
    return problems;
  });
}
