import * as THREE from "three";
import { config } from "../../config.ts";
import type { LightPool } from "./lightPool.ts";
import type { ParticleSystem } from "./particles.ts";

export type EarthSpikeEffects = {
  // Called every frame for each mage that is charging, with the orb position and locked aim.
  showCharge(chargeKey: string, orbPosition: THREE.Vector3, floorFrom: THREE.Vector3, direction: THREE.Vector3, progress: number): void;
  erupt(from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void;
  update(deltaSeconds: number): void;
};

type Spike = { x: number; z: number; yaw: number; tiltX: number; tiltZ: number; height: number; width: number; delay: number; age: number };
type Telegraph = { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; seenThisFrame: boolean };

const maxSpikes = 128;
const spikeSpacing = 0.42;
// The eruption races along the line; visual only, the sim resolves the hit instantly.
const eruptionSpeed = 55;
const riseSeconds = 0.07;
const holdSeconds = 0.45;
const sinkSeconds = 0.4;
// Bone dust, and the sickly green of the blight that raises the bones.
const dustColor = new THREE.Color(0.6, 0.56, 0.44).multiplyScalar(1.1);
const dustEnd = new THREE.Color(0.06, 0.06, 0.03);
const veinGlow = new THREE.Color(0.6, 0.95, 0.25).multiplyScalar(2.2);
const telegraphColor = new THREE.Color(0.6, 0.9, 0.25).multiplyScalar(0.6);

// A tapering horn of bone that curls slightly forward, with a knuckle near the base. Unit height.
function createBoneSpikeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.04, 1, 1, 6, 6).translate(0, 0.5, 0);
  const position = geometry.attributes.position!;
  for (let index = 0; index < position.count; index += 1) {
    const height = position.getY(index);
    const knuckle = 1 + Math.exp(-Math.pow((height - 0.18) * 9, 2)) * 0.28;
    position.setX(index, position.getX(index) * knuckle);
    position.setZ(index, position.getZ(index) * knuckle + height * height * 0.55);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function createEarthSpikeEffects(scene: THREE.Scene, particles: ParticleSystem, lights: LightPool): EarthSpikeEffects {
  // Bone spikes: curved, ribbed shards of old bone with a faint blight glow.
  const geometry = createBoneSpikeGeometry();
  const material = new THREE.MeshStandardMaterial({ color: 0xd2c6a4, roughness: 0.6, flatShading: true, emissive: new THREE.Color(0.06, 0.12, 0.02) });
  const mesh = new THREE.InstancedMesh(geometry, material, maxSpikes);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);

  const spikes: Spike[] = [];
  const telegraphs = new Map<string, Telegraph>();
  const telegraphGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  return {
    showCharge(chargeKey, orbPosition, floorFrom, direction, progress) {
      if (Math.random() < 0.6) {
        particles.emit({ position: orbPosition, count: 2, color: veinGlow, colorEnd: dustEnd, speedMin: 0.5, speedMax: 1.8, sizeStart: 0.16, sizeEnd: 0, lifeMin: 0.1, lifeMax: 0.25, jitter: 0.25 });
      }
      // Pebbles jitter on the floor in front of the caster as the ground gathers.
      if (Math.random() < progress * 0.8) {
        const along = Math.random() * config.sim.spells.earth.range * progress;
        const pebble = new THREE.Vector3(floorFrom.x + direction.x * along, 0.05, floorFrom.z + direction.z * along);
        particles.emit({ position: pebble, count: 1, color: dustColor, colorEnd: dustEnd, speedMin: 0.8, speedMax: 1.6, direction: new THREE.Vector3(0, 1, 0), spread: 0.4, gravity: -12, sizeStart: 0.12, sizeEnd: 0.05, lifeMin: 0.2, lifeMax: 0.35 });
      }
      const telegraph = telegraphs.get(chargeKey) ?? (() => {
        const telegraphMaterial = new THREE.MeshBasicMaterial({ color: telegraphColor, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const created = { mesh: new THREE.Mesh(telegraphGeometry, telegraphMaterial), material: telegraphMaterial, seenThisFrame: true };
        scene.add(created.mesh);
        telegraphs.set(chargeKey, created);
        return created;
      })();
      telegraph.seenThisFrame = true;
      telegraph.mesh.position.set(floorFrom.x, 0.035, floorFrom.z);
      telegraph.mesh.rotation.y = Math.atan2(direction.x, direction.z);
      const width = config.sim.spells.earth.hitRadius * 2 + config.sim.caster.radius;
      telegraph.mesh.scale.set(width * (1 - progress * 0.4), 1, config.sim.spells.earth.range);
      telegraph.material.opacity = 0.1 + progress * 0.3 + Math.sin(progress * 30) * 0.04;
    },

    erupt(from, to, hit) {
      const span = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
      const lineLength = span.length();
      const forward = span.clone().normalize();
      const side = new THREE.Vector3(-forward.z, 0, forward.x);
      const count = Math.max(2, Math.floor(lineLength / spikeSpacing));
      for (let index = 1; index <= count && spikes.length < maxSpikes; index += 1) {
        const along = (index / count) * lineLength;
        const lateral = (index % 2 === 0 ? 1 : -1) * (0.08 + Math.random() * 0.22);
        const nearEnd = index / count;
        spikes.push({
          x: from.x + forward.x * along + side.x * lateral,
          z: from.z + forward.z * along + side.z * lateral,
          yaw: Math.random() * Math.PI * 2,
          tiltX: (Math.random() - 0.5) * 0.5,
          tiltZ: (Math.random() - 0.5) * 0.5,
          // Spikes grow toward the end of the line so the strike reads as a surge.
          height: 0.5 + nearEnd * 0.7 + Math.random() * 0.3,
          width: 0.16 + Math.random() * 0.1,
          delay: along / eruptionSpeed,
          age: 0,
        });
        if (index % 3 === 0) {
          particles.emit({ position: new THREE.Vector3(from.x + forward.x * along, 0.1, from.z + forward.z * along), count: 6, color: dustColor, colorEnd: dustEnd, speedMin: 0.6, speedMax: 2.2, drag: 3, sizeStart: 0.4, sizeEnd: 0.1, lifeMin: 0.3, lifeMax: 0.7, jitter: 0.3 });
        }
      }
      const end = new THREE.Vector3(to.x, 0.6, to.z);
      lights.flash(end, new THREE.Color(0.55, 0.95, 0.3), hit ? 45 : 20, 0.3);
      particles.emit({ position: end, count: hit ? 60 : 25, color: dustColor, colorEnd: dustEnd, speedMin: 2, speedMax: 6, gravity: -9, drag: 1.5, sizeStart: 0.22, sizeEnd: 0.05, lifeMin: 0.3, lifeMax: 0.7, jitter: 0.4 });
      if (hit) particles.emit({ position: end, count: 30, color: veinGlow, colorEnd: dustEnd, speedMin: 2, speedMax: 5, drag: 4, sizeStart: 0.2, sizeEnd: 0, lifeMin: 0.15, lifeMax: 0.35 });
    },

    update(deltaSeconds) {
      for (let index = spikes.length - 1; index >= 0; index -= 1) {
        const spike = spikes[index]!;
        spike.age += deltaSeconds;
        if (spike.age - spike.delay >= riseSeconds + holdSeconds + sinkSeconds) spikes.splice(index, 1);
      }
      spikes.forEach((spike, index) => {
        const life = spike.age - spike.delay;
        const rise = life <= 0 ? 0 : Math.min(1, life / riseSeconds);
        const sink = Math.max(0, (life - riseSeconds - holdSeconds) / sinkSeconds);
        // Ease out on the way up so the spike snaps out of the ground, then slides back down.
        const grown = 1 - (1 - rise) * (1 - rise);
        position.set(spike.x, -sink * spike.height, spike.z);
        rotation.setFromEuler(euler.set(spike.tiltX, spike.yaw, spike.tiltZ));
        scale.set(spike.width, spike.height * Math.max(0.001, grown), spike.width);
        mesh.setMatrixAt(index, matrix.compose(position, rotation, scale));
      });
      mesh.count = spikes.length;
      mesh.instanceMatrix.needsUpdate = true;

      for (const [chargeKey, telegraph] of telegraphs) {
        if (!telegraph.seenThisFrame) {
          scene.remove(telegraph.mesh);
          telegraph.material.dispose();
          telegraphs.delete(chargeKey);
          continue;
        }
        telegraph.seenThisFrame = false;
      }
    },
  };
}
