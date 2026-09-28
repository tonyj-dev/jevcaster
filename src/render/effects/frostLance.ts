import * as THREE from "three";
import { config } from "../../config.ts";
import type { LightPool, PooledLight } from "./lightPool.ts";
import type { ParticleSystem } from "./particles.ts";

export type FrostLanceEffects = {
  syncProjectiles(lances: ReadonlyArray<{ id: number; position: THREE.Vector3; direction: THREE.Vector3 }>, deltaSeconds: number): void;
  shatter(position: THREE.Vector3): void;
  fade(position: THREE.Vector3): void;
};

type LanceVisual = { crystal: THREE.Mesh; light: PooledLight | null };

// Grave frost: a spectral shard trailing the cold of the tomb.
const iceCore = new THREE.Color(0.8, 0.97, 1).multiplyScalar(4);
const iceTrail = new THREE.Color(0.4, 0.85, 1).multiplyScalar(1.6);
const iceMist = new THREE.Color(0.04, 0.12, 0.2);
const forward = new THREE.Vector3(0, 0, 1);

export function createFrostLanceEffects(scene: THREE.Scene, particles: ParticleSystem, lights: LightPool): FrostLanceEffects {
  const radius = config.sim.spells.frost.radius;
  const crystalGeometry = new THREE.OctahedronGeometry(1, 0).scale(radius * 0.7, radius * 0.7, radius * 4);
  const crystalMaterial = new THREE.MeshBasicMaterial({ color: iceCore });
  const active = new Map<number, LanceVisual>();
  const spare: THREE.Mesh[] = [];
  const orientation = new THREE.Quaternion();

  return {
    syncProjectiles(lances, deltaSeconds) {
      const seen = new Set<number>();
      for (const lance of lances) {
        seen.add(lance.id);
        let visual = active.get(lance.id);
        if (!visual) {
          const crystal = spare.pop() ?? new THREE.Mesh(crystalGeometry, crystalMaterial);
          scene.add(crystal);
          visual = { crystal, light: lights.acquire() };
          visual.light?.light.color.setRGB(0.4, 0.8, 1);
          active.set(lance.id, visual);
        }
        visual.crystal.position.copy(lance.position);
        visual.crystal.quaternion.copy(orientation.setFromUnitVectors(forward, lance.direction));
        visual.crystal.rotateZ(performance.now() * 0.02);
        if (visual.light) {
          visual.light.light.position.copy(lance.position);
          visual.light.light.intensity = 4;
        }
        particles.emit({ position: lance.position, count: Math.max(1, Math.round(deltaSeconds * 90)), color: iceTrail, colorEnd: iceMist, sizeStart: 0.25, sizeEnd: 0.02, lifeMin: 0.15, lifeMax: 0.35, speedMin: 0.1, speedMax: 0.5, jitter: 0.1 });
      }
      for (const [lanceId, visual] of active) {
        if (seen.has(lanceId)) continue;
        scene.remove(visual.crystal);
        visual.light?.release();
        spare.push(visual.crystal);
        active.delete(lanceId);
      }
    },
    shatter(position) {
      particles.emit({ position, count: 60, color: iceCore, colorEnd: iceTrail, speedMin: 2, speedMax: 7, drag: 3, gravity: -9, sizeStart: 0.22, sizeEnd: 0.03, lifeMin: 0.3, lifeMax: 0.7 });
      particles.emit({ position, count: 25, color: iceTrail, colorEnd: iceMist, speedMin: 0.5, speedMax: 1.5, drag: 2, sizeStart: 0.6, sizeEnd: 0.1, lifeMin: 0.4, lifeMax: 0.8 });
      lights.flash(position, new THREE.Color(0.4, 0.8, 1), 25, 0.2);
    },
    fade(position) {
      particles.emit({ position, count: 12, color: iceTrail, colorEnd: iceMist, speedMin: 0.3, speedMax: 1, sizeStart: 0.3, sizeEnd: 0, lifeMin: 0.2, lifeMax: 0.4 });
    },
  };
}
