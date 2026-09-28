import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
  TypeSafeClient,
  type Questions,
} from "@typesafe-ai/sdk";
import { config } from "../src/config.ts";
import type {
  BrainErrorKind,
  BrainFailure,
  BrainRequest,
  BrainRequestKind,
  BrainResponse,
  BrainStatus,
  ChoiceAnswer,
  ChoiceQuestion,
  Entry,
} from "../src/jev/protocol.ts";

// POST /api/brain: the only place that holds the API key and talks to Jev. The browser (local play) and the
// Jev vs Jev host both send a BrainRequest here; it is validated, budget-checked, and forwarded to the SDK.

export type SystemOneCallResult = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type SystemOneCall = (
  request: { state: Entry; questions: Record<string, ChoiceQuestion>; model: string },
  options: { timeout: number; retry: { maxRetries: number }; signal: AbortSignal },
) => Promise<SystemOneCallResult>;

export type BrainHandlerOptions = {
  apiKey: string | undefined;
  maxTokensPerMinute?: number;
  createSystemOneCall?: (apiKey: string) => SystemOneCall;
  now?: () => number;
};

export type HandlerResult = { status: number; body: BrainResponse };

type UsageEntry = { atMs: number; tokens: number };

const requestKinds: readonly BrainRequestKind[] = ["tick", "probe"];
const oneMinuteMs = 60_000;
const maxChoiceOptions = 255;
const clientClosedRequestStatus = 499;

export function createSdkSystemOneCall(apiKey: string): SystemOneCall {
  const client = new TypeSafeClient({ apiKey, defaultModel: config.brain.model });
  return async (request, options) => {
    // Shapes are validated in parseBrainRequest.
    const result = await client.systemOne(
      { state: request.state, model: request.model, questions: request.questions as unknown as Questions },
      options,
    );
    return {
      model: result.model,
      answers: toBrainAnswers(result.answers as Record<string, unknown>),
      usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
    };
  };
}

function toBrainAnswers(sdkAnswers: Record<string, unknown>): Record<string, ChoiceAnswer> {
  return Object.fromEntries(
    Object.entries(sdkAnswers).map(([key, rawAnswer]) => {
      const answer = rawAnswer as ChoiceAnswer;
      return [key, { type: answer.type, choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence }];
    }),
  );
}

export function parseBrainRequest(body: unknown): BrainRequest | string {
  if (!isPlainObject(body)) return "body must be a JSON object";
  const { kind, state, questions } = body;
  if (typeof kind !== "string" || !requestKinds.includes(kind as BrainRequestKind)) {
    return `kind must be one of ${requestKinds.join(", ")}`;
  }
  if (state === undefined) return "state is required";
  if (!isPlainObject(questions)) return "questions must be an object";
  const questionEntries = Object.entries(questions);
  if (questionEntries.length === 0) return "questions must not be empty";
  if (questionEntries.length > config.brain.maxQuestionsPerRequest) {
    return `at most ${config.brain.maxQuestionsPerRequest} questions per request`;
  }
  for (const [questionKey, question] of questionEntries) {
    const problem = validateQuestion(question);
    if (problem) return `questions.${questionKey}: ${problem}`;
  }
  return { kind: kind as BrainRequestKind, state: state as Entry, questions: questions as Record<string, ChoiceQuestion> };
}

