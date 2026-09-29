
# Jevcaster


https://github.com/user-attachments/assets/f6c0442b-4d50-452f-86b0-2feade5f61d2

A browser duel: Warlock Jev against Demon Jev, both controlled in real time by TypeSafe's **Jev** model.
Both mages have the same kit: three spells in a counter triangle (fire beats frost, frost beats earth, earth beats fire),
a cloak that blocks only the carried spell's element, and a dash. Each side can see which spell the other is carrying.

```
pnpm install
cp .env.example .env      # add TYPESAFE_API_KEY (server-side only)
pnpm dev                  # play at http://localhost:5173 (without a key the demon uses the heuristic brain)
pnpm test                 # unit tests, no network
pnpm brain:probe --dry-run   # print the exact request Jev receives, without calling it
```

`F1` switches the demon's brain (Jev, heuristic, random). The brain inspector (Jev's last answers, latency, spend) starts open;
its tabs pick the Jev, `×` or `F2` hides it. `F3` switches to watching the shared Jev vs Jev duel that the server runs.

## How Jev plays

Each Jev plays one mage. About five times a second, the game asks Jev what that mage should do next. Every tick goes through three steps:

1. **Describe.** Code turns the world into words (the *state*) and writes four multiple-choice *questions*.
2. **Decide.** Jev answers each question with a probability for every option. The game takes the top pick.
3. **Execute.** Code turns the picks into the mage's input for every 60 Hz sim step until the next answer, and the renderer draws the result.

```
            1. describe                        2. decide                        3. execute and render
World ──► state.ts ─────┐                                                 ┌──► decide.ts ──► execute.ts ──► sim ──► renderer
          (in words)    ├──► { state, questions } ──► Jev (jev-1.13.0) ───┤    (top pick     (CasterInput,     (60 Hz)
World ──► questions.ts ─┘                             via the server      └── probabilities  every step)
          (options)                                                          per option
```

Both Jevs use the same code. Warlock Jev is asked about a mirrored duel, so it also sees itself as `demon` and its opponent as `warlock`.
Only the server talks to Jev ([`server/brainHandler.ts`](server/brainHandler.ts)): the Jev vs Jev host calls it directly,
and local play in the browser goes through `POST /api/brain`.

The loop is in [`src/jev/`](src/jev). Read it in this order:

| File | Role |
|---|---|
| [`protocol.ts`](src/jev/protocol.ts) | The wire schema: `{ state, questions }` in, one `ChoiceAnswer` per question out |
| [`state.ts`](src/jev/state.ts) | `DuelSituation`, the duel as Jev sees it: words and buckets, never coordinates |
| [`questions.ts`](src/jev/questions.ts) | The four questions, their options, and when each option is right |
| [`decide.ts`](src/jev/decide.ts) | Answers → `DemonDecision`: the top pick per question, and whether the answer is too old to use |
| [`execute.ts`](src/jev/execute.ts) | `DemonDecision` → `CasterInput`, the engine's input for each sim step |
| [`jevBrain.ts`](src/jev/jevBrain.ts) | The loop that ties these together: ask, receive, apply |
| `scheduler.ts`, `stats.ts` | When to send (backoff, slow mode); inspector bookkeeping |
| `describe/` | Helpers for `state.ts`: buckets, the demon's left and right, the warlock's recent actions |

`pnpm brain:probe --dry-run` prints a full request without calling Jev. In the game, the brain inspector shows the last
request, the last response and the picks, live.

### 1. What is sent to Jev

One JSON request per tick, about 1.9k tokens:

```ts
{
  state:     DuelSituation,                     // the duel in words (state.ts)
  questions: Record<string, {                   // what to decide (questions.ts)
    type: "choice",
    instructions: string,                       // the question
    criteria: Record<option, string>,           // each option, and when it is right
  }>,
}
```

**The state.** Jev is weak at arithmetic and distances, so code measures everything and sends only words.
Distances become `close` / `mid` / `far`, and arrival times become `imminent` / `in about half a second`. Left and right
are from the demon's point of view, facing its opponent. Jev never sees coordinates, timers or the size of the arena.
The counter triangle (which spell beats which) comes already worked out, and so does the opponent's cloak: `warlock.cloak`
says which elements go through it and that the warlock can't cast behind it, and `counters.warlockCloakBlocks` names the
one element it stops. Otherwise Jev tends to read any cloak as "the warlock is safe" and hold its fire. A real example:

