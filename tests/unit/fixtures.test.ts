import { describe, expect, it } from "vitest";
import { findAnswerProblems } from "../../src/jev/validateAnswers.ts";
import { loadFixtures } from "../fixtures/fixtureFormat.ts";
import { probeSituation } from "../fixtures/probeSituation.ts";

const fixtures = loadFixtures();

describe("recorded fixtures", () => {
  it("has at least three", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s answers every question validly", (_name, fixture) => {
    expect(fixture.response.model).toMatch(/^jev-/);
    expect(findAnswerProblems(fixture.request.questions, fixture.response.answers)).toEqual([]);
  });

  // When describe/ or the questions change, re-record with `pnpm brain:probe --runs 3 --record`.
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s was recorded from the current probe request", (_name, fixture) => {
    expect(fixture.request).toEqual(probeSituation);
  });
});

describe("findAnswerProblems", () => {
  const questions = {
    pick: { type: "choice", instructions: "?", criteria: { left: null, right: null } },
  } as const;

  it("flags missing answers, unknown options and bad probability sums", () => {
    expect(findAnswerProblems(questions, {})).toEqual(["pick: missing answer"]);
    const problems = findAnswerProblems(questions, {
      pick: { type: "choice", choice: "up", probabilities: { left: 0.2, up: 0.2 }, confidence: 0.1 },
    }).join(" ");
    expect(problems).toContain('"up" is not an option');
    expect(problems).toContain("sum to 0.400");
  });
});
