import * as THREE from "three";
import { config } from "../config.ts";
import { add, scale, subtract, type Vector2 } from "../sim/vector.ts";

export type FollowCamera = {
  camera: THREE.PerspectiveCamera;
  update(deltaSeconds: number, warlock: Vector2, demon: Vector2, aimPoint: Vector2, shake: THREE.Vector3): void;
  snapTo(warlock: Vector2, demon: Vector2): void;
};

// Follows the warlock with damping, leans toward the cursor and drifts toward the demon to keep it framed.
export function createFollowCamera(aspect: number): FollowCamera {
  const camera = new THREE.PerspectiveCamera(config.render.fieldOfViewDegrees, aspect, 0.1, 250);
  const focus = new THREE.Vector3();
  const desiredFocus = new THREE.Vector3();

  function focusTarget(warlock: Vector2, demon: Vector2, aimPoint: Vector2): Vector2 {
    const lean = scale(subtract(aimPoint, warlock), config.render.cameraCursorLean);
    const framing = scale(subtract(demon, warlock), config.render.cameraDemonFramingPull);
    return add(add(warlock, lean), framing);
  }

  function place(shake: THREE.Vector3): void {
    const tilt = THREE.MathUtils.degToRad(config.render.cameraTiltDegrees);
    const distanceFromFocus = config.render.cameraDistance;
    camera.fov = config.render.fieldOfViewDegrees;
    camera.updateProjectionMatrix();
    camera.position.set(focus.x, Math.sin(tilt) * distanceFromFocus, focus.z + Math.cos(tilt) * distanceFromFocus).add(shake);
    camera.lookAt(focus.x + shake.x * 0.5, 0, focus.z + shake.z * 0.5);
  }

  return {
    camera,
    update(deltaSeconds, warlock, demon, aimPoint, shake) {
      const target = focusTarget(warlock, demon, aimPoint);
      desiredFocus.set(target.x, 0, target.z);
      focus.lerp(desiredFocus, 1 - Math.exp(-config.render.cameraFollowSharpness * deltaSeconds));
      place(shake);
    },
    snapTo(warlock, demon) {
      const target = focusTarget(warlock, demon, warlock);
      focus.set(target.x, 0, target.z);
      place(new THREE.Vector3());
    },
  };
}
