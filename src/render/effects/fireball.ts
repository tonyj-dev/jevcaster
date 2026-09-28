import * as THREE from "three";
import { config } from "../../config.ts";
import type { LightPool, PooledLight } from "./lightPool.ts";
import type { ParticleSystem } from "./particles.ts";

export type FireballEffects = {
  syncProjectiles(projectiles: ReadonlyArray<{ id: number; position: THREE.Vector3 }>, deltaSeconds: number, elapsedSeconds: number): void;
  explode(position: THREE.Vector3): void;
  update(deltaSeconds: number): void;
};

type OrbVisual = { core: THREE.Mesh; glow: THREE.Mesh; light: PooledLight | null };
type Fading = { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; age: number; lifetime: number; startScale: number; endScale: number; startOpacity: number };

// Hellfire: a white-hot heart inside flames that burn down to blood red.
const hotWhite = new THREE.Color(1, 0.8, 0.5).multiplyScalar(6);
const flameOrange = new THREE.Color(1, 0.28, 0.04).multiplyScalar(4);
const emberRed = new THREE.Color(0.75, 0.04, 0.02).multiplyScalar(1.6);
const trailOrange = new THREE.Color(1, 0.26, 0.04).multiplyScalar(1.4);
const sparkYellow = new THREE.Color(1, 0.62, 0.25).multiplyScalar(1.8);
const flashWhite = new THREE.Color(1, 0.7, 0.4).multiplyScalar(2.5);
const smoulder = new THREE.Color(0.3, 0.0, 0.02);

function createScorchTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const center = size / 2;
  context.beginPath();
  for (let step = 0; step <= 48; step += 1) {
    const angle = (step / 48) * Math.PI * 2;
    const radius = center * (0.72 + Math.random() * 0.26);
    const pointX = center + Math.cos(angle) * radius;
    const pointY = center + Math.sin(angle) * radius;
    if (step === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, "rgba(0,0,0,0.95)");
  gradient.addColorStop(0.55, "rgba(10,4,2,0.75)");
  gradient.addColorStop(1, "rgba(20,8,4,0)");
  context.fillStyle = gradient;
  context.fill();
  return new THREE.CanvasTexture(canvas);
}

