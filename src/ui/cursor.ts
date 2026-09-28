import { config } from "../config.ts";
import { canCastSoon } from "../sim/caster.ts";
import type { Caster, Element } from "../sim/types.ts";

export type AttackCursor = {
  update(warlock: Caster, fighting: boolean): void;
};

const size = 32;
const hotspot = size / 2;

// A small inverted pentagram in a ring, drawn over a dark outline so it reads on any floor.
// It glows in the carried spell's colour and fades while that spell can't be cast.
function cursorSvg(color: string, opacity: number): string {
  const center = hotspot;
  const starRadius = 9;
  const star = Array.from({ length: 5 }, (_, index) => {
    const angle = Math.PI / 2 + ((index * 2) / 5) * Math.PI * 2;
    return `${(center + Math.cos(angle) * starRadius).toFixed(2)},${(center + Math.sin(angle) * starRadius).toFixed(2)}`;
  }).join(" ");
  const shapes = `
    <circle cx="${center}" cy="${center}" r="${starRadius}" />
    <polygon points="${star}" stroke-linejoin="round" />
    <path d="M${center} 1v3M${center} ${size - 4}v3M1 ${center}h3M${size - 4} ${center}h3" />`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <g fill="none" stroke-linecap="round" opacity="${opacity}">
      <g stroke="#030102" stroke-width="3" stroke-opacity="0.7">${shapes}</g>
      <g stroke="${color}" stroke-width="1.2">${shapes}</g>
      <circle cx="${center}" cy="${center}" r="1.2" fill="${color}" />
    </g>
  </svg>`;
}

function cursorValue(element: Element, ready: boolean): string {
  const svg = cursorSvg(config.render.elementColors[element], ready ? 0.95 : 0.4);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, crosshair`;
}

export function createAttackCursor(target: HTMLElement): AttackCursor {
  const cache = new Map<string, string>();
  let currentKey = "";
  return {
    update(warlock, fighting) {
      const ready = fighting && warlock.alive && warlock.switchRemainingMs === 0 && canCastSoon(warlock, warlock.carried);
      const key = `${warlock.carried}:${ready}`;
      if (key === currentKey) return;
      currentKey = key;
      if (!cache.has(key)) cache.set(key, cursorValue(warlock.carried, ready));
      target.style.cursor = cache.get(key)!;
    },
  };
}
