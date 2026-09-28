import * as THREE from "three";
import { config } from "../../config.ts";
import type { Element } from "../../sim/types.ts";
import type { Vector2 } from "../../sim/vector.ts";
import { createHornGeometry, createSkull, strokeCircle, strokePentagram } from "./occult.ts";

export type MagePalette = { robe: string; trim: string; skin: string; eyes: string; rim: string; horned: boolean };

export type MageRenderState = {
  position: Vector2;
  velocity: Vector2;
  aimDirection: Vector2;
  element: Element;
  alive: boolean;
  burning: boolean;
  frozen: boolean;
};

export type MageView = {
  group: THREE.Group;
  update(state: MageRenderState, deltaSeconds: number, elapsedSeconds: number): void;
  orbWorldPosition(target: THREE.Vector3): THREE.Vector3;
  bodyWorldPosition(target: THREE.Vector3): THREE.Vector3;
  flash(): void;
  pulse(): void;
  reset(): void;
};

const robeProfile = [
  [0.001, 0],
  [0.56, 0],
  [0.52, 0.12],
  [0.4, 0.6],
  [0.3, 1.0],
  [0.24, 1.22],
  [0.001, 1.3],
].map(([radius, height]) => new THREE.Vector2(radius, height));

const hoodProfile = [
  [0.001, 0.62],
  [0.07, 0.5],
  [0.2, 0.3],
  [0.26, 0.1],
  [0.24, 0],
  [0.001, 0],
].map(([radius, height]) => new THREE.Vector2(radius, height));

const flashWhite = new THREE.Color(3, 3, 3);
const burnTint = new THREE.Color(0.35, 0.08, 0);
const cachedElementColors = new Map<string, THREE.Color>();

// Cached by hex so the dev panel can still change element colours at runtime.
export function elementColor(element: Element): THREE.Color {
  const hex = config.render.elementColors[element];
  const cached = cachedElementColors.get(hex);
  if (cached) return cached;
  const created = new THREE.Color(hex);
  cachedElementColors.set(hex, created);
  return created;
}

