import { APITimeoutError, APIUserAbortError, InternalServerError, RateLimitError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { createBrainHandler, mapUpstreamError, parseBrainRequest, type SystemOneCall } from "../../server/brainHandler.ts";
import { config } from "../../src/config.ts";
import { loadFixtures } from "../fixtures/fixtureFormat.ts";
import { probeSituation } from "../fixtures/probeSituation.ts";

const firstFixture = loadFixtures()[0]!;
const neverAborted = new AbortController().signal;

function fakeCall(recordedCalls: Parameters<SystemOneCall>[] = []): SystemOneCall {
  return async (request, options) => {
    recordedCalls.push([request, options]);
    return {
      model: firstFixture.response.model,
      answers: firstFixture.response.answers,
      usage: { input_tokens: firstFixture.response.usage.inputTokens, output_tokens: 0 },
    };
  };
}

describe("parseBrainRequest", () => {
  it("accepts the probe situation", () => {
    expect(typeof parseBrainRequest(probeSituation)).toBe("object");
  });

  it.each([
    [null, "body must be a JSON object"],
    [{ kind: "chat", state: "", questions: {} }, "kind must be"],
    [{ kind: "tick", questions: { question: { type: "choice", instructions: "?", criteria: { yes: null, no: null } } } }, "state is required"],
    [{ kind: "tick", state: "", questions: {} }, "must not be empty"],
    [{ kind: "tick", state: "", questions: { question: { type: "choice", instructions: "?", criteria: { only: null } } } }, "2–255 options"],
    [{ kind: "tick", state: "", questions: { question: { type: "choice", instructions: "?", criteria: ["left", "right"] } } }, "criteria must be an object"],
    [{ kind: "tick", state: "", questions: { question: { type: "score", instructions: "?", criteria: ["low", "high"] } } }, "type must be choice"],
  ])("rejects %j", (body, expectedMessage) => {
    expect(parseBrainRequest(body)).toContain(expectedMessage);
  });
});

describe("createBrainHandler", () => {
  it("answers no_api_key without a key and never calls the SDK", async () => {
    const recordedCalls: Parameters<SystemOneCall>[] = [];
    const handler = createBrainHandler({ apiKey: "  ", createSystemOneCall: () => fakeCall(recordedCalls) });
    const result = await handler.handle(probeSituation, neverAborted);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, error: "no_api_key" });
    expect(recordedCalls).toHaveLength(0);
    expect(handler.status().hasApiKey).toBe(false);
  });

  it("pins the model and applies per-kind timeout and retries", async () => {
    const recordedCalls: Parameters<SystemOneCall>[] = [];
    const handler = createBrainHandler({ apiKey: "test-key", createSystemOneCall: () => fakeCall(recordedCalls) });
    await handler.handle({ ...probeSituation, kind: "tick" }, neverAborted);
    const [request, options] = recordedCalls[0]!;
    expect(request.model).toBe("jev-1.13.0");
    expect(options.timeout).toBe(config.brain.duelTick.timeoutMs);
    expect(options.retry.maxRetries).toBe(0);
    expect(options.signal).toBe(neverAborted);
  });

  it("returns answers, usage and latency", async () => {
    let clock = 1000;
    const slowCall: SystemOneCall = async (request, options) => {
      clock += 212;
      return fakeCall()(request, options);
    };
    const handler = createBrainHandler({ apiKey: "test-key", createSystemOneCall: () => slowCall, now: () => clock });
    const result = await handler.handle(probeSituation, neverAborted);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, latencyMs: 212, usage: { inputTokens: firstFixture.response.usage.inputTokens } });
  });

  it("refuses requests once the per-minute token budget is spent, then recovers", async () => {
    let clock = 0;
    const tokensPerCall = firstFixture.response.usage.inputTokens;
    const handler = createBrainHandler({
      apiKey: "test-key",
      maxTokensPerMinute: tokensPerCall * 2,
      createSystemOneCall: () => fakeCall(),
      now: () => clock,
    });
    expect((await handler.handle(probeSituation, neverAborted)).status).toBe(200);
    expect((await handler.handle(probeSituation, neverAborted)).status).toBe(200);
    const refused = await handler.handle(probeSituation, neverAborted);
    expect(refused.body).toMatchObject({ ok: false, error: "budget_exceeded" });
    clock += 60_001;
    expect((await handler.handle(probeSituation, neverAborted)).status).toBe(200);
  });
});

describe("mapUpstreamError", () => {
  it.each([
    [new RateLimitError(429, {}, new Headers({ "retry-after-ms": "750" })), 429, "rate_limited"],
    [new InternalServerError(529, {}, new Headers()), 503, "overloaded"],
    [new InternalServerError(500, {}, new Headers()), 502, "upstream"],
    [new APITimeoutError(700), 504, "timeout"],
    [new APIUserAbortError(), 499, "aborted"],
    [new Error("boom"), 500, "upstream"],
  ])("maps %s", (error, expectedStatus, expectedKind) => {
    const result = mapUpstreamError(error);
    expect(result.status).toBe(expectedStatus);
    expect(result.body).toMatchObject({ ok: false, error: expectedKind });
  });
});
