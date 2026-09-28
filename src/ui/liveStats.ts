import { totalSpend, type DuelStats } from "../match/protocol.ts";

export type LiveStats = {
  // `receivedAtMs` is when these stats arrived (performance.now), so the clock keeps ticking between updates.
  update(stats: DuelStats | null, receivedAtMs: number, connected: boolean): void;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  created.textContent = text;
  parent.appendChild(created);
  return created;
}

export function formatDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  if (days > 0) return `${days}d ${hours}h ${twoDigits(minutes)}m ${twoDigits(seconds)}s`;
  if (hours > 0) return `${hours}h ${twoDigits(minutes)}m ${twoDigits(seconds)}s`;
  return `${minutes}m ${twoDigits(seconds)}s`;
}

export function formatDollars(dollars: number): string {
  return dollars < 10 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}k`;
  return String(tokens);
}

// Jev vs Jev panel, small on the left above the brain inspector: how long Jev has been spending since the
// server started, and what both Jevs have cost in that time.
export function createLiveStats(root: HTMLElement): LiveStats {
  const panel = element("div", "live-stats", root);
  root.prepend(panel);
  const status = element("div", "live-stats-status", panel);
  const figures = element("div", "live-stats-figures", panel);
  const runtime = element("span", "live-stats-runtime", figures);
  const cost = element("span", "live-stats-cost", figures);
  const detail = element("div", "live-stats-detail", panel);
  let shown = "";

  return {
    update(stats, receivedAtMs, connected) {
      if (!stats) {
        const text = "connecting to the duel…";
        if (shown !== text) status.textContent = shown = text;
        return;
      }
      // Between updates the clock advances locally, but only while Jev is spending.
      const activeMs = stats.activeMs + (stats.spending && connected ? performance.now() - receivedAtMs : 0);
      const spend = totalSpend(stats);
      const lines: [string, string, string, string] = [
        connected ? `● live · ${stats.viewers} watching${stats.spending ? "" : " · clock paused"}` : "○ reconnecting…",
        formatDuration(activeMs),
        `${formatDollars(spend.dollars)} spent`,
        `this session · ${formatTokens(spend.tokens)} tokens · ${spend.requests.toLocaleString()} calls\n` +
          `Demon Jev ${formatDollars(stats.spend.demon.dollars)} · Warlock Jev ${formatDollars(stats.spend.warlock.dollars)}` +
          (stats.jevOnline ? "" : " · Jev offline"),
      ];
      const text = lines.join("\n");
      if (text === shown) return;
      shown = text;
      [status.textContent, runtime.textContent, cost.textContent, detail.textContent] = lines;
      panel.classList.toggle("offline", !connected);
    },
  };
}
