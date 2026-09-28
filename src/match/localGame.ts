import * as THREE from "three";
import { createFetchTransport, createJevBrain } from "../jev/jevBrain.ts";
import type { BrainStatus } from "../jev/protocol.ts";
import { brainLabel, createDemonBrain } from "../brain/demonBrain.ts";
import { config } from "../config.ts";
import type { GameUi } from "../main.ts";
import type { SimEvent } from "../sim/types.ts";
import { createDevPanel } from "../ui/devPanel.ts";
import { createDuelEngine } from "./engine.ts";

// You play the warlock against the demon, simulated in this tab. Each warlock's Jev costs are their own.
export function startLocalGame({ view, hud, attackCursor, input, inspector, statusElement }: GameUi): void {
  const devPanel = createDevPanel();
  const demonBrain = createDemonBrain(createJevBrain({ transport: createFetchTransport() }));
  const engine = createDuelEngine({ demon: demonBrain, warlock: null });
  let paused = false;
  let elapsedSeconds = 0;

  function setPaused(nextPaused: boolean): void {
    paused = nextPaused;
    hud.setPaused(paused);
  }
  input.onKey("Escape", () => setPaused(!paused));
  input.onKey("Backquote", () => devPanel.toggle());
  input.onKey("F1", () => {
    demonBrain.cycleMode();
    hud.showBanner(`Demon Jev brain: ${demonBrain.mode}`, "F1 cycles Jev · heuristic · random");
  });
  input.onKey("F2", () => inspector.cycle());
  // Jev vs Jev is one shared duel on the server; F3 goes to watch it.
  input.onKey("F3", () => {
    window.location.search = "?duel=jev";
  });
  input.onKey("F4", () => {
    config.input.quickCast = !config.input.quickCast;
    hud.showBanner(config.input.quickCast ? "Quick-cast on" : "Quick-cast off", config.input.quickCast ? "1–3 switch and cast · hold right-click to only switch" : "1–3 only switch · click to cast");
  });
  window.addEventListener("blur", () => setPaused(true));
  view.canvas.addEventListener("pointerdown", () => {
    if (paused) setPaused(false);
  });

  // Timer.connect ignores the time a hidden tab spends in the background.
  const timer = new THREE.Timer();
  timer.connect(document);

  // Fixed 60 Hz simulation, rendering at display rate with interpolation between the last two steps.
  function frame(timestamp: number): void {
    timer.update(timestamp);
    const frameSeconds = Math.min(timer.getDelta(), config.sim.maxCatchUpSeconds);
    const warlockInput = input.read();
    let events: readonly SimEvent[] = [];
    if (!paused) {
      elapsedSeconds += frameSeconds;
      const result = engine.advance(frameSeconds, warlockInput);
      if (result.pressesConsumed) input.acknowledgePresses();
      events = result.events;
    }

    const world = engine.world;
    const renderSeconds = paused ? 0 : frameSeconds;
    view.render({ previous: engine.previous, current: world, alpha: engine.alpha, events, frameSeconds: renderSeconds, elapsedSeconds, warlockAim: warlockInput.aimPoint });
    hud.setDemonBrainLabel(brainLabel(demonBrain));
    hud.setWarlockBrainLabel(null);
    hud.setOutOfMana(demonBrain.outOfMana());
    hud.update(world, events, frameSeconds);
    inspector.update(
      {
        demon: { mode: demonBrain.mode, controller: demonBrain.controller, snapshot: () => demonBrain.snapshot(world), fallback: demonBrain.fallbackStats() },
        warlock: null,
        hasWarlock: false,
      },
      frameSeconds,
    );
    attackCursor.update(world.casters.warlock, world.round.phase === "fighting");
  }

  requestAnimationFrame(function loop(timestamp) {
    frame(timestamp);
    requestAnimationFrame(loop);
  });

  void showBrainStatus(statusElement);
}

async function showBrainStatus(statusElement: HTMLElement | null): Promise<void> {
  if (!statusElement) return;
  try {
    const response = await fetch(config.brain.statusPath);
    const status = (await response.json()) as BrainStatus;
    statusElement.textContent = status.hasApiKey
      ? `Jev online (${status.model}) · F1 switches brain · F2 inspector · F3 watch Jev vs Jev`
      : "Jev offline (no TYPESAFE_API_KEY) · heuristic fallback · F1 switches brain · F2 inspector · F3 watch Jev vs Jev";
  } catch {
    statusElement.textContent = "brain proxy unreachable · heuristic fallback · F1 switches brain · F2 inspector";
  }
}
