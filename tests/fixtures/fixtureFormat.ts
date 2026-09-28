import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainRequest, BrainSuccess } from "../../src/jev/protocol.ts";

// "synthetic" fixtures are hand-made stand-ins until `pnpm brain:probe --record` replaces them.
export type BrainFixture = {
  name: string;
  source: "recorded" | "synthetic";
  recordedAt: string;
  note?: string;
  request: BrainRequest;
  response: BrainSuccess;
};

export const fixturesDirectory = dirname(fileURLToPath(import.meta.url));

export function loadFixtures(): BrainFixture[] {
  return readdirSync(fixturesDirectory)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => JSON.parse(readFileSync(resolve(fixturesDirectory, fileName), "utf8")) as BrainFixture);
}
