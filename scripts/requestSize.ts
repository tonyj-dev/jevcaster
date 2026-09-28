import { buildProbeRecent, buildProbeWorld } from "../tests/fixtures/probeSituation.ts";
import { buildTickRequest } from "../src/jev/questions.ts";

// Rough size of the tick request Jev receives, for keeping the per-hour cost in check.
// Tokens are estimated at about 4 characters each; `pnpm brain:probe` reports the real count.
const world = buildProbeWorld();
const { request } = buildTickRequest(world, buildProbeRecent(world));
const parts = { state: request.state, questions: request.questions, whole: request };
for (const [name, value] of Object.entries(parts)) {
  const characters = JSON.stringify(value).length;
  console.log(`${name.padEnd(10)} ${String(characters).padStart(6)} chars ≈ ${Math.round(characters / 4)} tokens`);
}
for (const [key, question] of Object.entries(request.questions)) {
  console.log(`  ${key.padEnd(12)} ${String(JSON.stringify(question).length).padStart(6)} chars`);
}
