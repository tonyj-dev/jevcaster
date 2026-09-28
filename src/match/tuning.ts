import { config } from "../config.ts";

export type TuneValue = number | boolean | string;

// Server-side guards that viewers must not loosen from the dev panel.
const lockedPaths: readonly string[] = [
  "brain.maxTokensPerMinute",
  "brain.dollarsPerMillionInputTokens",
  "brain.maxRequestBytes",
  "brain.maxQuestionsPerRequest",
];

type Branch = Record<string, unknown>;

const isBranch = (value: unknown): value is Branch => typeof value === "object" && value !== null && !Array.isArray(value);

export function isLockedPath(path: readonly string[]): boolean {
  return lockedPaths.includes(path.join("."));
}

// The value at `path` in `root`, or undefined when the path doesn't lead to a tunable leaf.
// Only own keys count, so a path can never reach __proto__ or other inherited properties.
export function readTunable(path: readonly string[], root: Branch = config): TuneValue | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (!isBranch(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return typeof node === "number" || typeof node === "boolean" || typeof node === "string" ? node : undefined;
}

// Writes a dev panel edit into config. Refuses unknown paths, locked paths, a change of type and non-finite numbers.
export function applyTune(path: readonly string[], value: unknown, root: Branch = config): boolean {
  if (path.length === 0 || isLockedPath(path)) return false;
  const current = readTunable(path, root);
  if (current === undefined || typeof value !== typeof current) return false;
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  let parent = root;
  for (const key of path.slice(0, -1)) parent = parent[key] as Branch;
  parent[path[path.length - 1]!] = value;
  return true;
}

// Copies every tunable leaf that exists in both trees from `source` into `root` (a viewer adopting the server's config).
export function adoptTunables(source: unknown, root: Branch = config): void {
  if (!isBranch(source)) return;
  for (const [key, value] of Object.entries(root)) {
    if (!Object.hasOwn(source, key)) continue;
    const incoming = source[key];
    if (isBranch(value)) adoptTunables(incoming, value);
    else if (typeof incoming === typeof value && (typeof incoming !== "number" || Number.isFinite(incoming))) root[key] = incoming;
  }
}
