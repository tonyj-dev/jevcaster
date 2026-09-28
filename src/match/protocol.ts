import type { BrainErrorKind } from "../jev/protocol.ts";
import type { JevBrainSnapshot } from "../jev/stats.ts";
import type { BrainController, BrainMode, FallbackStats } from "../brain/demonBrain.ts";
import type { CasterId, SimEvent, World } from "../sim/types.ts";
import type { TuneValue } from "./tuning.ts";

// Messages on the Jev vs Jev WebSocket (config.duel.socketPath).

export type InspectSide = CasterId;

// outOfMana: why that side's Jev can't be reached, or null while it answers.
export type BrainBadge = { readonly label: string; readonly outOfMana: BrainErrorKind | null };

export type SideSpend = { readonly requests: number; readonly tokens: number; readonly dollars: number };

// The shared duel since the server started (nothing is kept across restarts; TypeSafe's site has the all-time cost).
export type DuelStats = {
  // What each Jev has been billed this session.
  readonly spend: Readonly<Record<CasterId, SideSpend>>;
  // Matches (first to config.sim.roundsToWinMatch rounds) each Jev has won this session.
  readonly matchWins: Readonly<Record<CasterId, number>>;
  // Time Jev has been spending tokens this session: only while an answered request is recent.
  readonly activeMs: number;
  readonly spending: boolean;
  readonly running: boolean;
  readonly viewers: number;
  readonly jevOnline: boolean;
};

export type InspectorPayload = {
  readonly mode: BrainMode;
  readonly controller: BrainController;
  readonly fallback: FallbackStats;
  readonly snapshot: JevBrainSnapshot;
};

export type ServerMessage =
  // First message on every connection: the current world, the server's tunables and the totals.
  | { readonly type: "hello"; readonly world: World; readonly config: unknown; readonly stats: DuelStats }
  // One per sim step, in order.
  | { readonly type: "step"; readonly world: World; readonly events: readonly SimEvent[]; readonly badges: Readonly<Record<CasterId, BrainBadge>> }
  | { readonly type: "stats"; readonly stats: DuelStats }
  // Only to viewers whose inspector shows that side.
  | { readonly type: "inspect"; readonly side: InspectSide; readonly view: InspectorPayload }
  // Another viewer changed a tunable (or the server refused yours and restores the value).
  | { readonly type: "tune"; readonly path: readonly string[]; readonly value: TuneValue };

export type ClientMessage =
  | { readonly type: "inspect"; readonly side: InspectSide | null }
  | { readonly type: "tune"; readonly path: readonly string[]; readonly value: TuneValue };

export const emptySpend: SideSpend = { requests: 0, tokens: 0, dollars: 0 };

export function totalSpend(stats: Pick<DuelStats, "spend">): SideSpend {
  const { warlock, demon } = stats.spend;
  return { requests: warlock.requests + demon.requests, tokens: warlock.tokens + demon.tokens, dollars: warlock.dollars + demon.dollars };
}