export function createFireballEffects(scene: THREE.Scene, particles: ParticleSystem, lights: LightPool): FireballEffects {
  const fireball = config.sim.spells.fire;
  const coreGeometry = new THREE.SphereGeometry(fireball.radius * 0.7, 16, 12);
  const glowGeometry = new THREE.SphereGeometry(fireball.radius * 1.25, 16, 12);
  const coreMaterial = new THREE.MeshBasicMaterial({ color: hotWhite });
  const glowMaterial = new THREE.MeshBasicMaterial({ color: trailOrange, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });

  const activeOrbs = new Map<number, OrbVisual>();
  const spareOrbs: OrbVisual[] = [];
  const fadingMeshes: Fading[] = [];
  const scorchTexture = createScorchTexture();
  const ringGeometry = new THREE.RingGeometry(0.82, 1, 64).rotateX(-Math.PI / 2);
  const flashGeometry = new THREE.SphereGeometry(1, 20, 14);
  const scorchGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const emitPosition = new THREE.Vector3();
  const upward = new THREE.Vector3(0, 1, 0);

  function acquireOrb(): OrbVisual {
    const orb = spareOrbs.pop() ?? { core: new THREE.Mesh(coreGeometry, coreMaterial), glow: new THREE.Mesh(glowGeometry, glowMaterial), light: null };
    scene.add(orb.core, orb.glow);
    orb.light = lights.acquire();
    orb.light?.light.color.copy(new THREE.Color(1, 0.45, 0.12));
    return orb;
  }

  function releaseOrb(orb: OrbVisual): void {
    scene.remove(orb.core, orb.glow);
    orb.light?.release();
    orb.light = null;
    spareOrbs.push(orb);
  }

  function addFading(geometry: THREE.BufferGeometry, material: THREE.MeshBasicMaterial, position: THREE.Vector3, lifetime: number, startScale: number, endScale: number): void {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.scale.setScalar(startScale);
    scene.add(mesh);
    fadingMeshes.push({ mesh, material, age: 0, lifetime, startScale, endScale, startOpacity: material.opacity });
  }

  return {
    syncProjectiles(projectiles, deltaSeconds, elapsedSeconds) {
      const seen = new Set<number>();
      for (const projectile of projectiles) {
        seen.add(projectile.id);
        const orb = activeOrbs.get(projectile.id) ?? acquireOrb();
        activeOrbs.set(projectile.id, orb);
        const flicker = 1 + Math.sin(elapsedSeconds * 40 + projectile.id) * 0.12;
        orb.core.position.copy(projectile.position);
        orb.glow.position.copy(projectile.position);
        orb.glow.scale.setScalar(flicker);
        if (orb.light) {
          orb.light.light.position.copy(projectile.position);
          orb.light.light.intensity = 9 * flicker;
        }
        const trailCount = Math.max(1, Math.round(deltaSeconds * 110));
        particles.emit({ position: projectile.position, count: trailCount, color: trailOrange, colorEnd: smoulder, sizeStart: 0.42, sizeEnd: 0.05, lifeMin: 0.2, lifeMax: 0.42, speedMin: 0.2, speedMax: 0.9, direction: upward, spread: 2.5, jitter: 0.18 });
        if (Math.random() < 0.5) particles.emit({ position: projectile.position, count: 1, color: sparkYellow, colorEnd: trailOrange, sizeStart: 0.25, sizeEnd: 0.1, lifeMin: 0.08, lifeMax: 0.15, jitter: 0.1 });
      }
      for (const [projectileId, orb] of activeOrbs) {
        if (seen.has(projectileId)) continue;
        releaseOrb(orb);
        activeOrbs.delete(projectileId);
      }
    },

    explode(position) {
      particles.emit({ position, count: 90, color: sparkYellow, colorEnd: emberRed, speedMin: 2, speedMax: 9, drag: 5, sizeStart: 0.7, sizeEnd: 0.1, lifeMin: 0.25, lifeMax: 0.6 });
      particles.emit({ position, count: 45, color: flameOrange, colorEnd: smoulder, speedMin: 1, speedMax: 4.5, drag: 1.2, gravity: 2.2, sizeStart: 0.18, sizeEnd: 0.04, lifeMin: 0.8, lifeMax: 1.6 });
      lights.flash(position, new THREE.Color(1, 0.5, 0.15), 60, 0.35);

      addFading(flashGeometry, new THREE.MeshBasicMaterial({ color: flashWhite, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }), position, 0.18, 0.3, fireball.splashRadius * 0.9);
      emitPosition.set(position.x, 0.04, position.z);
      addFading(ringGeometry, new THREE.MeshBasicMaterial({ color: sparkYellow, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), emitPosition, 0.4, 0.3, fireball.splashRadius + 0.6);

      emitPosition.set(position.x, 0.015, position.z);
      const scorchMaterial = new THREE.MeshBasicMaterial({ map: scorchTexture, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      addFading(scorchGeometry, scorchMaterial, emitPosition, config.render.scorchFadeSeconds, fireball.splashRadius * 1.6, fireball.splashRadius * 1.6);
      fadingMeshes[fadingMeshes.length - 1]!.mesh.rotation.y = Math.random() * Math.PI * 2;
    },

    update(deltaSeconds) {
      for (let index = fadingMeshes.length - 1; index >= 0; index -= 1) {
        const fading = fadingMeshes[index]!;
        fading.age += deltaSeconds;
        const progress = Math.min(1, fading.age / fading.lifetime);
        const eased = 1 - Math.pow(1 - progress, 3);
        fading.mesh.scale.setScalar(fading.startScale + (fading.endScale - fading.startScale) * eased);
        fading.material.opacity = fading.startOpacity * (1 - progress);
        if (progress >= 1) {
          scene.remove(fading.mesh);
          fading.material.dispose();
          fadingMeshes.splice(index, 1);
        }
      }
    },
  };
}
