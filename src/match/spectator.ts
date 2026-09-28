import * as THREE from "three";
import { config } from "../config.ts";
import type { GameUi } from "../main.ts";
import type { InspectorView } from "../ui/brainInspector.ts";
import { createDevPanel } from "../ui/devPanel.ts";
import { createLiveStats } from "../ui/liveStats.ts";
import { createPlayback } from "./playback.ts";
import type { ClientMessage, DuelStats, InspectorPayload, InspectSide, ServerMessage } from "./protocol.ts";
import { adoptTunables, applyTune } from "./tuning.ts";

// Watches the one Jev vs Jev duel the server runs. Everyone sees the same duel; the server pays for one pair of Jevs.
// devTools adds the shared tunables panel and F3 to take over; the public build leaves only the inspector and Live panel.
export function startSpectating({ overlay, sideColumn, view, hud, input, inspector, statusElement }: GameUi, devTools: boolean): void {
  const playback = createPlayback();
  const liveStats = createLiveStats(sideColumn);
  const inspected: Partial<Record<InspectSide, InspectorPayload>> = {};
  let stats: DuelStats | null = null;
  let statsReceivedAtMs = 0;
  let socket: WebSocket | null = null;
  let connected = false;
  let elapsedSeconds = 0;

  function send(message: ClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  // Tunables are shared: an edit here changes the server's duel and every other viewer's panel.
  const devPanel = devTools ? createDevPanel((path, value) => send({ type: "tune", path, value })) : null;

  function inspectedSide(): InspectSide | null {
    return inspector.showing === "hidden" ? null : inspector.showing;
  }

  function receive(message: ServerMessage): void {
    if (message.type === "hello") {
      adoptTunables(message.config);
      devPanel?.refresh();
      playback.reset(message.world);
      stats = message.stats;
      statsReceivedAtMs = performance.now();
    } else if (message.type === "step") {
      playback.push(message);
    } else if (message.type === "stats") {
      stats = message.stats;
      statsReceivedAtMs = performance.now();
    } else if (message.type === "inspect") {
      inspected[message.side] = message.view;
    } else if (message.type === "tune") {
      applyTune(message.path, message.value);
      devPanel?.refresh();
    }
  }

  function connect(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const opened = new WebSocket(`${protocol}//${window.location.host}${config.duel.socketPath}`);
    socket = opened;
    opened.addEventListener("open", () => {
      connected = true;
      send({ type: "inspect", side: inspectedSide() });
    });
    opened.addEventListener("message", (event) => receive(JSON.parse(String(event.data)) as ServerMessage));
    opened.addEventListener("close", () => {
      connected = false;
      socket = null;
      window.setTimeout(connect, config.duel.reconnectDelayMs);
    });
  }

  inspector.onChange(() => {
    // Drop what was received earlier, so a tab never shows figures older than the server's next update.
    delete inspected.demon;
    delete inspected.warlock;
    send({ type: "inspect", side: inspectedSide() });
  });
  input.onKey("F2", () => inspector.cycle());
  if (devPanel) {
    input.onKey("Backquote", () => devPanel.toggle());
    input.onKey("F3", () => {
      window.location.search = "?duel=local";
    });
  }
  // The play controls and the aiming cursor don't apply while watching.
  overlay.querySelector<HTMLElement>(".controls-hint")?.remove();
  hud.showBanner("Jev vs Jev", devTools ? "live for everyone watching · F3 to take over Warlock Jev" : "live for everyone watching");
  if (statusElement) {
    statusElement.textContent = devTools
      ? "Watching Jev vs Jev live · F2 inspector · ` shared tunables · F3 take over Warlock Jev"
      : "Watching Jev vs Jev live · F2 inspector";
  }

  function inspectorView(side: InspectSide): InspectorView | null {
    const payload = inspected[side];
    if (!payload) return null;
    return { mode: payload.mode, controller: payload.controller, fallback: payload.fallback, snapshot: () => payload.snapshot };
  }

  const timer = new THREE.Timer();
  timer.connect(document);

  function frame(timestamp: number): void {
    timer.update(timestamp);
    const frameSeconds = Math.min(timer.getDelta(), config.sim.maxCatchUpSeconds);
    elapsedSeconds += frameSeconds;
    liveStats.update(stats, statsReceivedAtMs, connected);
    hud.setMatchWins(stats?.matchWins ?? null);
    const played = playback.advance(frameSeconds);
    if (!played) return;

    const { previous, current, alpha, events, badges } = played;
    // The camera leans toward the warlock's aim instead of the mouse.
    view.render({ previous, current, alpha, events, frameSeconds, elapsedSeconds, warlockAim: current.casters.warlock.aimPoint });
    hud.setDemonBrainLabel(badges.demon.label);
    hud.setWarlockBrainLabel(badges.warlock.label);
    hud.setOutOfMana(badges.demon.outOfMana ?? badges.warlock.outOfMana);
    hud.update(current, events, frameSeconds);
    inspector.update({ demon: inspectorView("demon"), warlock: inspectorView("warlock"), hasWarlock: true }, frameSeconds);
  }

  requestAnimationFrame(function loop(timestamp) {
    frame(timestamp);
    requestAnimationFrame(loop);
  });

  connect();
}