function validateQuestion(question: unknown): string | undefined {
  if (!isPlainObject(question)) return "must be an object";
  if (question.type !== "choice") return "type must be choice";
  if (!isPlainObject(question.criteria)) return "choice criteria must be an object";
  const optionCount = Object.keys(question.criteria).length;
  if (optionCount < 2 || optionCount > maxChoiceOptions) return `choice needs 2–${maxChoiceOptions} options`;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timingFor(kind: BrainRequestKind): { timeout: number; maxRetries: number } {
  if (kind === "tick") return { timeout: config.brain.duelTick.timeoutMs, maxRetries: config.brain.duelTick.maxRetries };
  // Probe: generous timeout, no retries, so measured latency is one real attempt.
  return { timeout: 10_000, maxRetries: 0 };
}

function failure(status: number, error: BrainErrorKind, message: string, retryAfterMs?: number): HandlerResult {
  const body: BrainFailure = retryAfterMs === undefined ? { ok: false, error, message } : { ok: false, error, message, retryAfterMs };
  return { status, body };
}

export function mapUpstreamError(caught: unknown): HandlerResult {
  if (caught instanceof APIUserAbortError) return failure(clientClosedRequestStatus, "aborted", "request aborted by client");
  if (caught instanceof APITimeoutError) return failure(504, "timeout", "Jev did not answer before the timeout");
  if (caught instanceof RateLimitError) return failure(429, "rate_limited", "rate limited by TypeSafe", caught.retryAfterMs);
  if (caught instanceof APIError) {
    if (caught.status === 529) return failure(503, "overloaded", "TypeSafe is overloaded");
    return failure(502, "upstream", `TypeSafe returned HTTP ${caught.status}`);
  }
  if (caught instanceof APIConnectionError) return failure(502, "upstream", "could not reach TypeSafe");
  if (caught instanceof Error && caught.name === "AbortError") return failure(clientClosedRequestStatus, "aborted", "request aborted by client");
  return failure(500, "upstream", caught instanceof Error ? caught.message : "unknown error");
}

export function createBrainHandler(options: BrainHandlerOptions) {
  const now = options.now ?? (() => performance.now());
  const maxTokensPerMinute = options.maxTokensPerMinute ?? config.brain.maxTokensPerMinute;
  const createCall = options.createSystemOneCall ?? createSdkSystemOneCall;
  const apiKey = options.apiKey?.trim() || undefined;
  let systemOneCall: SystemOneCall | undefined;
  let usageLog: readonly UsageEntry[] = [];

  function tokensUsedLastMinute(): number {
    const cutoff = now() - oneMinuteMs;
    usageLog = usageLog.filter((entry) => entry.atMs >= cutoff);
    return usageLog.reduce((total, entry) => total + entry.tokens, 0);
  }

  function status(): BrainStatus {
    return { hasApiKey: apiKey !== undefined, model: config.brain.model, tokensUsedLastMinute: tokensUsedLastMinute(), maxTokensPerMinute };
  }

  async function handle(body: unknown, signal: AbortSignal): Promise<HandlerResult> {
    if (!apiKey) return failure(503, "no_api_key", "TYPESAFE_API_KEY is not set on the server");
    const parsed = parseBrainRequest(body);
    if (typeof parsed === "string") return failure(400, "bad_request", parsed);
    if (tokensUsedLastMinute() >= maxTokensPerMinute) {
      return failure(429, "budget_exceeded", "token budget for this minute is spent", oneMinuteMs);
    }

    systemOneCall ??= createCall(apiKey);
    const timing = timingFor(parsed.kind);
    const startedAt = now();
    try {
      const result = await systemOneCall(
        { state: parsed.state, questions: parsed.questions, model: config.brain.model },
        { timeout: timing.timeout, retry: { maxRetries: timing.maxRetries }, signal },
      );
      const finishedAt = now();
      usageLog = [...usageLog, { atMs: finishedAt, tokens: result.usage.input_tokens }];
      return {
        status: 200,
        body: {
          ok: true,
          model: result.model,
          answers: result.answers,
          usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
          latencyMs: finishedAt - startedAt,
        },
      };
    } catch (caught) {
      return mapUpstreamError(caught);
    }
  }

  async function middleware(request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> {
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && path === config.brain.statusPath) {
      sendJson(response, 200, status());
      return;
    }
    if (path !== config.brain.endpointPath) {
      next();
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "bad_request", message: "use POST" });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(request, config.brain.maxRequestBytes));
    } catch (caught) {
      sendJson(response, 400, { ok: false, error: "bad_request", message: caught instanceof Error ? caught.message : "invalid body" });
      return;
    }

    // Forward the browser's abort (it closed the connection) to the SDK call.
    const abortController = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) abortController.abort();
    });
    const result = await handle(body, abortController.signal);
    if (!response.destroyed) sendJson(response, result.status, result.body);
  }

  return { handle, status, middleware };
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        reject(new Error(`body larger than ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
