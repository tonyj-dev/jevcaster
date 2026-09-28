import * as THREE from "three";
import { config } from "../config.ts";
import { elements, type CasterInput, type Element } from "../sim/types.ts";
import { normalize, vector, type Vector2 } from "../sim/vector.ts";

// Keyboard and mouse → CasterInput. The only mutable input state in the game lives here.
export type WarlockInputController = {
  read(): CasterInput;
  // Clears the cast and dash presses once a sim step has used them.
  acknowledgePresses(): void;
  pointerNdc(): { x: number; y: number };
  onKey(code: string, handler: () => void): void;
  dispose(): void;
};

const carryKeys: Record<string, Element> = { Digit1: "fire", Digit2: "frost", Digit3: "earth" };

const movementKeys: Record<string, Vector2> = {
  KeyW: vector(0, -1),
  KeyS: vector(0, 1),
  KeyA: vector(-1, 0),
  KeyD: vector(1, 0),
};

export function createWarlockInput(surface: HTMLElement, camera: THREE.Camera): WarlockInputController {
  const heldKeys = new Set<string>();
  const keyHandlers = new Map<string, () => void>();
  const pointer = { x: 0, y: 0 };
  const raycaster = new THREE.Raycaster();
  const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  // Left button casts the carried spell, right button holds its cloak (MouseEvent.buttons bits).
  const primaryBit = 0b01;
  const secondaryBit = 0b10;
  let heldButtons = 0;
  let dashLatched = false;
  let castLatched = false;
  // The spell the warlock wants to carry; reported every frame, the sim ignores repeats.
  let desiredElement: Element = "fire";
  let lastAimPoint: Vector2 = vector(0, 0);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) dashLatched = true;
    }
    if (event.code === "F1" || event.code === "F2" || event.code === "F3" || event.code === "F4") event.preventDefault();
    const carryKey = carryKeys[event.code];
    if (carryKey) desiredElement = carryKey;
    // Quick-cast: the spell key also casts it, unless the cloak is held (then it only re-forms the cloak).
    if (carryKey && config.input.quickCast && !event.repeat && (heldButtons & secondaryBit) === 0) castLatched = true;
    heldKeys.add(event.code);
    if (!event.repeat) keyHandlers.get(event.code)?.();
  };
  const onKeyUp = (event: KeyboardEvent) => heldKeys.delete(event.code);
  const onPointerMove = (event: PointerEvent) => {
    const bounds = surface.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    // A second button pressed or released while another is held arrives as a move, not a down/up.
    // Only follow it while a press that started on the game surface is still held.
    if (heldButtons !== 0) setButtons(event.buttons);
  };
  const onPointerDown = (event: PointerEvent) => setButtons(event.buttons);
  const onPointerUp = (event: PointerEvent) => {
    heldButtons &= event.buttons;
  };
  function setButtons(buttons: number): void {
    const next = buttons & (primaryBit | secondaryBit);
    if (next & ~heldButtons & primaryBit) castLatched = true;
    heldButtons = next;
  }
  let lastWheelSwitchMs = 0;
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.timeStamp - lastWheelSwitchMs < config.input.wheelSwitchIntervalMs) return;
    lastWheelSwitchMs = event.timeStamp;
    const step = event.deltaY > 0 ? 1 : -1;
    const index = elements.indexOf(desiredElement);
    desiredElement = elements[(index + step + elements.length) % elements.length]!;
  };
  const onBlur = () => {
    heldKeys.clear();
    heldButtons = 0;
  };
  const onContextMenu = (event: Event) => event.preventDefault();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("blur", onBlur);
  surface.addEventListener("contextmenu", onContextMenu);
  surface.addEventListener("wheel", onWheel, { passive: false });

  function aimPoint(): Vector2 {
    // Aim on the plane the spells fly in, so the cursor sits exactly where the orb will go.
    aimPlane.constant = -config.sim.caster.castHeight;
    raycaster.setFromCamera(new THREE.Vector2(pointer.x, pointer.y), camera);
    if (raycaster.ray.intersectPlane(aimPlane, hitPoint)) lastAimPoint = vector(hitPoint.x, hitPoint.z);
    return lastAimPoint;
  }

  return {
    read() {
      const move = [...heldKeys].reduce((total, code) => {
        const direction = movementKeys[code];
        return direction ? vector(total.x + direction.x, total.z + direction.z) : total;
      }, vector(0, 0));
      return { move: normalize(move), aimPoint: aimPoint(), castHeld: (heldButtons & primaryBit) !== 0, castPressed: castLatched, cloakHeld: (heldButtons & secondaryBit) !== 0, dashPressed: dashLatched, carry: desiredElement };
    },
    acknowledgePresses() {
      dashLatched = false;
      castLatched = false;
    },
    pointerNdc: () => ({ ...pointer }),
    onKey(code, handler) {
      keyHandlers.set(code, handler);
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", onBlur);
      surface.removeEventListener("contextmenu", onContextMenu);
      surface.removeEventListener("wheel", onWheel);
    },
  };
}
