import * as THREE from "three";

// A fixed set of point lights. Changing the light count forces shader recompiles, so lights are
// never added or removed during play: unused ones sit at zero intensity.
export type PooledLight = { light: THREE.PointLight; release(): void };

export type LightPool = {
  acquire(): PooledLight | null;
  flash(position: THREE.Vector3, color: THREE.Color, intensity: number, seconds: number): void;
  update(deltaSeconds: number): void;
};

type Flash = { pooled: PooledLight; peakIntensity: number; remainingSeconds: number; totalSeconds: number };

export function createLightPool(scene: THREE.Scene, size: number): LightPool {
  const free: THREE.PointLight[] = [];
  const flashes: Flash[] = [];
  for (let index = 0; index < size; index += 1) {
    const light = new THREE.PointLight(0xffffff, 0, 7, 1.8);
    scene.add(light);
    free.push(light);
  }

  function acquire(): PooledLight | null {
    const light = free.pop();
    if (!light) return null;
    let released = false;
    return {
      light,
      release() {
        if (released) return;
        released = true;
        light.intensity = 0;
        free.push(light);
      },
    };
  }

  return {
    acquire,
    flash(position, color, intensity, seconds) {
      const pooled = acquire();
      if (!pooled) return;
      pooled.light.position.copy(position);
      pooled.light.color.copy(color);
      pooled.light.intensity = intensity;
      flashes.push({ pooled, peakIntensity: intensity, remainingSeconds: seconds, totalSeconds: seconds });
    },
    update(deltaSeconds) {
      for (let index = flashes.length - 1; index >= 0; index -= 1) {
        const flash = flashes[index]!;
        flash.remainingSeconds -= deltaSeconds;
        if (flash.remainingSeconds <= 0) {
          flash.pooled.release();
          flashes.splice(index, 1);
          continue;
        }
        const fraction = flash.remainingSeconds / flash.totalSeconds;
        flash.pooled.light.intensity = flash.peakIntensity * fraction * fraction;
      }
    },
  };
}
