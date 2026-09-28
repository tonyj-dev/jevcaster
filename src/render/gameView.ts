import * as THREE from "three";
import { config } from "../config.ts";
import { aimDirection, isFrozen } from "../sim/caster.ts";
import type { Caster, CasterId, Element, Projectile, SimEvent, World } from "../sim/types.ts";
import { casterIds } from "../sim/types.ts";
import { lerpVector, normalize, subtract, type Vector2 } from "../sim/vector.ts";
import { createFollowCamera } from "./camera.ts";
import { createEarthSpikeEffects } from "./effects/earthSpikes.ts";
import { createFireballEffects } from "./effects/fireball.ts";
import { createFrostLanceEffects } from "./effects/frostLance.ts";
import { createLightPool } from "./effects/lightPool.ts";
import { createParticleSystem } from "./effects/particles.ts";
import { createCloakBubble, type CloakBubble } from "./effects/cloak.ts";
import { createDamageNumbers, createScreenShake } from "./juice.ts";
import { addLighting } from "./lighting.ts";
import { createArena } from "./models/arena.ts";
import { createMage, elementColor, type MageView } from "./models/mage.ts";
import { createPostEffects } from "./postfx.ts";

export type RenderFrame = {
  previous: World;
  current: World;
  alpha: number;
  events: readonly SimEvent[];
  frameSeconds: number;
  elapsedSeconds: number;
  warlockAim: Vector2;
};

export type GameView = {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  render(frame: RenderFrame): void;
};

const flameColor = new THREE.Color(1, 0.4, 0.08).multiplyScalar(3);
const flameEnd = new THREE.Color(0.3, 0.03, 0);
const frostMote = new THREE.Color(0.5, 0.85, 1).multiplyScalar(1.5);
const frostEnd = new THREE.Color(0.02, 0.08, 0.15);
const soulColor = new THREE.Color(1, 0.08, 0.1).multiplyScalar(2.2);
const soulEnd = new THREE.Color(0.15, 0, 0.02);
const upward = new THREE.Vector3(0, 1, 0);

function popupColor(event: Extract<SimEvent, { type: "hit" }>): string {
  if (event.blocked) return "#b8aec4";
  if (event.countered) return "#ffb21a";
  return event.casterId === "warlock" ? "#ff4a3a" : "#f2e2c0";
}

