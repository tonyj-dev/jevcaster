import GUI from "lil-gui";
import { config } from "../config.ts";
import type { TuneValue } from "../match/tuning.ts";

export type DevPanel = {
  toggle(): void;
  // Redraws every control from config, after a change that didn't come from this panel.
  refresh(): void;
};

// Backquote toggles a lil-gui panel over every numeric, boolean and colour tunable in config.
// `onChange` hears every edit made here, with the path into config (Jev vs Jev sends it to the server).
export function createDevPanel(onChange?: (path: readonly string[], value: TuneValue) => void): DevPanel {
  const gui = new GUI({ title: "Jevcaster tunables", width: 320 });
  gui.hide();

  function addFolder(parent: GUI, name: string, values: Record<string, unknown>, path: readonly string[]): void {
    const folder = parent.addFolder(name);
    folder.close();
    for (const [key, value] of Object.entries(values)) {
      const report = (changed: TuneValue) => onChange?.([...path, key], changed);
      if (typeof value === "number") folder.add(values, key).onChange(report);
      else if (typeof value === "boolean") folder.add(values, key).onChange(report);
      else if (typeof value === "string" && value.startsWith("#")) folder.addColor(values, key).onChange(report);
      else if (value && typeof value === "object") addFolder(folder, key, value as Record<string, unknown>, [...path, key]);
    }
  }

  for (const [sectionName, section] of Object.entries(config)) {
    addFolder(gui, sectionName, section as Record<string, unknown>, [sectionName]);
  }

  let visible = false;
  return {
    toggle() {
      visible = !visible;
      if (visible) gui.show();
      else gui.hide();
    },
    refresh() {
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
    },
  };
}
