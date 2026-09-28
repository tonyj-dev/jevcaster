// The wire format between the game and Jev, via the /api/brain proxy (server/brainHandler.ts).
// It mirrors the TypeSafe SDK's systemOne call without importing the SDK, which is server-only.
//
//   request:  { state, questions }   state = the duel in words (state.ts), questions = what to decide (questions.ts)
//   response: { answers }            one answer per question: the pick, a probability per option, and a confidence

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Entry = string | { [key: string]: JsonValue } | JsonValue[] | null;

// A multiple-choice question. `criteria` maps each option to a short text saying when it is right.
export type ChoiceQuestion = {
  type: "choice";
  instructions: Entry;
  criteria: Record<string, Entry>;
};

// Jev's answer: its top pick, a probability for every option, and (n·peak − 1)/(n − 1) as confidence.
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

// "tick" is the in-game decision; "probe" is scripts/brainProbe.ts measuring latency.
export type BrainRequestKind = "tick" | "probe";

export type BrainRequest = {
  kind: BrainRequestKind;
  state: Entry;
  questions: Record<string, ChoiceQuestion>;
};

export type BrainUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type BrainSuccess = {
  ok: true;
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: BrainUsage;
  latencyMs: number;
};

export type BrainErrorKind =
  | "no_api_key"
  | "bad_request"
  | "budget_exceeded"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "aborted"
  | "upstream";

export type BrainFailure = {
  ok: false;
  error: BrainErrorKind;
  message: string;
  retryAfterMs?: number;
};

export type BrainResponse = BrainSuccess | BrainFailure;

// GET /api/brain/status, shown in the page footer.
export type BrainStatus = {
  hasApiKey: boolean;
  model: string;
  tokensUsedLastMinute: number;
  maxTokensPerMinute: number;
};
