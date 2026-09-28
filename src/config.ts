// Every tunable lives here. The dev lil-gui panel mutates this object at runtime,
// so read values when you need them instead of copying them at import time.

export const config = {
  brain: {
    // Pinned so tuned thresholds don't drift when jev-latest moves.
    model: "jev-1.13.0",
    endpointPath: "/api/brain",
    statusPath: "/api/brain/status",

    // Round trip of the tick request (~1.9k input tokens), measured with `pnpm brain:probe --runs 20` on 2026-09-27:
    // p50 164 ms, p95 190 ms. The p95 is budgeted when telling Jev whether a cloak can still block a shot in time.
    measuredLatencyP95Ms: 190,

    // How often the demon asks Jev, and how long an answer stays usable.
    duelTick: {
      baseIntervalMs: 200,
      slowIntervalMs: 400,
      timeoutMs: 1000,
      maxRetries: 0,
      maxAnswerAgeMs: 600,
      // A round trip slower than this drops the tick to slowIntervalMs; this many healthy ones in a row bring it back.
      slowLatencyMs: 350,
      healthyStreakToSpeedUp: 5,
      // Sim time a decision keeps driving the demon without a fresher one before the heuristic takes over.
      decisionExpiryMs: 1000,
      // A tick that would repeat the last request word for word is skipped, but never for longer than this,
      // so a decision is always refreshed well before decisionExpiryMs.
      heartbeatMs: 600,
    },
    backoff: {
      // Consecutive failures tolerated before pausing; the pause doubles per further failure up to maxMs.
      failuresBeforeBackoff: 2,
      baseMs: 500,
      maxMs: 8000,
      // No API key on the server: check again this often in case it was added.
      offlineRetryMs: 30_000,
    },
    maxInFlightRequests: 2,

    // Server-side guard; TYPESAFE_MAX_TOKENS_PER_MINUTE in .env overrides it.
    maxTokensPerMinute: 1_000_000,
    dollarsPerMillionInputTokens: 0.042,

    // Hard caps on what the proxy will forward, to keep a bad client from burning budget.
    maxRequestBytes: 64_000,
    maxQuestionsPerRequest: 64,

    // Continuity between decisions (jev/execute.ts). Each answer is picked afresh, so a near tie could flip the walk
    // or the cloak five times a second. A new answer keeps the current choice while Jev still rates it at keepShare
    // or more: a strafe keeps its side, any other walk is kept for moveMinHoldMs, and a cloak is kept over "wait"
    // for cloakMinHoldMs. Anything Jev clearly moves away from switches at once.
    continuity: {
      keepShare: 0.3,
      moveMinHoldMs: 400,
      cloakMinHoldMs: 400,
    },

    // Bucket edges for describing the duel in words (jev/describe/buckets.ts). Jev never sees the numbers.
    describe: {
      closeDistance: 4,
      farDistance: 8,
      imminentSeconds: 0.3,
      soonSeconds: 0.8,
      threatWindowSeconds: 1.5,
      healthyFraction: 0.65,
      criticalFraction: 0.3,
      straightAimDegrees: 8,
      nearAimDegrees: 25,
      castSoonMs: 400,
      movingSpeed: 0.8,
      // A side is open when a dash that way would stay this far inside the arena edge.
      openSideMargin: 0.6,
      // Distance from the arena centre as a share of its radius: inside centreFraction is "centre", beyond edgeFraction "near the edge".
      centreFraction: 0.35,
      edgeFraction: 0.75,
      // A health gap bigger than this share of max health means one side is ahead.
      healthLeadFraction: 0.1,
    },

    inspector: {
      refreshMs: 200,
      latencySamples: 60,
    },
  },

  // Jev vs Jev runs once on the server and is streamed to every viewer over a WebSocket.
  duel: {
    socketPath: "/api/duel",
    // Viewers render this many sim steps behind the newest one, so network jitter doesn't stutter the view.
    interpolationDelaySteps: 3,
    // Beyond this many steps off target the viewer jumps instead of speeding up or slowing down.
    snapSteps: 30,
    // Playback speeds up or slows by this share per step of error, within the clamp, to hold the delay.
    catchUpPerStep: 0.08,
    maxCatchUp: 0.25,
    statsIntervalMs: 500,
    // The running clock counts while either Jev had an answered (billed) request this recently.
    spendingWindowMs: 1000,
    reconnectDelayMs: 2000,
  },

  randomBrain: {
    seed: 5,
    minHoldMs: 250,
    maxHoldMs: 800,
  },

  sim: {
    stepHz: 60,
    // Longest frame gap the loop will catch up on; beyond this the game slows instead of spiralling.
    maxCatchUpSeconds: 0.25,
    arenaRadius: 10.5,
    spawnDistanceFromCenter: 5,
    roundResetDelayMs: 2200,
    roundsToWinMatch: 3,

    caster: {
      radius: 0.5,
      maxHealth: 100,
      moveSpeed: 5.2,
      castHeight: 1.1,
    },
    // Long enough that a dash is a decision, not a reflex: at most one dodge per two or three incoming shots.
    dash: {
      distance: 3.4,
      durationMs: 140,
      cooldownMs: 1500,
    },
    // How long a cast or dash press waits to become legal before it is dropped. A cast press also
    // waits out a spell switch and a held cloak, so a click while cloaked fires on release.
    inputBuffer: {
      castMs: 180,
      dashMs: 150,
    },
    // A mage carries one spell at a time. The orb shows it to the opponent at once;
    // the new spell (and its cloak) can't be used until the switch settles.
    switchMs: 250,
    // Cadence (there is no mana; timing is the only resource):
    // - After any cast, no attack can be cast for this long. The gap is the window to cloak, dash or switch.
    // - Per-spell cooldowns are two to four recoveries long, so repeating one spell attacks every 2.4–4.8 s
    //   while rotating spells attacks about every 1.2 s, at the cost of a visible switch each time.
    castRecoveryMs: 1200,
    // Fire beats frost, frost beats earth, earth beats fire: an attack hits a mage carrying the element it beats this much harder.
    counterDamageMultiplier: 1.5,
    // Movement speed while carrying each spell (lowered further while the cloak is raised).
    carryMoveFactor: {
      fire: 1,
      frost: 1.12,
      earth: 0.85,
    },
    // The cloak is always available and blocks the carried spell's own element. Its price is the wind-up,
    // the slowed walk, no casting while it is up, and that it guards only that element: an opponent who
    // switches to either other element walks straight through it.
    cloak: {
      windUpMs: 150,
      // Share of a same-element attack the cloak absorbs; 1 means no damage at all.
      blockFraction: 1,
      moveFactor: 0.5,
    },
    spells: {
      fire: {
        cooldownMs: 3600,
        speed: 11,
        radius: 0.32,
        minRange: 2.5,
        maxRange: 16,
        directDamage: 18,
        splashRadius: 1.6,
        splashDamage: 9,
        burnDamagePerSecond: 4,
        burnDurationMs: 2000,
      },
      frost: {
        cooldownMs: 2400,
        speed: 22,
        radius: 0.2,
        maxRange: 14,
        damage: 8,
        // Every hit that gets through freezes the target this long.
        freezeMs: 1000,
      },
      earth: {
        cooldownMs: 4800,
        chargeMs: 450,
        range: 11,
        hitRadius: 0.3,
        damage: 26,
      },
    },
  },

  heuristicBrain: {
    seed: 7,
    // Tuned easy for testing (2026-09-27): a strafing warlock survives about 35 s instead of 12 s.
    reactionDelayMs: 350,
    preferredDistance: 7,
    distanceTolerance: 1.5,
    strafeWeight: 1,
    strafeFlipMinMs: 900,
    strafeFlipMaxMs: 2200,
    // How far ahead it notices shots; it still waits reactionDelayMs before acting on one.
    threatWindowSeconds: 1.3,
    dashThreatWindowSeconds: 0.35,
    // Reaction to a noticed threat: dodge, raise the cloak that guards against it (may need a switch), or take it.
    dodgeChance: 0.35,
    cloakChance: 0.15,
    castChancePerSecond: 0.7,
    aimErrorMeters: 2,
    spellWeights: { fire: 0.4, frost: 0.35, earth: 0.25 },
    // Weight multipliers: attacks that beat what the warlock carries, and attacks the warlock's item beats.
    counterPreference: 2.5,
    exposedPreference: 0.4,
  },

  input: {
    // Trackpads fire many wheel events per gesture; take at most one spell switch per window.
    wheelSwitchIntervalMs: 120,
    // 1/2/3 switch to that spell and cast it at the cursor once the switch settles.
    // While the cloak is held they only switch, which re-forms the cloak around the new element.
    quickCast: false,
  },

  render: {
    maxPixelRatio: 2,
    fieldOfViewDegrees: 50,
    cameraTiltDegrees: 55,
    cameraDistance: 16,
    cameraFollowSharpness: 6,
    cameraCursorLean: 0.18,
    cameraDemonFramingPull: 0.3,
    bloomStrength: 0.95,
    bloomRadius: 0.6,
    bloomThreshold: 0.78,
    toneMappingExposure: 1.1,
    // Darkens the screen edges so the candlelit dais reads as the only lit place in the dungeon.
    vignetteStrength: 1.15,
    filmGrain: 0.05,
    candleFlicker: 1,
    hitstopMs: 50,
    screenShakeDecayPerSecond: 3.5,
    maxDynamicLights: 8,
    maxParticles: 6000,
    scorchFadeSeconds: 7,
    damageNumberSeconds: 0.9,
    hitFlashSeconds: 0.09,

    // Hellfire, grave frost and blighted bone. They must stay distinct from each other and from the
    // warlock's violet and the demon's crimson, because the staff orb is how each side reads the other.
    elementColors: {
      fire: "#ff5a12",
      frost: "#7fe4ff",
      earth: "#a8e04a",
    },
    palettes: {
      // You: a hooded warlock in black and violet with bone trim.
      warlock: {
        robe: "#2c1d3a",
        trim: "#b99be0",
        rim: "#9a5cff",
        skin: "#6a5f58",
        eyes: "#c77dff",
        horned: false,
      },
      // The demon: a horned demon in blood red and tarnished brass.
      demon: {
        robe: "#5a0e16",
        trim: "#d08a3a",
        rim: "#ff1f3a",
        skin: "#7a2a22",
        eyes: "#ffb21a",
        horned: true,
      },
    },
    // Accent colours for the chamber: the sigils carved in the dais and the candle flames.
    sigilColor: "#ff1f2e",
    candleColor: "#ff9a3c",
  },
};

export type Config = typeof config;
