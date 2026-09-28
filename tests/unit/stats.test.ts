import { describe, expect, it } from "vitest";
import { percentile, summarizeLatencies } from "../../src/jev/stats.ts";

describe("latency stats", () => {
  const twentyCalls = Array.from({ length: 20 }, (_unused, index) => (index + 1) * 10);

  it("uses nearest-rank percentiles", () => {
    expect(percentile(twentyCalls, 0.5)).toBe(100);
    expect(percentile(twentyCalls, 0.95)).toBe(190);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it("does not depend on input order", () => {
    const reversed = [...twentyCalls].reverse();
    expect(summarizeLatencies(reversed)).toEqual({ count: 20, minMs: 10, p50Ms: 100, p95Ms: 190, maxMs: 200, meanMs: 105 });
  });
});
