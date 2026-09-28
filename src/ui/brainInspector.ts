import { config } from "../config.ts";
import type { DemonDecision, PickedAnswer } from "../jev/decide.ts";
import { actOptions, aimOptions, moveOptions } from "../jev/questions.ts";
import { elements } from "../sim/types.ts";
import type { JevBrainSnapshot } from "../jev/stats.ts";
import type { BrainMode, BrainController, FallbackStats } from "../brain/demonBrain.ts";

// Overlay that shows Jev thinking: probability bars, latency, rates, cost, stale answers and fallbacks.
// Open from the start. Its tabs pick the Jev, × hides it and a button brings it back.
// F2 cycles hidden → demon → warlock (only while Jev plays it) → hidden.
export type BrainInspector = {
  cycle(): void;
  readonly showing: Showing;
  // Hears every change of side or visibility, from a click or from cycle().
  onChange(listener: (showing: Showing) => void): void;
  update(views: InspectorViews, frameSeconds: number): void;
};

// A view is null while its data hasn't arrived (Jev vs Jev gets it from the server).
// hasWarlock: F2 can show the warlock, because a brain plays it.
export type InspectorViews = { demon: InspectorView | null; warlock: InspectorView | null; hasWarlock: boolean };
type InspectedSide = "demon" | "warlock";
export type Showing = "hidden" | InspectedSide;

export type InspectorView = {
  mode: BrainMode;
  controller: BrainController;
  snapshot: () => JevBrainSnapshot;
  fallback: FallbackStats;
};

// The warlock's brain sees a mirrored duel, so in its request JSON it is `demon` and red is `warlock`.
const sideNames: Record<InspectedSide, string> = { demon: "Demon Jev", warlock: "Warlock Jev" };

const questionLabels: Record<keyof DemonDecision, string> = { move: "demon_move", spell: "demon_spell", act: "demon_act", aim: "demon_aim" };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  created.textContent = text;
  parent.appendChild(created);
  return created;
}

const formatMs = (value: number): string => (Number.isFinite(value) ? `${Math.round(value)}` : "–");

function controllerText(mode: BrainMode, controller: BrainController): string {
  if (mode !== "jev") return `${mode} brain`;
  return controller === "jev" ? "Jev in control" : "Jev · heuristic fallback in control";
}

