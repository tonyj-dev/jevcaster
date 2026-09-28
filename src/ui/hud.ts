import { config } from "../config.ts";
import type { BrainErrorKind } from "../jev/protocol.ts";
import { isCloaking } from "../sim/caster.ts";
import type { Caster, CasterId, Element, SimEvent, World } from "../sim/types.ts";
import { beats, elements } from "../sim/types.ts";

export type Hud = {
  update(world: World, events: readonly SimEvent[], frameSeconds: number): void;
  setDemonBrainLabel(label: string): void;
  // Null while a human plays the warlock; otherwise the brain playing it (Jev vs Jev).
  setWarlockBrainLabel(label: string | null): void;
  // Shows "Jev is out of mana" while Jev can't be reached (null hides it).
  setOutOfMana(reason: BrainErrorKind | null): void;
  // Matches each Jev has won since the server started, under the round label (null hides it: local play).
  setMatchWins(wins: Readonly<Record<CasterId, number>> | null): void;
  setPaused(paused: boolean): void;
  showBanner(text: string, subtitle?: string): void;
};

const bannerSeconds = 1.8;
// The line under "Jev is out of mana", by why Jev can't be reached. The fallback brain plays meanwhile.
const manaLines: Partial<Record<BrainErrorKind, string>> = {
  no_api_key: "No mana well on the server: TYPESAFE_API_KEY is missing",
  budget_exceeded: "This minute's mana is spent · it trickles back soon",
  rate_limited: "Too many spells at once · Jev is catching its breath",
};
const manaFallbackLine = "The spirits aren't answering · fighting on instinct until they return";
const spellNames: Record<Element, string> = { fire: "Hellfire", frost: "Grave Lance", earth: "Bone Spikes" };
// The trade-off of carrying each spell, in a few words.
const spellTraits: Record<Element, string> = { fire: "splash · burn", frost: "quick · freezes", earth: "heavy · rooted" };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  created.textContent = text;
  parent.appendChild(created);
  return created;
}

// The name already says Jev, so the brain is only named when something else is playing (a fallback, the heuristic).
const panelName = (name: string, brainLabel: string | null): string => (brainLabel === null || brainLabel === "Jev" ? name : `${name} · ${brainLabel}`);

function createCasterPanel(parent: HTMLElement, side: CasterId, name: string) {
  const wrapper = element("div", `health health-${side}`, parent);
  const label = element("div", "health-label", wrapper, name);
  const track = element("div", "health-track", wrapper);
  const trailing = element("div", "health-trailing", track);
  const fill = element("div", "health-fill", track);
  const pips = element("div", "round-pips", wrapper);
  const pipElements = Array.from({ length: config.sim.roundsToWinMatch }, () => element("span", "pip", pips));
  return { label, fill, trailing, pipElements };
}

function createSlot(parent: HTMLElement, key: string, name: string, color: string, trait: string, edge = "") {
  const slot = element("div", "slot", parent);
  slot.style.setProperty("--slot-color", color);
  element("div", "slot-key", slot, key);
  element("div", "slot-name", slot, name);
  element("div", "slot-cost", slot, trait);
  const edgeLabel = element("div", "slot-edge", slot, edge);
  const cooldown = element("div", "slot-cooldown", slot);
  const timer = element("div", "slot-timer", slot);
  return { slot, edgeLabel, cooldown, timer };
}