export function createGameView(container: HTMLElement, overlay: HTMLElement): GameView {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.render.maxPixelRatio));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = config.render.toneMappingExposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030102);
  scene.fog = new THREE.FogExp2(0x0c0304, 0.026);

  const followCamera = createFollowCamera(container.clientWidth / container.clientHeight);
  const camera = followCamera.camera;
  const postEffects = createPostEffects(renderer, scene, camera);
  addLighting(scene);

  const particles = createParticleSystem(config.render.maxParticles);
  scene.add(particles.points);
  const arena = createArena(particles);
  scene.add(arena.group);
  const mages: Record<CasterId, MageView> = {
    warlock: createMage(config.render.palettes.warlock),
    demon: createMage(config.render.palettes.demon),
  };
  scene.add(mages.warlock.group, mages.demon.group);
  const cloaks: Record<CasterId, CloakBubble> = { warlock: createCloakBubble(scene), demon: createCloakBubble(scene) };

  const lights = createLightPool(scene, config.render.maxDynamicLights);
  const fireballs = createFireballEffects(scene, particles, lights);
  const frostLances = createFrostLanceEffects(scene, particles, lights);
  const earthSpikes = createEarthSpikeEffects(scene, particles, lights);
  const shake = createScreenShake();
  const popups = createDamageNumbers(overlay, camera);

  function resize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    postEffects.resize(width, height);
    particles.setViewport(height * renderer.getPixelRatio(), camera.fov);
    arena.setViewport(height * renderer.getPixelRatio(), camera.fov);
  }
  window.addEventListener("resize", resize);
  resize();

  const scratch = new THREE.Vector3();
  const castHeight = config.sim.caster.castHeight;
  const toWorld = (point: Vector2, height = castHeight) => new THREE.Vector3(point.x, height, point.z);
  let cameraPlaced = false;

  function handleEvent(event: SimEvent, current: World): void {
    switch (event.type) {
      case "carryChanged": {
        mages[event.casterId].pulse();
        const color = elementColor(event.to).clone().multiplyScalar(1.3);
        particles.emit({ position: mages[event.casterId].orbWorldPosition(scratch), count: 8, color, colorEnd: new THREE.Color(0, 0, 0), speedMin: 1, speedMax: 1.8, drag: 4, sizeStart: 0.12, sizeEnd: 0, lifeMin: 0.15, lifeMax: 0.3 });
        break;
      }
      case "projectileSpawned": {
        const color = elementColor(event.projectile.element).clone().multiplyScalar(3);
        particles.emit({ position: mages[event.projectile.ownerId].orbWorldPosition(scratch), count: 16, color, colorEnd: new THREE.Color(0, 0, 0), speedMin: 1, speedMax: 3, sizeStart: 0.35, sizeEnd: 0.05, lifeMin: 0.1, lifeMax: 0.25 });
        break;
      }
      case "exploded": {
        const position = toWorld(event.position);
        if (event.element === "fire") {
          fireballs.explode(position);
          const warlock = current.casters.warlock.position;
          shake.addTrauma(Math.max(0.12, 0.45 - Math.hypot(event.position.x - warlock.x, event.position.z - warlock.z) * 0.04));
        } else {
          frostLances.shatter(position);
        }
        break;
      }
      case "projectileFaded":
        frostLances.fade(toWorld(event.position));
        break;
      case "earthCharging":
        break;
      case "earthStrike": {
        earthSpikes.erupt(toWorld(event.from, 0), toWorld(event.to, 0), event.hitCasterId !== null);
        shake.addTrauma(event.hitCasterId === "warlock" ? 0.55 : 0.25);
        break;
      }
      case "hit": {
        mages[event.casterId].flash();
        const big = event.kind === "direct" || event.kind === "spikes";
        const amount = String(Math.round(event.damage));
        const label = event.blocked ? (event.damage > 0 ? `${amount} cloaked` : "cloaked") : event.countered ? `${amount} pwnd` : amount;
        popups.spawn(toWorld(event.position), label, popupColor(event), (big || event.countered) && !event.blocked);
        if (event.blocked) {
          const source = current.casters[event.sourceId].position;
          const direction = normalize(subtract(source, event.position));
          cloaks[event.casterId].ripple(new THREE.Vector3(direction.x, 0.2, direction.z));
        }
        if (event.casterId === "warlock") shake.addTrauma(event.blocked ? 0.1 : big ? 0.45 : 0.25);
        break;
      }
      case "dashed": {
        const color = new THREE.Color(config.render.palettes[event.casterId].trim).multiplyScalar(2);
        for (let step = 0; step <= 8; step += 1) {
          const along = (step / 8) * config.sim.dash.distance;
          const point = toWorld({ x: event.from.x + event.direction.x * along, z: event.from.z + event.direction.z * along }, 0.3 + Math.random() * 1.2);
          particles.emit({ position: point, count: 4, color, colorEnd: new THREE.Color(0.05, 0.05, 0.2), speedMin: 0.2, speedMax: 1, sizeStart: 0.35, sizeEnd: 0, lifeMin: 0.2, lifeMax: 0.45, jitter: 0.4 });
        }
        break;
      }
      case "cloakRaising":
      case "cloakRaised": {
        const color = elementColor(event.guards).clone().multiplyScalar(2);
        const center = mages[event.casterId].bodyWorldPosition(scratch);
        particles.emit({ position: center, count: event.type === "cloakRaised" ? 30 : 10, color, colorEnd: new THREE.Color(0, 0, 0), speedMin: 1.5, speedMax: 2.2, drag: 3, sizeStart: 0.18, sizeEnd: 0, lifeMin: 0.2, lifeMax: 0.4, jitter: 0.6 });
        break;
      }
      case "cloakDropped":
        break;
      case "frozen": {
        const center = mages[event.casterId].bodyWorldPosition(new THREE.Vector3());
        frostLances.shatter(center);
        popups.spawn(center, "FROZEN", "#9fe6ff", true);
        break;
      }
      case "thawed": {
        const center = mages[event.casterId].bodyWorldPosition(new THREE.Vector3());
        particles.emit({ position: center, count: 50, color: frostMote, colorEnd: frostEnd, speedMin: 2, speedMax: 5, gravity: -9, drag: 1, sizeStart: 0.25, sizeEnd: 0.05, lifeMin: 0.4, lifeMax: 0.8, jitter: 0.8 });
        break;
      }
      case "casterDied": {
        particles.emit({ position: toWorld(event.position, 0.9), count: 160, color: flameColor, colorEnd: flameEnd, speedMin: 1, speedMax: 6, drag: 2, gravity: 3, sizeStart: 0.25, sizeEnd: 0.02, lifeMin: 0.8, lifeMax: 2, jitter: 0.8 });
        // The soul leaves: a slow column of crimson motes dragged upward.
        particles.emit({ position: toWorld(event.position, 0.4), count: 70, color: soulColor, colorEnd: soulEnd, speedMin: 0.3, speedMax: 1.2, direction: upward, spread: 0.3, gravity: 2.5, sizeStart: 0.3, sizeEnd: 0.04, lifeMin: 1.2, lifeMax: 2.4, jitter: 0.7 });
        shake.addTrauma(0.6);
        break;
      }
      case "roundStarted":
        casterIds.forEach((casterId) => mages[casterId].reset());
        break;
      case "roundEnded":
        break;
    }
  }

  function cloakProgress(caster: Caster): number {
    if (caster.cloak.phase === "none" || !caster.alive) return -1;
    if (caster.cloak.phase === "up") return 1;
    return Math.min(0.999, caster.cloak.elapsedMs / config.sim.cloak.windUpMs);
  }

  function interpolatedProjectiles(previous: World, current: World, alpha: number, element: Element) {
    const previousById = new Map(previous.projectiles.map((projectile) => [projectile.id, projectile.position]));
    return current.projectiles
      .filter((projectile: Projectile) => projectile.element === element)
      .map((projectile) => {
        const direction = normalize(projectile.velocity);
        return {
          id: projectile.id,
          position: toWorld(lerpVector(previousById.get(projectile.id) ?? projectile.position, projectile.position, alpha)),
          direction: new THREE.Vector3(direction.x, 0, direction.z),
        };
      });
  }

  return {
    camera,
    canvas: renderer.domElement,
    render({ previous, current, alpha, events, frameSeconds, elapsedSeconds, warlockAim }) {
      events.forEach((event) => handleEvent(event, current));

      const positions: Record<CasterId, Vector2> = {
        warlock: lerpVector(previous.casters.warlock.position, current.casters.warlock.position, alpha),
        demon: lerpVector(previous.casters.demon.position, current.casters.demon.position, alpha),
      };
      for (const casterId of casterIds) {
        const caster = current.casters[casterId];
        const mage = mages[casterId];
        mage.update(
          {
            position: positions[casterId],
            velocity: caster.velocity,
            aimDirection: caster.charge ? caster.charge.direction : aimDirection(caster),
            element: caster.carried,
            alive: caster.alive,
            burning: caster.burnRemainingMs > 0,
            frozen: isFrozen(caster),
          },
          frameSeconds,
          elapsedSeconds,
        );
        const body = mage.bodyWorldPosition(scratch);
        if (caster.alive && caster.burnRemainingMs > 0 && Math.random() < frameSeconds * 30) {
          particles.emit({ position: body, count: 1, color: flameColor, colorEnd: flameEnd, speedMin: 0.5, speedMax: 1.5, direction: upward, spread: 0.6, sizeStart: 0.35, sizeEnd: 0.02, lifeMin: 0.3, lifeMax: 0.6, jitter: 0.6 });
        }
        cloaks[casterId].update(toWorld(positions[casterId], 0), elementColor(caster.cloak.guards), cloakProgress(caster), frameSeconds, elapsedSeconds);
        if (caster.charge) {
          const progress = 1 - caster.charge.remainingMs / config.sim.spells.earth.chargeMs;
          earthSpikes.showCharge(casterId, mage.orbWorldPosition(new THREE.Vector3()), toWorld(positions[casterId], 0), new THREE.Vector3(caster.charge.direction.x, 0, caster.charge.direction.z), progress);
        }
      }

      fireballs.syncProjectiles(interpolatedProjectiles(previous, current, alpha, "fire"), frameSeconds, elapsedSeconds);
      frostLances.syncProjectiles(interpolatedProjectiles(previous, current, alpha, "frost"), frameSeconds);

      const shakeOffset = shake.update(frameSeconds, elapsedSeconds);
      if (!cameraPlaced) {
        followCamera.snapTo(positions.warlock, positions.demon);
        cameraPlaced = true;
      }
      followCamera.update(frameSeconds, positions.warlock, positions.demon, warlockAim, shakeOffset);

      arena.update(elapsedSeconds, frameSeconds);
      particles.update(frameSeconds);
      lights.update(frameSeconds);
      fireballs.update(frameSeconds);
      earthSpikes.update(frameSeconds);
      popups.update(frameSeconds);
      for (const casterId of casterIds) {
      }
      postEffects.render(elapsedSeconds);
    },
  };
}