```jsonc
{
  "warlock":  { "health": "hurt", "carrying": "fire", "cloak": "no cloak up", "movement": "strafing to their left",
                "status": "normal", "openings": "just cast, so it can't cast again yet" },
  "demon":    { "health": "healthy", "carrying": "frost", "canCast": "now (frost)", "onCooldown": ["earth"],
                "cloak": "no cloak up", "position": "near the edge", "openSides": "left is open; right is near the arena edge" },
  "between":  { "distance": "mid", "warlockAim": "straight at the demon",
                "incomingToDemon": [{ "element": "fire", "arrives": "in about half a second",
                                      "cloakCanBlock": "yes, if it cloaks now (switching to fire costs no time)" }] },
  "counters": { "warlockWeakTo": "earth", "demonHasWarlockWeaknessReady": "no", "riskyForDemonToCarry": "frost",
                "warlockCloakBlocks": "nothing" },
  "round":    "round 2 of 5; warlock leads 1–0; demon ahead on health"
}
```

**The questions.** Four per tick, always the same:

| Question | Options |
|---|---|
| `demon_move` | `advance` `back_off` `strafe_left` `strafe_right` `hold` |
| `demon_spell` | `fire` `frost` `earth` |
| `demon_act` | `cast` `cloak` `dash_left` `dash_right` `wait` |
| `demon_aim` | `straight_at_warlock` `lead_warlock_movement` |

Each option's criterion names the state fields it depends on. Options that are impossible right now are left out.
In the example above, the right side is near the edge, so `demon_act` offers `dash_left` but not `dash_right`:

```jsonc
"demon_act": {
  "type": "choice",
  "instructions": "You control `demon`, a mage dueling `warlock` in a round arena; ... What should the demon do right now?",
  "criteria": {
    "cast":      "Cast at the warlock. Right when `demon.canCast` starts with now or in a moment and nothing in `between.incomingToDemon` is imminent. ... Wrong when `counters.warlockCloakBlocks` is the spell named in `demon.canCast`.",
    "cloak":     "Raise the cloak and hold it. Right when an item in `between.incomingToDemon` has `cloakCanBlock` starting with yes. ...",
    "dash_left": "Dash to the demon's left. Right when an item in `between.incomingToDemon` arrives imminent or in about half a second and its `cloakCanBlock` does not start with yes, ...",
    "wait":      "Keep moving, don't cast. Right when nothing is incoming and `demon.canCast` does not start with now."
  }
}
```

### 2. What Jev returns

For every question, Jev returns a probability for each option it was offered, its top choice, and a confidence score.
The confidence is 0 when every option is equally likely and 1 when one option has all the probability.
Jev only picks options; it doesn't compute positions, directions or timings. Here is Jev's answer to the example above
(recorded, 150 ms round trip):

```jsonc
{
  "demon_move":  { "choice": "strafe_left", "probabilities": { "strafe_left": 0.87, "advance": 0.10, "back_off": 0.03, "strafe_right": 0, "hold": 0 }, "confidence": 0.83 },
  "demon_spell": { "choice": "fire", "probabilities": { "fire": 0.42, "earth": 0.33, "frost": 0.25 }, "confidence": 0.13 },
  "demon_act":   { "choice": "cloak", "probabilities": { "cloak": 0.93, "dash_left": 0.04, "cast": 0.03, "wait": 0 }, "confidence": 0.91 },
  "demon_aim":   { "choice": "lead_warlock_movement", "probabilities": { "lead_warlock_movement": 0.98, "straight_at_warlock": 0.02 }, "confidence": 0.97 }
}
```

A fire bolt arrives in about half a second and the cloak can still block it, so Jev cloaks and sidesteps to the open side.

[`decide.ts`](src/jev/decide.ts) turns the answers into one `DemonDecision`:

- **Top pick, by family.** The demon takes the most likely option, but mirrored options count together first: dash_left 0.3 + dash_right 0.3 beats cloak 0.4, then the likelier side wins. Jev often splits a dodge evenly when it is sure it should dodge.
- **Staleness.** An answer is dropped if the round changed or the demon was frozen since the request left, or if the answer is more than 600 ms old.

