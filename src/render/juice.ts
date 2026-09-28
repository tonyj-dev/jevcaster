import * as THREE from "three";
import { config } from "../config.ts";

// Trauma-based shake: hits add trauma, the offset grows with trauma squared, and trauma decays.
export type ScreenShake = { addTrauma(amount: number): void; update(deltaSeconds: number, elapsedSeconds: number): THREE.Vector3 };

export function createScreenShake(maxOffset = 0.45): ScreenShake {
  let trauma = 0;
  const offset = new THREE.Vector3();
  return {
    addTrauma(amount) {
      trauma = Math.min(1, trauma + amount);
    },
    update(deltaSeconds, elapsedSeconds) {
      trauma = Math.max(0, trauma - config.render.screenShakeDecayPerSecond * deltaSeconds * 0.5);
      const strength = trauma * trauma * maxOffset;
      offset.set(
        Math.sin(elapsedSeconds * 71.3) * strength,
        Math.sin(elapsedSeconds * 53.7 + 1.3) * strength * 0.6,
        Math.sin(elapsedSeconds * 61.1 + 2.1) * strength,
      );
      return offset;
    },
  };
}

type FloatingNumber = { element: HTMLDivElement; worldPosition: THREE.Vector3; age: number; drift: number };

// Floating popups: damage numbers and short callouts such as "FROZEN".
export type DamageNumbers = { spawn(worldPosition: THREE.Vector3, text: string, color: string, big: boolean): void; update(deltaSeconds: number): void };

export function createDamageNumbers(container: HTMLElement, camera: THREE.Camera): DamageNumbers {
  const active: FloatingNumber[] = [];
  const spare: HTMLDivElement[] = [];
  const projected = new THREE.Vector3();

  return {
    spawn(worldPosition, text, color, big) {
      const element = spare.pop() ?? document.createElement("div");
      element.className = big ? "damage-number damage-number-big" : "damage-number";
      element.textContent = text;
      element.style.color = color;
      container.appendChild(element);
      active.push({ element, worldPosition: worldPosition.clone(), age: 0, drift: (Math.random() - 0.5) * 0.8 });
    },
    update(deltaSeconds) {
      const lifetime = config.render.damageNumberSeconds;
      for (let index = active.length - 1; index >= 0; index -= 1) {
        const floating = active[index]!;
        floating.age += deltaSeconds;
        if (floating.age >= lifetime) {
          floating.element.remove();
          spare.push(floating.element);
          active.splice(index, 1);
          continue;
        }
        const progress = floating.age / lifetime;
        projected.copy(floating.worldPosition);
        projected.y += 0.6 + progress * 1.1;
        projected.x += floating.drift * progress;
        projected.project(camera);
        const screenX = (projected.x * 0.5 + 0.5) * container.clientWidth;
        const screenY = (-projected.y * 0.5 + 0.5) * container.clientHeight;
        const pop = progress < 0.15 ? 1 + (0.15 - progress) * 4 : 1;
        floating.element.style.transform = `translate(-50%, -50%) translate(${screenX}px, ${screenY}px) scale(${pop})`;
        floating.element.style.opacity = String(1 - Math.max(0, progress - 0.6) / 0.4);
      }
    },
  };
}