export function createHud(root: HTMLElement): Hud {
  const top = element("div", "hud-top", root);
  const warlockPanel = createCasterPanel(top, "warlock", "Warlock Jev");
  const center = element("div", "hud-center", top);
  const roundLabel = element("div", "round-label", center, "Round 1");
  const matchScore = element("div", "match-score", center);
  const warlockMatchWins = element("span", "match-wins warlock", matchScore);
  element("span", "match-score-label", matchScore, "matches won");
  const demonMatchWins = element("span", "match-wins demon", matchScore);
  let shownMatchWins = "";
  const demonPanel = createCasterPanel(top, "demon", "Demon Jev");

  const bottom = element("div", "hud-bottom", root);
  const spellSlots = Object.fromEntries(
    elements.map((spell, index) => [
      spell,
      createSlot(bottom, String(index + 1), spellNames[spell], config.render.elementColors[spell], spellTraits[spell], `beats ${beats[spell]}`),
    ]),
  ) as Record<Element, ReturnType<typeof createSlot>>;
  element("div", "slot-divider", bottom);
  const cloakSlot = createSlot(bottom, "RMB", "Cloak", config.render.elementColors.fire, "hold", "blocks fire");
  const dashSlot = createSlot(bottom, "Space", "Dash", "#d8cbb0", "");

  const banner = element("div", "banner", root);
  const bannerTitle = element("div", "banner-title", banner);
  const bannerSubtitle = element("div", "banner-subtitle", banner);
  const pausedOverlay = element("div", "paused", root, "Paused · Esc to resume");
  const frameStats = element("div", "frame-stats", root);
  const manaNotice = element("div", "mana-out", root);
  element("div", "mana-vial", manaNotice);
  const manaText = element("div", "", manaNotice);
  element("div", "mana-title", manaText, "Jev is out of mana");
  const manaLine = element("div", "mana-line", manaText);
  let manaReason: BrainErrorKind | null = null;

  let bannerRemaining = 0;
  let smoothedFrameMs = 16.7;
  let demonBrainLabel = "heuristic";
  let warlockBrainLabel: string | null = null;
  let frameStatsCooldown = 0;

  function showBanner(text: string, subtitle = ""): void {
    bannerTitle.textContent = text;
    bannerSubtitle.textContent = subtitle;
    bannerRemaining = bannerSeconds;
    banner.classList.add("visible");
  }

  function roundEndText(winner: CasterId, world: World): [string, string] {
    const wins = world.round.wins;
    const score = `${wins.warlock} – ${wins.demon}`;
    if (wins[winner] >= config.sim.roundsToWinMatch) {
      return winner === "warlock" ? ["Demon Jev is banished", score] : ["Warlock Jev's soul is forfeit", score];
    }
    return winner === "warlock" ? ["Warlock Jev takes the round", score] : ["Demon Jev takes the round", score];
  }

  function updatePanel(panel: ReturnType<typeof createCasterPanel>, caster: Caster, wins: number): void {
    const healthFraction = `${Math.max(0, (caster.health / config.sim.caster.maxHealth) * 100)}%`;
    panel.fill.style.width = healthFraction;
    panel.trailing.style.width = healthFraction;
    panel.pipElements.forEach((pip, index) => pip.classList.toggle("won", index < wins));
  }

  // remainingMs drives the seconds countdown shown over the slot while it is waiting.
  function updateSlot(slot: ReturnType<typeof createSlot>, remainingFraction: number, remainingMs: number, selected: boolean): void {
    slot.cooldown.style.height = `${Math.max(0, Math.min(1, remainingFraction)) * 100}%`;
    const countdown = remainingMs > 0 ? (remainingMs / 1000).toFixed(1) : "";
    if (slot.timer.textContent !== countdown) slot.timer.textContent = countdown;
    slot.slot.classList.toggle("ready", remainingFraction === 0);
    slot.slot.classList.toggle("selected", selected);
  }

  function flashDenied(slot: ReturnType<typeof createSlot>): void {
    slot.slot.classList.remove("denied");
    // Force a reflow so the animation restarts when presses are refused back to back.
    void slot.slot.offsetWidth;
    slot.slot.classList.add("denied");
  }

  showBanner("Round 1", "Draw blood");

  return {
    update(world, events, frameSeconds) {
      for (const event of events) {
        if (event.type === "roundEnded") showBanner(...roundEndText(event.winner, world));
        // A buffered press that ran out without firing: flash the slot that refused it.
        if (event.type === "pressExpired" && event.casterId === "warlock") flashDenied(event.action === "dash" ? dashSlot : spellSlots[world.casters.warlock.carried]);
        if (event.type === "roundStarted") showBanner(event.round === 1 ? "A new ritual" : `Round ${event.round}`, "Draw blood");
      }
      const { warlock, demon } = world.casters;
      updatePanel(warlockPanel, warlock, world.round.wins.warlock);
      updatePanel(demonPanel, demon, world.round.wins.demon);
      demonPanel.label.textContent = panelName("Demon Jev", demonBrainLabel);
      warlockPanel.label.textContent = panelName("Warlock Jev", warlockBrainLabel);
      roundLabel.textContent = `Round ${world.round.number}`;

      // Attack slots show the longest wait: their own cooldown, the shared recovery, or the switch.
      const recoveryFraction = warlock.recoveryRemainingMs / config.sim.castRecoveryMs;
      const switchFraction = warlock.switchRemainingMs / config.sim.switchMs;
      for (const spellElement of elements) {
        const spell = config.sim.spells[spellElement];
        const carried = warlock.carried === spellElement;
        const cooldownFraction = Math.max(warlock.cooldownsMs[spellElement] / spell.cooldownMs, recoveryFraction, carried ? switchFraction : 0);
        const waitMs = Math.max(warlock.cooldownsMs[spellElement], warlock.recoveryRemainingMs, carried ? warlock.switchRemainingMs : 0);
        const slot = spellSlots[spellElement];
        updateSlot(slot, cooldownFraction, waitMs, carried);
        const edge = `beats ${beats[spellElement]} · ${(spell.cooldownMs / 1000).toFixed(1)}s`;
        if (slot.edgeLabel.textContent !== edge) slot.edgeLabel.textContent = edge;
      }
      // The cloak slot follows the carried spell, which is also the element that cloak would block.
      // Nothing holds it back, not even a switch in progress.
      const guards = isCloaking(warlock) ? warlock.cloak.guards : warlock.carried;
      updateSlot(cloakSlot, 0, 0, false);
      cloakSlot.slot.classList.toggle("active", isCloaking(warlock));
      cloakSlot.slot.style.setProperty("--slot-color", config.render.elementColors[guards]);
      cloakSlot.edgeLabel.textContent = `blocks ${guards}`;
      updateSlot(dashSlot, warlock.dashCooldownMs / config.sim.dash.cooldownMs, warlock.dashCooldownMs, false);

      bannerRemaining -= frameSeconds;
      if (bannerRemaining <= 0) banner.classList.remove("visible");

      smoothedFrameMs += (frameSeconds * 1000 - smoothedFrameMs) * 0.05;
      frameStatsCooldown -= frameSeconds;
      if (frameStatsCooldown <= 0) {
        frameStats.textContent = `${smoothedFrameMs.toFixed(1)} ms · ${Math.round(1000 / smoothedFrameMs)} fps`;
        frameStatsCooldown = 0.25;
      }
    },
    setOutOfMana(reason) {
      if (reason === manaReason) return;
      manaReason = reason;
      manaNotice.classList.toggle("visible", reason !== null);
      if (reason) manaLine.textContent = manaLines[reason] ?? manaFallbackLine;
    },
    setMatchWins(wins) {
      const key = wins ? `${wins.warlock}:${wins.demon}` : "";
      if (key === shownMatchWins) return;
      shownMatchWins = key;
      matchScore.classList.toggle("visible", wins !== null);
      if (wins) [warlockMatchWins.textContent, demonMatchWins.textContent] = [String(wins.warlock), String(wins.demon)];
    },
    setWarlockBrainLabel(label) {
      warlockBrainLabel = label;
    },
    setDemonBrainLabel(label) {
      demonBrainLabel = label;
    },
    setPaused(paused) {
      pausedOverlay.classList.toggle("visible", paused);
    },
    showBanner,
  };
}
