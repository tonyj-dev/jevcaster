import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type ServerEnvironment = {
  apiKey: string | undefined;
  maxTokensPerMinute: number | undefined;
};

// Loads .env from the working directory (if present) into process.env, then reads the brain settings.
export function loadServerEnvironment(): ServerEnvironment {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  return readServerEnvironment(process.env);
}

export function readServerEnvironment(source: Record<string, string | undefined>): ServerEnvironment {
  const apiKey = source.TYPESAFE_API_KEY?.trim() || undefined;
  const rawBudget = Number(source.TYPESAFE_MAX_TOKENS_PER_MINUTE);
  const maxTokensPerMinute = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : undefined;
  return { apiKey, maxTokensPerMinute };
}
