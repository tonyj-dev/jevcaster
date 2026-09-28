import "@fontsource/cinzel/400.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/cinzel-decorative/700.css";
import "./ui/hud.css";
import { createWarlockInput } from "./input/warlockInput.ts";
import { startLocalGame } from "./match/localGame.ts";
import { startSpectating } from "./match/spectator.ts";
import { createGameView } from "./render/gameView.ts";
import { createBrainInspector } from "./ui/brainInspector.ts";
import { createAttackCursor } from "./ui/cursor.ts";
import { createHud } from "./ui/hud.ts";

const gameContainer = document.getElementById("game")!;
const overlay = document.getElementById("overlay")!;

const view = createGameView(gameContainer, overlay);
// The Live panel (spectating only) and the brain inspector stack in one column, centred on the left edge.
const sideColumn = document.createElement("div");
sideColumn.className = "side-column";
overlay.appendChild(sideColumn);
const ui = {
  overlay,
  sideColumn,
  view,
  hud: createHud(overlay),
  attackCursor: createAttackCursor(gameContainer),
  input: createWarlockInput(view.canvas, view.camera),
  inspector: createBrainInspector(sideColumn),
  statusElement: document.getElementById("brain-status"),
};
export type GameUi = typeof ui;

// The production build is the public link: it only watches the shared Jev vs Jev duel, without dev tools.
// On the dev server, ?duel=jev watches that duel and anything else plays the demon here.
const duelMode = new URLSearchParams(window.location.search).get("duel");
if (import.meta.env.PROD) startSpectating(ui, false);
else if (duelMode === "jev") startSpectating(ui, true);
else startLocalGame(ui);