function drawSparkline(canvas: HTMLCanvasElement, values: readonly number[]): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (values.length < 2) return;
  const ceilingMs = Math.max(400, ...values);
  const gate = config.brain.duelTick.slowLatencyMs;
  context.strokeStyle = "rgba(255, 120, 120, 0.35)";
  context.beginPath();
  context.moveTo(0, height - (gate / ceilingMs) * height);
  context.lineTo(width, height - (gate / ceilingMs) * height);
  context.stroke();
  context.strokeStyle = "#d0505a";
  context.lineWidth = 1.5;
  context.beginPath();
  values.forEach((value, index) => {
    const x = (index / (config.brain.inspector.latencySamples - 1)) * width;
    const y = height - (value / ceilingMs) * height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
}

// Every option of every question gets a row that is always there, in a fixed order, so the list never changes height.
// Options that weren't offered this tick (impossible right now) show a dash.
function createAnswerRows(container: HTMLElement, label: string, options: readonly string[]) {
  const block = element("div", "inspector-question", container);
  const heading = element("div", "inspector-question-heading", block);
  element("span", "", heading, label);
  const confidence = element("span", "inspector-dim", heading);
  const rows = options.map((option) => {
    const row = element("div", "inspector-bar", block);
    element("span", "inspector-bar-label", row, option);
    const track = element("span", "inspector-bar-track", row);
    const fill = element("span", "inspector-bar-fill", track);
    const value = element("span", "inspector-bar-value", row);
    return { option, row, fill, value };
  });

  return (answer: PickedAnswer<string> | null): void => {
    confidence.textContent = answer ? `confidence ${answer.confidence.toFixed(2)}` : "";
    for (const { option, row, fill, value } of rows) {
      const probability = answer?.probabilities[option];
      row.classList.toggle("picked", answer?.option === option);
      row.classList.toggle("not-offered", answer !== null && probability === undefined);
      fill.style.width = `${((probability ?? 0) * 100).toFixed(1)}%`;
      value.textContent = probability === undefined ? "–" : probability.toFixed(2);
    }
  };
}

export function createBrainInspector(root: HTMLElement): BrainInspector {
  const openButton = element("button", "inspector-open", root, "Brain inspector");
  openButton.title = "Show what Jev is thinking (F2)";
  const panel = element("div", "inspector", root);
  const header = element("div", "inspector-header", panel);
  element("span", "inspector-title", header, "Brain inspector");
  const tabs = element("span", "inspector-tabs", header);
  const tabButtons = {} as Record<InspectedSide, HTMLButtonElement>;
  for (const side of ["demon", "warlock"] as const) {
    tabButtons[side] = element("button", "inspector-tab", tabs, sideNames[side]);
    tabButtons[side].addEventListener("click", () => show(side));
  }
  const closeButton = element("button", "inspector-close", header, "×");
  closeButton.title = "Hide (F2)";
  const modeLine = element("div", "inspector-mode", panel);
  const decisionHeading = element("div", "inspector-section", panel, "Last decision");
  const decisionContainer = element("div", "", panel);
  const questionOptions: Record<keyof DemonDecision, readonly string[]> = { act: actOptions, spell: elements, move: moveOptions, aim: aimOptions };
  const answerRows = (["act", "spell", "move", "aim"] as const).map((key) => ({
    key,
    show: createAnswerRows(decisionContainer, questionLabels[key], questionOptions[key]),
  }));
  const showDecision = (decision: DemonDecision | null): void => {
    for (const { key, show } of answerRows) show(decision ? decision[key] : null);
  };
  // The figures come after the decision: their line count varies, and that shouldn't move the bars.
  const latencyRow = element("div", "inspector-latency", panel);
  const sparkline = element("canvas", "inspector-sparkline", latencyRow);
  sparkline.width = 316;
  sparkline.height = 34;
  const latencyText = element("div", "inspector-stats", latencyRow);
  const statsText = element("div", "inspector-stats", panel);
  const requestDetails = element("details", "inspector-details", panel);
  element("summary", "", requestDetails, "Last request · state");
  const requestJson = element("pre", "", requestDetails);
  const responseDetails = element("details", "inspector-details", panel);
  element("summary", "", responseDetails, "Last response");
  const responseJson = element("pre", "", responseDetails);

  let showing: Showing = "demon";
  let warlockAvailable = false;
  let refreshCooldownSeconds = 0;
  let shownDecision: DemonDecision | null = null;
  const listeners: ((showing: Showing) => void)[] = [];

  function show(next: Showing): void {
    showing = next;
    panel.classList.toggle("visible", showing !== "hidden");
    openButton.classList.toggle("visible", showing === "hidden");
    for (const side of ["demon", "warlock"] as const) tabButtons[side].classList.toggle("active", showing === side);
    refreshCooldownSeconds = 0;
    for (const listener of listeners) listener(showing);
  }
  closeButton.addEventListener("click", () => show("hidden"));
  openButton.addEventListener("click", () => show("demon"));
  show(showing);

  return {
    cycle() {
      show(showing === "hidden" ? "demon" : showing === "demon" && warlockAvailable ? "warlock" : "hidden");
    },
    get showing() {
      return showing;
    },
    onChange(listener) {
      listeners.push(listener);
    },
    update(views, frameSeconds) {
      warlockAvailable = views.hasWarlock;
      tabs.classList.toggle("single", !views.hasWarlock);
      if (showing === "hidden") return;
      refreshCooldownSeconds -= frameSeconds;
      if (refreshCooldownSeconds > 0) return;
      refreshCooldownSeconds = config.brain.inspector.refreshMs / 1000;
      const side: InspectedSide = showing === "warlock" && views.hasWarlock ? "warlock" : "demon";
      const view = views[side];
      if (!view) {
        // Blank the rest too, so the other side's figures aren't shown under this tab.
        modeLine.textContent = "waiting for the server…";
        modeLine.classList.remove("fallback");
        drawSparkline(sparkline, []);
        latencyText.textContent = statsText.textContent = requestJson.textContent = responseJson.textContent = "";
        decisionHeading.textContent = "Last decision";
        showDecision(null);
        shownDecision = null;
        return;
      }

      const snapshot = view.snapshot();
      modeLine.textContent = controllerText(view.mode, view.controller);
      modeLine.classList.toggle("fallback", view.mode === "jev" && view.controller !== "jev");

      drawSparkline(sparkline, snapshot.latencies);
      latencyText.textContent =
        `round trip p50 ${formatMs(snapshot.latencyP50Ms)} · p95 ${formatMs(snapshot.latencyP95Ms)} ms\n` +
        `tick every ${snapshot.intervalMs} ms · in flight ${snapshot.inFlight}` +
        (snapshot.pausedReason ? `\npaused: ${snapshot.pausedReason}` : "");

      const staleTotal = Object.values(snapshot.stale).reduce((sum, count) => sum + count, 0);
      const answered = snapshot.applied + staleTotal;
      const stalePercent = answered ? (staleTotal / answered) * 100 : 0;
      const fallbackSteps = view.fallback.fallbackSteps + view.fallback.jevSteps;
      const fallbackPercent = fallbackSteps ? (view.fallback.fallbackSteps / fallbackSteps) * 100 : 0;
      const failures = Object.entries(snapshot.failures).map(([kind, count]) => `${kind} ${count}`);
      statsText.textContent = [
        `${snapshot.decisionsPerSecond.toFixed(1)} decisions/s · ${snapshot.requestsPerMinute.toFixed(0)} req/min`,
        `${(snapshot.tokensPerMinute / 1000).toFixed(0)}k tokens/min · $${snapshot.dollarsPerHour.toFixed(2)}/h · spent $${snapshot.totalDollars.toFixed(4)}`,
        `applied ${snapshot.applied} · stale ${staleTotal} (${stalePercent.toFixed(1)}%)` +
          (staleTotal ? ` [old ${snapshot.stale.too_old}, round ${snapshot.stale.round_changed}, frozen ${snapshot.stale.demon_frozen}, superseded ${snapshot.stale.superseded}]` : "") +
          (snapshot.invalid ? ` · invalid ${snapshot.invalid}` : ""),
        `fallback took over ${view.fallback.takeovers}× · ${fallbackPercent.toFixed(1)}% of fighting steps`,
        failures.length ? `failures: ${failures.join(", ")}` : "",
        snapshot.lastError ? `last error: ${snapshot.lastError}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const decision = snapshot.lastDecision;
      const age = snapshot.lastDecisionAgeMs;
      decisionHeading.textContent = decision ? `Last decision · ${age === null ? "" : `${Math.round(age)} ms ago`}` : "Last decision · none yet";
      if (decision !== shownDecision) {
        shownDecision = decision;
        showDecision(decision);
      }
      if (requestDetails.open) requestJson.textContent = snapshot.lastRequest ? JSON.stringify(snapshot.lastRequest.state, null, 2) : "none yet";
      if (responseDetails.open) responseJson.textContent = snapshot.lastResponse ? JSON.stringify(snapshot.lastResponse, null, 2) : "none yet";
    },
  };
}
