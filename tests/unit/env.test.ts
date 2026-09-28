import { describe, expect, it } from "vitest";
import { readServerEnvironment } from "../../server/env.ts";

describe("readServerEnvironment", () => {
  it("treats blank keys as missing and ignores invalid budgets", () => {
    expect(readServerEnvironment({ TYPESAFE_API_KEY: "   ", TYPESAFE_MAX_TOKENS_PER_MINUTE: "lots" })).toEqual({
      apiKey: undefined,
      maxTokensPerMinute: undefined,
    });
  });

  it("reads the key and budget", () => {
    expect(readServerEnvironment({ TYPESAFE_API_KEY: "key", TYPESAFE_MAX_TOKENS_PER_MINUTE: "500000" })).toEqual({
      apiKey: "key",
      maxTokensPerMinute: 500_000,
    });
  });
});
