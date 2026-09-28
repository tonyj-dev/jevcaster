import type { config } from "../config.ts";
import type { Vector2 } from "./vector.ts";

export type SimTuning = typeof config.sim;

export type Element = "fire" | "frost" | "earth";
export const elements: readonly Element[] = ["fire", "frost", "earth"];
export type ProjectileElement = Exclude<Element, "earth">;

// Each attack beats the next: fire melts frost, frost cracks earth, earth smothers fire.
export const beats: Readonly<Record<Element, Element>> = { fire: "frost", frost: "earth", earth: "fire" };
export const beatenBy: Readonly<Record<Element, Element>> = { frost: "fire", earth: "frost", fire: "earth" };

export type CasterId = "warlock" | "demon";
export const casterIds: readonly CasterId[] = ["warlock", "demon"];
export const opponentOf = (casterId: CasterId): CasterId => (casterId === "warlock" ? "demon" : "warlock");

// What a mage wants to do this step. The keyboard and every brain produce this same shape.
// One sim step of intent for one mage: the only thing the engine takes from a warlock, whether a human
// (input/warlockInput.ts), the heuristic, or Jev (jev/execute.ts turns a decision into this).
export type CasterInput = {
  // Walk direction on the floor, length up to 1.
  readonly move: Vector2;
  readonly aimPoint: Vector2;
  // Held: fire every time the carried spell is ready.
  readonly castHeld: boolean;
  // A single press: buffered by the sim, so it fires if it becomes legal within the buffer window.
  readonly castPressed: boolean;
  // Raise and hold the cloak of the carried spell.
  readonly cloakHeld: boolean;
  // A single press, buffered like castPressed.
  readonly dashPressed: boolean;
  // Switch to this spell (null keeps the current one).
  readonly carry: Element | null;
};

export type CloakPhase = "none" | "raising" | "up";

export type Cloak = {
  readonly phase: CloakPhase;
  // The element this cloak blocks, fixed when it was raised.
  readonly guards: Element;
  readonly elapsedMs: number;
};

export type EarthCharge = {
  readonly remainingMs: number;
  readonly direction: Vector2;
};

export type Caster = {
  readonly id: CasterId;
  readonly position: Vector2;
  readonly velocity: Vector2;
  readonly aimPoint: Vector2;
  readonly health: number;
  readonly alive: boolean;
  readonly carried: Element;
  readonly switchRemainingMs: number;
  readonly recoveryRemainingMs: number;
  readonly cooldownsMs: Readonly<Record<Element, number>>;
  readonly dashCooldownMs: number;
  readonly dashRemainingMs: number;
  readonly dashDirection: Vector2;
  readonly cloak: Cloak;
  readonly charge: EarthCharge | null;
  readonly burnRemainingMs: number;
  readonly freezeRemainingMs: number;
  // Presses waiting to become legal. A buffered cast waits out the switch and a held cloak without expiring.
  readonly bufferedCastMs: number;
  readonly bufferedDashMs: number;
};

export type Projectile = {
  readonly id: number;
  readonly ownerId: CasterId;
  readonly element: ProjectileElement;
  readonly position: Vector2;
  readonly velocity: Vector2;
  // Fire bursts here; frost simply fades out at the end of its range.
  readonly detonationPoint: Vector2;
  readonly remainingDistance: number;
};

export type RoundPhase = "fighting" | "ended";

export type RoundState = {
  readonly number: number;
  readonly wins: Readonly<Record<CasterId, number>>;
  readonly phase: RoundPhase;
  readonly winner: CasterId | null;
  readonly phaseElapsedMs: number;
};

export type World = {
  readonly tick: number;
  readonly timeMs: number;
  readonly casters: Readonly<Record<CasterId, Caster>>;
  readonly projectiles: readonly Projectile[];
  readonly nextEntityId: number;
  readonly round: RoundState;
};

export type BufferedAction = "cast" | "dash";

export type HitKind = "direct" | "splash" | "spikes";

export type SimEvent =
  | { readonly type: "carryChanged"; readonly casterId: CasterId; readonly from: Element; readonly to: Element }
  | { readonly type: "projectileSpawned"; readonly projectile: Projectile }
  | { readonly type: "earthCharging"; readonly casterId: CasterId; readonly from: Vector2; readonly direction: Vector2 }
  | { readonly type: "earthStrike"; readonly casterId: CasterId; readonly from: Vector2; readonly to: Vector2; readonly hitCasterId: CasterId | null }
  | { readonly type: "dashed"; readonly casterId: CasterId; readonly from: Vector2; readonly direction: Vector2 }
  | {
      readonly type: "hit";
      readonly casterId: CasterId;
      readonly sourceId: CasterId;
      readonly element: Element;
      readonly kind: HitKind;
      readonly damage: number;
      readonly blocked: boolean;
      // The target was carrying the element this attack beats.
      readonly countered: boolean;
      readonly position: Vector2;
    }
  | { readonly type: "exploded"; readonly projectileId: number; readonly ownerId: CasterId; readonly element: ProjectileElement; readonly position: Vector2 }
  | { readonly type: "projectileFaded"; readonly projectileId: number; readonly element: ProjectileElement; readonly position: Vector2 }
  | { readonly type: "cloakRaising"; readonly casterId: CasterId; readonly guards: Element }
  | { readonly type: "cloakRaised"; readonly casterId: CasterId; readonly guards: Element }
  | { readonly type: "cloakDropped"; readonly casterId: CasterId; readonly guards: Element }
  | { readonly type: "earthCancelled"; readonly casterId: CasterId }
  | { readonly type: "pressExpired"; readonly casterId: CasterId; readonly action: BufferedAction }
  | { readonly type: "frozen"; readonly casterId: CasterId }
  | { readonly type: "thawed"; readonly casterId: CasterId }
  | { readonly type: "casterDied"; readonly casterId: CasterId; readonly position: Vector2 }
  | { readonly type: "roundEnded"; readonly winner: CasterId; readonly round: number }
  | { readonly type: "roundStarted"; readonly round: number };

export type StepResult = { readonly world: World; readonly events: readonly SimEvent[] };