// A glow along the silhouette in each side's colour, so a dark robe still reads on a dark floor.
function addRimGlow(material: THREE.MeshStandardMaterial, color: THREE.Color, power: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: color };
    shader.fragmentShader = `uniform vec3 rimColor;
${shader.fragmentShader}`.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      float rimFactor = pow(1.0 - saturate(abs(dot(normal, normalize(vViewPosition)))), ${power.toFixed(1)});
      totalEmissiveRadiance += rimColor * rimFactor;`,
    );
  };
  material.customProgramCacheKey = () => `rim-${power}`;
}

// A small glowing pentagram, worn as an amulet on the chest.
let amuletTexture: THREE.CanvasTexture | null = null;
function getAmuletTexture(): THREE.CanvasTexture {
  if (amuletTexture) return amuletTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.strokeStyle = "#fff";
  context.lineWidth = 9;
  context.lineJoin = "round";
  strokeCircle(context, size / 2, size / 2, size * 0.42);
  context.lineWidth = 7;
  strokePentagram(context, size / 2, size / 2, size * 0.42);
  amuletTexture = new THREE.CanvasTexture(canvas);
  return amuletTexture;
}

// A ragged hem: an open cone whose bottom edge zigzags into tatters.
function createTatteredHem(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.5, 0.6, 0.36, 28, 1, true);
  const position = geometry.attributes.position!;
  for (let index = 0; index < position.count; index += 1) {
    if (position.getY(index) > 0) continue;
    const column = index % 29;
    position.setY(index, position.getY(index) + (column % 2 === 0 ? 0.13 : 0) + Math.sin(column * 2.7) * 0.03);
  }
  geometry.translate(0, 0.18, 0);
  geometry.computeVertexNormals();
  return geometry;
}

export function createMage(palette: MagePalette): MageView {
  const group = new THREE.Group();
  const tilt = new THREE.Group();
  const body = new THREE.Group();
  group.add(tilt);
  tilt.add(body);

  const robeMaterial = new THREE.MeshStandardMaterial({ color: palette.robe, roughness: 0.82, metalness: 0.05 });
  const hemMaterial = new THREE.MeshStandardMaterial({ color: palette.robe, roughness: 0.9, side: THREE.DoubleSide });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: palette.trim, emissive: new THREE.Color(palette.trim).multiplyScalar(0.35), roughness: 0.45, metalness: 0.7 });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.7 });
  const woodMaterial = new THREE.MeshStandardMaterial({ color: 0x1e1512, roughness: 0.9 });
  const hornMaterial = new THREE.MeshStandardMaterial({ color: 0x241814, roughness: 0.35, metalness: 0.2 });
  const boneMaterial = new THREE.MeshStandardMaterial({ color: 0xcfc2a0, roughness: 0.75 });
  const socketMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.eyes).multiplyScalar(palette.horned ? 6 : 4) });
  const rimColor = new THREE.Color(palette.rim).multiplyScalar(1.0);
  addRimGlow(robeMaterial, rimColor, 2.5);
  addRimGlow(hemMaterial, rimColor, 2.5);
  addRimGlow(hornMaterial, rimColor, 2.0);
  const flashMaterials = [robeMaterial, hemMaterial, trimMaterial, skinMaterial, woodMaterial, hornMaterial, boneMaterial];
  const baseEmissive = flashMaterials.map((material) => material.emissive.clone());

  const addPart = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  addPart(new THREE.LatheGeometry(robeProfile, 24), robeMaterial, 0, 0.1, 0);
  addPart(createTatteredHem(), hemMaterial, 0, 0, 0);
  addPart(new THREE.TorusGeometry(0.34, 0.03, 6, 24).rotateX(Math.PI / 2), trimMaterial, 0, 0.84, 0);
  addPart(new THREE.SphereGeometry(0.3, 16, 10).scale(1.15, 0.62, 0.9), robeMaterial, 0, 1.3, 0);
  addPart(new THREE.SphereGeometry(0.16, 16, 12), skinMaterial, 0, 1.53, 0.03);
  addPart(new THREE.SphereGeometry(0.025, 8, 6), eyeMaterial, -0.055, 1.55, 0.16);
  addPart(new THREE.SphereGeometry(0.025, 8, 6), eyeMaterial, 0.055, 1.55, 0.16);
  const amulet = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.eyes).multiplyScalar(2.5), alphaMap: getAmuletTexture(), transparent: true, depthWrite: false }),
  );
  amulet.position.set(0, 1.06, 0.305);
  amulet.rotation.x = -0.2;
  body.add(amulet);

  if (palette.horned) {
    // The demon goes bareheaded: swept-back horns and spiked shoulders.
    for (const side of [-1, 1]) {
      const horn = new THREE.CubicBezierCurve3(
        new THREE.Vector3(side * 0.09, 1.6, 0),
        new THREE.Vector3(side * 0.3, 1.66, 0.04),
        new THREE.Vector3(side * 0.36, 1.88, -0.08),
        new THREE.Vector3(side * 0.24, 2.04, -0.22),
      );
      addPart(createHornGeometry(horn, 0.055), hornMaterial, 0, 0, 0);
      const spike = addPart(new THREE.ConeGeometry(0.06, 0.28, 6), trimMaterial, side * 0.3, 1.42, -0.02);
      spike.rotation.z = -side * 0.7;
    }
    addPart(new THREE.ConeGeometry(0.06, 0.12, 4).rotateX(Math.PI), skinMaterial, 0, 1.4, 0.1);
  } else {
    // The warlock's tall hood, peaked and falling back, open at the front so the eyes glow from the dark.
    const hoodMaterial = new THREE.MeshStandardMaterial({ color: palette.robe, roughness: 0.85, side: THREE.DoubleSide });
    addRimGlow(hoodMaterial, rimColor, 2.5);
    flashMaterials.push(hoodMaterial);
    baseEmissive.push(hoodMaterial.emissive.clone());
    const hood = addPart(new THREE.LatheGeometry(hoodProfile, 20, 0.75, Math.PI * 2 - 1.5).scale(1.05, 1.45, 1.05), hoodMaterial, 0, 1.4, -0.02);
    hood.rotation.x = -0.3;
  }

  // Sleeve reaching to the staff hand.
  const sleeve = addPart(new THREE.CylinderGeometry(0.07, 0.11, 0.5, 10), robeMaterial, 0.33, 1.14, 0.08);
  sleeve.rotation.set(0.5, 0, 0.45);

  // A blackened staff crowned with a skull; two horns rise from it to cradle the orb.
  const staff = new THREE.Group();
  staff.position.set(0.45, 0, 0.2);
  staff.rotation.x = 0.12;
  body.add(staff);
  addPart(new THREE.CylinderGeometry(0.026, 0.036, 1.85, 7), woodMaterial, 0, 0.93, 0, staff);
  const staffSkull = createSkull(boneMaterial, socketMaterial);
  staffSkull.position.set(0, 1.86, 0.01);
  staffSkull.scale.setScalar(0.42);
  staff.add(staffSkull);
  for (const side of [-1, 1]) {
    const cradle = new THREE.CubicBezierCurve3(
      new THREE.Vector3(side * 0.05, 1.88, 0),
      new THREE.Vector3(side * 0.19, 1.9, 0),
      new THREE.Vector3(side * 0.17, 2.1, 0),
      new THREE.Vector3(side * 0.06, 2.19, 0),
    );
    addPart(createHornGeometry(cradle, 0.022, 10, 6), trimMaterial, 0, 0, 0, staff);
  }

  const orbMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const orb = addPart(new THREE.SphereGeometry(0.1, 16, 12), orbMaterial, 0, 2.04, 0, staff);
  orb.castShadow = false;
  const orbLight = new THREE.PointLight(0xffffff, 5, 5, 1.7);
  orb.add(orbLight);
  const moteMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const motes = Array.from({ length: 3 }, () => {
    const mote = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 4), moteMaterial);
    staff.add(mote);
    return mote;
  });

  // Ice shell shown while frozen.
  const iceMaterial = new THREE.MeshStandardMaterial({ color: 0xbfe9ff, emissive: new THREE.Color(0.1, 0.35, 0.55), roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.6, flatShading: true });
  const iceShell = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1).scale(0.72, 1.05, 0.72), iceMaterial);
  iceShell.position.y = 0.95;
  iceShell.visible = false;
  group.add(iceShell);

  let facingAngle = 0;
  let pulseSeconds = 0;
  let flashSeconds = 0;
  let deathProgress = 0;
  let walkPhase = 0;
  const currentOrbColor = new THREE.Color();

  function update(state: MageRenderState, deltaSeconds: number, elapsedSeconds: number): void {
    group.position.set(state.position.x, 0, state.position.z);

    // Face the aim direction with a quick, damped turn.
    const targetAngle = Math.atan2(state.aimDirection.x, state.aimDirection.z);
    const turn = Math.atan2(Math.sin(targetAngle - facingAngle), Math.cos(targetAngle - facingAngle));
    if (!state.frozen) facingAngle += turn * (1 - Math.exp(-18 * deltaSeconds));
    body.rotation.y = facingAngle;

    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    walkPhase += deltaSeconds * (4 + speed * 1.6);
    const moving = Math.min(1, speed / config.sim.caster.moveSpeed);
    // Lean into movement; capped so a dash reads as a lunge, not a fall.
    const maxLean = 0.28;
    tilt.rotation.set(THREE.MathUtils.clamp(state.velocity.z * 0.035, -maxLean, maxLean), 0, THREE.MathUtils.clamp(-state.velocity.x * 0.035, -maxLean, maxLean));
    body.position.y = Math.abs(Math.sin(walkPhase)) * 0.06 * moving + Math.sin(elapsedSeconds * 2) * 0.015;

    const targetOrbColor = elementColor(state.element);
    currentOrbColor.lerp(targetOrbColor, 1 - Math.exp(-14 * deltaSeconds));
    pulseSeconds = Math.max(0, pulseSeconds - deltaSeconds);
    const pulseAmount = pulseSeconds / 0.3;
    orb.scale.setScalar(1 + pulseAmount * 0.5);
    orbMaterial.color.copy(currentOrbColor).multiplyScalar(3 + Math.sin(elapsedSeconds * 6) * 0.5 + pulseAmount * 1.5);
    moteMaterial.color.copy(currentOrbColor).multiplyScalar(3);
    orbLight.color.copy(currentOrbColor);
    motes.forEach((mote, index) => {
      const angle = elapsedSeconds * 3 + (index / motes.length) * Math.PI * 2;
      mote.position.set(Math.cos(angle) * 0.24, 2.04 + Math.sin(angle * 1.7) * 0.06, Math.sin(angle) * 0.24);
    });

    flashSeconds = Math.max(0, flashSeconds - deltaSeconds);
    const flashAmount = flashSeconds / config.render.hitFlashSeconds;
    flashMaterials.forEach((material, index) => {
      material.emissive.copy(baseEmissive[index]!).lerp(flashWhite, flashAmount);
    });
    if (state.burning) robeMaterial.emissive.lerp(burnTint, 0.5 + Math.sin(elapsedSeconds * 20) * 0.2);
    iceShell.visible = state.frozen && state.alive;
    if (iceShell.visible) iceShell.rotation.y = facingAngle;

    deathProgress = state.alive ? Math.max(0, deathProgress - deltaSeconds * 4) : Math.min(1, deathProgress + deltaSeconds * 1.6);
    const shrink = 1 - deathProgress * 0.85;
    group.scale.set(shrink, shrink * (1 - deathProgress * 0.3), shrink);
    group.position.y = -deathProgress * 0.6;
    orbLight.intensity = 5 * (1 - deathProgress);
  }

  return {
    group,
    update,
    orbWorldPosition: (target) => orb.getWorldPosition(target),
    bodyWorldPosition: (target) => target.set(group.position.x, 1.0, group.position.z),
    flash() {
      flashSeconds = config.render.hitFlashSeconds;
    },
    pulse() {
      pulseSeconds = 0.3;
    },
    reset() {
      deathProgress = 0;
      flashSeconds = 0;
    },
  };
}
