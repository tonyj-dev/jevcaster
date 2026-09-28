// Sends the canned duel situation to Jev and prints answers, confidence, latency and token usage.
//   pnpm brain:probe                 one call
//   pnpm brain:probe --runs 20       latency p50/p95 over 20 calls (after one warm-up call)
//   pnpm brain:probe --runs 3 --record   also write up to 3 responses to tests/fixtures/
//   pnpm brain:probe --dry-run       print the request without calling Jev
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createBrainHandler } from "../server/brainHandler.ts";
import { loadServerEnvironment } from "../server/env.ts";
import { config } from "../src/config.ts";
import type { BrainSuccess, ChoiceAnswer } from "../src/jev/protocol.ts";
import { summarizeLatencies } from "../src/jev/stats.ts";
import { findAnswerProblems } from "../src/jev/validateAnswers.ts";
import type { BrainFixture } from "../tests/fixtures/fixtureFormat.ts";
import { fixturesDirectory } from "../tests/fixtures/fixtureFormat.ts";
import { probeSituation } from "../tests/fixtures/probeSituation.ts";

const maxRecordedFixtures = 3;
const plannedDuelTicksPerSecond = 1000 / config.brain.duelTick.baseIntervalMs;
const secondsPerHour = 3600;

const { values: flags } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    record: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
const runCount = Math.max(1, Number(flags.runs) || 1);

if (flags["dry-run"]) {
  const requestJson = JSON.stringify(probeSituation);
  console.log(JSON.stringify(probeSituation, null, 2));
  console.log(`\nRequest size: ${requestJson.length} characters (roughly ${Math.round(requestJson.length / 4)} tokens).`);
  process.exit(0);
}

const environment = loadServerEnvironment();
if (!environment.apiKey) {
  console.error("TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key, or use --dry-run.");
  process.exit(1);
}

const brainHandler = createBrainHandler({ apiKey: environment.apiKey, maxTokensPerMinute: environment.maxTokensPerMinute });

async function callOnce(): Promise<BrainSuccess> {
  const result = await brainHandler.handle(probeSituation, new AbortController().signal);
  if (!result.body.ok) throw new Error(`${result.body.error}: ${result.body.message}`);
  return result.body;
}

function formatAnswer(answer: ChoiceAnswer): string {
  const ranked = Object.entries(answer.probabilities)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 3)
    .map(([label, probability]) => `${label} ${probability.toFixed(2)}`)
    .join(", ");
  return `${answer.choice.padEnd(14)} confidence ${answer.confidence.toFixed(2)}   [${ranked}]`;
}

function printResponse(response: BrainSuccess): void {
  console.log(`\nModel: ${response.model}`);
  for (const [questionKey, answer] of Object.entries(response.answers)) {
    console.log(`  ${questionKey.padEnd(12)} ${formatAnswer(answer)}`);
  }
  const problems = findAnswerProblems(probeSituation.questions, response.answers);
  if (problems.length) console.log(`  PROBLEMS: ${problems.join("; ")}`);
  const costPerCall = (response.usage.inputTokens / 1_000_000) * config.brain.dollarsPerMillionInputTokens;
  const costPerHour = costPerCall * plannedDuelTicksPerSecond * secondsPerHour;
  console.log(`  Tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);
  console.log(`  Cost: $${costPerCall.toFixed(6)} per call, about $${costPerHour.toFixed(2)}/hour at ${plannedDuelTicksPerSecond.toFixed(1)} duel ticks per second`);
}

function recordFixtures(responses: readonly BrainSuccess[]): void {
  responses.slice(0, maxRecordedFixtures).forEach((response, index) => {
    const name = `duel-probe-${index + 1}`;
    const fixture: BrainFixture = {
      name,
      source: "recorded",
      recordedAt: new Date().toISOString(),
      request: probeSituation,
      response,
    };
    const filePath = resolve(fixturesDirectory, `${name}.json`);
    writeFileSync(filePath, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`Recorded ${filePath}`);
  });
}

async function main(): Promise<void> {
  const warmUpNeeded = runCount > 1;
  if (warmUpNeeded) {
    const warmUp = await callOnce();
    console.log(`Warm-up call (connection setup, not counted): ${warmUp.latencyMs.toFixed(0)} ms`);
  }

  const responses: BrainSuccess[] = [];
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const response = await callOnce();
    responses.push(response);
    if (runCount > 1) console.log(`  call ${String(runIndex + 1).padStart(2)}: ${response.latencyMs.toFixed(0)} ms`);
  }

  const firstResponse = responses[0];
  if (firstResponse) printResponse(firstResponse);

  const latency = summarizeLatencies(responses.map((response) => response.latencyMs));
  console.log(
    `\nLatency over ${latency.count} call(s): p50 ${latency.p50Ms.toFixed(0)} ms, p95 ${latency.p95Ms.toFixed(0)} ms ` +
      `(min ${latency.minMs.toFixed(0)}, max ${latency.maxMs.toFixed(0)}, mean ${latency.meanMs.toFixed(0)})`,
  );
  if (latency.p95Ms > 600) console.log("WARNING: p95 above 600 ms, too slow for the reaction windows the duel is tuned around.");

  if (flags.record) recordFixtures(responses);
}

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : caught);
  process.exit(1);
});