### 3. How the decision is executed and rendered

**Execute.** [`execute.ts`](src/jev/execute.ts) turns the decision into a `CasterInput`, the same kind of input a human's
keyboard and mouse produce. It is applied on every 60 Hz sim step until a fresher decision arrives, about every 200 ms:

| Pick | Becomes | On screen |
|---|---|---|
| `demon_move` | `move`: a walking direction relative to the opponent, pulled away from the arena edge | the mage walks |
| `demon_spell` | `carry`: the spell to hold | the orb over the mage changes colour, which the opponent can see |
| `demon_act` | `castHeld`, `cloakHeld` or `dashPressed`: a cast or a dash fires once per decision, a cloak is held | the spell flies, the cloak rises, or the mage dashes |
| `demon_aim` | `aimPoint`: computed in code from both mages' positions and velocities | where the mage faces and casts |

A few rules sit between the decision and the input:

- **Continuity.** A fresh pick doesn't flip a strafe or drop a cloak that Jev still rates reasonably, so near ties don't jitter.
- **The act overrides the spell when it has to.** To cloak, the mage carries the element that is actually incoming. To cast, it uses a ready spell if the chosen one isn't ready.
- **Fallback.** With no fresh decision (the first second, no API key, backing off after errors), the heuristic brain drives the mage ([`src/brain/demonBrain.ts`](src/brain/demonBrain.ts)). The HUD then shows `(fallback)` after its name.

**Simulate.** The sim ([`src/sim/`](src/sim)) applies both inputs with `stepWorld(world, { warlock, demon }, dt)` and returns
the next `World` plus events (a cast, a hit, a death). It doesn't know brains exist, so a Jev and a human play by the same rules.

**Render.** In local play, the browser runs the sim and draws it. In Jev vs Jev, the server runs one sim for everyone
and streams every step (the `World` and its events) over a WebSocket. Each viewer plays the stream three steps behind
the newest one and interpolates between steps, so network jitter doesn't cause stutter ([`src/match/playback.ts`](src/match/playback.ts)).
The three.js renderer ([`src/render/`](src/render)) draws the mages, spells, cloaks and hit effects from the `World`. The HUD
shows health, rounds and matches won. The brain inspector shows the same answers as probability bars, with the pick highlighted.

All the thresholds live in [`src/config.ts`](src/config.ts) under `brain`. On the dev server they can be changed live from the dev panel (`` ` ``).

## The rest of the code

| Folder | Role |
|---|---|
| `src/sim/` | The deterministic 60 Hz duel: `stepWorld(world, { warlock, demon }: CasterInput, dt)`. It doesn't know brains exist |
| `src/brain/` | The other brains (heuristic, random), the F1 switcher with fallback, and mirroring for Jev vs Jev |
| `src/match/` | Runs the sim with the brains: local play in the browser, and the Jev vs Jev stream |
| `src/render/`, `src/ui/`, `src/input/` | three.js scene and effects, HUD and inspector, keyboard and mouse |
| `server/` | The `/api/brain` proxy (the only place that holds the API key) and the Jev vs Jev WebSocket host |
| `scripts/` | `brain:probe` (latency and answers from the real model), `brain:size` (request size) |


### Sharing it

`pnpm build && pnpm serve` is the public version, safe to put behind a link (on port `PORT`, default 4173).
It only shows the shared Jev vs Jev duel, with the Live panel and the brain inspector, and none of the dev tools:
no local play, no `/api/brain` (visitors can't spend the key) and no tunables. What Jev costs doesn't depend
on how many people watch, and the duel stops when the last viewer leaves. The duel socket is compressed,
but each viewer still receives a step 60 times a second, so host it somewhere with decent upload (a small VPS behind
Caddy for HTTPS, or `cloudflared tunnel --url http://localhost:4173` for a quick try from your own machine).

Jev calls cost money ($0.042 per million input tokens, about 1.9k tokens per tick). The proxy enforces a per-minute token budget
(`TYPESAFE_MAX_TOKENS_PER_MINUTE`).
