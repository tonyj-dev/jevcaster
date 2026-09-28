import * as THREE from "three";
import { config } from "../../config.ts";
import type { ParticleSystem } from "../effects/particles.ts";
import { createSkull, seededRandom, strokeCircle, strokePentagram, strokeSigil } from "./occult.ts";

// A ritual chamber deep in a dungeon: a raised dais carved with a glowing inverted pentagram,
// candles guttering on the ledge around it, and pillars, braziers and skulls fading into the dark.
export type ArenaModel = {
  group: THREE.Group;
  update(elapsedSeconds: number, deltaSeconds: number): void;
  setViewport(heightPixels: number, fieldOfViewDegrees: number): void;
};

const daisTextureSize = 2048;
const ledgeWidth = 1.4;
const ledgeHeight = -0.25;
const chamberFloorHeight = -0.6;
const pillarCount = 10;
const pillarRingOffset = 4.6;
const wallRadius = 27;
const glyphCount = 44;
const scatteredCandleCount = 34;

type Flame = { x: number; y: number; z: number; width: number; height: number; phase: number };

// Rows of irregular flagstones with bevels, cracks and grit. Rows and stones start and end on the
// canvas edges, so the result also tiles.
function paintFlagstones(context: CanvasRenderingContext2D, size: number, random: () => number, stonePixels: number): void {
  context.fillStyle = "#070506";
  context.fillRect(0, 0, size, size);
  const gap = Math.max(3, stonePixels * 0.04);
  let rowTop = 0;
  while (rowTop < size) {
    let rowHeight = Math.round(stonePixels * (0.75 + random() * 0.5));
    if (size - (rowTop + rowHeight) < stonePixels * 0.6) rowHeight = size - rowTop;
    let stoneLeft = 0;
    while (stoneLeft < size) {
      let stoneWidth = Math.round(stonePixels * (0.9 + random() * 1.1));
      if (size - (stoneLeft + stoneWidth) < stonePixels * 0.6) stoneWidth = size - stoneLeft;
      const tone = 30 + Math.floor(random() * 22);
      const left = stoneLeft + gap / 2;
      const top = rowTop + gap / 2;
      const width = stoneWidth - gap;
      const height = rowHeight - gap;
      context.fillStyle = `rgb(${tone + 5}, ${tone}, ${tone - 3})`;
      context.fillRect(left, top, width, height);
      // Worn bevel: light along the top and left, shadow along the bottom and right.
      context.fillStyle = "rgba(255, 235, 215, 0.05)";
      context.fillRect(left, top, width, gap);
      context.fillRect(left, top, gap, height);
      context.fillStyle = "rgba(0, 0, 0, 0.4)";
      context.fillRect(left, top + height - gap, width, gap);
      context.fillRect(left + width - gap, top, gap, height);
      for (let blotch = 0; blotch < 4; blotch += 1) {
        context.fillStyle = `rgba(0, 0, 0, ${0.05 + random() * 0.08})`;
        context.beginPath();
        context.arc(left + random() * width, top + random() * height, stonePixels * (0.1 + random() * 0.3), 0, Math.PI * 2);
        context.fill();
      }
      stoneLeft += stoneWidth;
    }
    rowTop += rowHeight;
  }

  context.lineCap = "round";
  const crackCount = Math.round((size / stonePixels) * 3);
  for (let crack = 0; crack < crackCount; crack += 1) {
    context.strokeStyle = `rgba(0, 0, 0, ${0.4 + random() * 0.3})`;
    context.lineWidth = 1 + random() * 2.5;
    context.beginPath();
    let pointX = random() * size;
    let pointY = random() * size;
    let heading = random() * Math.PI * 2;
    context.moveTo(pointX, pointY);
    for (let segment = 0; segment < 4 + random() * 6; segment += 1) {
      heading += (random() - 0.5) * 1.4;
      pointX += Math.cos(heading) * stonePixels * 0.25;
      pointY += Math.sin(heading) * stonePixels * 0.25;
      context.lineTo(pointX, pointY);
    }
    context.stroke();
  }
  for (let speck = 0; speck < size * size * 0.006; speck += 1) {
    const shade = random() < 0.6 ? 0 : 255;
    context.fillStyle = `rgba(${shade}, ${shade * 0.9}, ${shade * 0.85}, ${random() * 0.06})`;
    context.fillRect(random() * size, random() * size, 1 + random() * 3, 1 + random() * 3);
  }
}

// Old dried blood: a dark pool with splatter around it.
function paintBloodStain(context: CanvasRenderingContext2D, random: () => number, centerX: number, centerY: number, radius: number): void {
  for (let blob = 0; blob < 7; blob += 1) {
    const blobX = centerX + (random() - 0.5) * radius;
    const blobY = centerY + (random() - 0.5) * radius;
    const blobRadius = radius * (0.3 + random() * 0.45);
    const gradient = context.createRadialGradient(blobX, blobY, 0, blobX, blobY, blobRadius);
    gradient.addColorStop(0, "rgba(70, 2, 6, 0.55)");
    gradient.addColorStop(0.7, "rgba(45, 0, 4, 0.35)");
    gradient.addColorStop(1, "rgba(30, 0, 2, 0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(blobX, blobY, blobRadius, 0, Math.PI * 2);
    context.fill();
  }
  for (let drop = 0; drop < 40; drop += 1) {
    const angle = random() * Math.PI * 2;
    const distance = radius * (0.6 + random() * 1.1);
    context.fillStyle = `rgba(60, 0, 5, ${0.3 + random() * 0.4})`;
    context.beginPath();
    context.arc(centerX + Math.cos(angle) * distance, centerY + Math.sin(angle) * distance, 1.5 + random() * radius * 0.06, 0, Math.PI * 2);
    context.fill();
  }
}

function canvasTexture(canvas: HTMLCanvasElement, color: boolean, repeat = 1): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (repeat !== 1) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat, repeat);
  }
  return texture;
}

function createDaisTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = daisTextureSize;
  const context = canvas.getContext("2d")!;
  const random = seededRandom(11);
  paintFlagstones(context, daisTextureSize, random, 150);
  // Blood where offerings were made at the star's points, and one old pool near the centre.
  for (let stain = 0; stain < 6; stain += 1) {
    const angle = random() * Math.PI * 2;
    const distance = daisTextureSize * (0.08 + random() * 0.36);
    paintBloodStain(context, random, daisTextureSize / 2 + Math.cos(angle) * distance, daisTextureSize / 2 + Math.sin(angle) * distance, 60 + random() * 90);
  }
  return canvasTexture(canvas, true);
}

function createTiledStoneTexture(seed: number, stonePixels: number, repeat: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  paintFlagstones(canvas.getContext("2d")!, 1024, seededRandom(seed), stonePixels);
  return canvasTexture(canvas, true, repeat);
}

// The carved circle: an inverted pentagram inscribed in double rings, with a seal in each notch.
// White on black, used as an alpha map.
function createPentagramTexture(): THREE.CanvasTexture {
  const size = daisTextureSize;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const center = size / 2;
  const random = seededRandom(66);
  context.fillStyle = "#000";
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "#fff";
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const [radius, width] of [[0.985, 8], [0.955, 3], [0.84, 3], [0.815, 8]] as const) {
    context.lineWidth = width;
    strokeCircle(context, center, center, radius * center);
  }
  context.lineWidth = 10;
  strokePentagram(context, center, center, 0.815 * center);
  context.lineWidth = 5;
  strokePentagram(context, center, center, 0.815 * center * 0.93);
  // Inner circle through the star's inner pentagon, and a small eye at the centre.
  context.lineWidth = 6;
  strokeCircle(context, center, center, 0.815 * center * 0.382);
  context.lineWidth = 4;
  strokeCircle(context, center, center, 0.05 * center);
  // A seal between each pair of points.
  context.lineWidth = 6;
  for (let notch = 0; notch < 5; notch += 1) {
    const angle = Math.PI / 2 + ((notch + 0.5) / 5) * Math.PI * 2;
    context.save();
    context.translate(center + Math.cos(angle) * 0.66 * center, center + Math.sin(angle) * 0.66 * center);
    context.rotate(angle + Math.PI / 2);
    strokeSigil(context, random, 46);
    context.restore();
  }
  return canvasTexture(canvas, false);
}

// The band of glyphs between the outer rings; it turns slowly, like the circle is working.
function createGlyphRingTexture(): THREE.CanvasTexture {
  const size = daisTextureSize;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const center = size / 2;
  const random = seededRandom(13);
  context.fillStyle = "#000";
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "#fff";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 4;
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const angle = (glyph / glyphCount) * Math.PI * 2;
    context.save();
    context.translate(center + Math.cos(angle) * 0.898 * center, center + Math.sin(angle) * 0.898 * center);
    context.rotate(angle + Math.PI / 2);
    strokeSigil(context, random, 26);
    context.restore();
  }
  return canvasTexture(canvas, false);
}

// Rough stone blocks for the chamber walls and pillars.
function createBlockTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const random = seededRandom(21);
  context.fillStyle = "#060405";
  context.fillRect(0, 0, size, size);
  const rowHeight = size / 6;
  for (let row = 0; row < 6; row += 1) {
    const offset = row % 2 === 0 ? 0 : -size / 8;
    for (let block = 0; block < 5; block += 1) {
      const tone = 26 + Math.floor(random() * 20);
      context.fillStyle = `rgb(${tone + 4}, ${tone}, ${tone - 2})`;
      context.fillRect(offset + block * (size / 4) + 3, row * rowHeight + 3, size / 4 - 6, rowHeight - 6);
      context.fillStyle = "rgba(0, 0, 0, 0.3)";
      context.fillRect(offset + block * (size / 4) + 3, (row + 1) * rowHeight - 9, size / 4 - 6, 6);
    }
  }
  for (let speck = 0; speck < 5000; speck += 1) {
    context.fillStyle = `rgba(0, 0, 0, ${random() * 0.15})`;
    context.fillRect(random() * size, random() * size, 2 + random() * 5, 2 + random() * 5);
  }
  return canvasTexture(canvas, true);
}

// A teardrop that rises from its base at the origin.
function createFlameGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 10, 10);
  const position = geometry.attributes.position!;
  for (let index = 0; index < position.count; index += 1) {
    const vertexY = position.getY(index);
    const taper = vertexY > 0 ? 1 - vertexY * 0.82 : 1;
    position.setXYZ(index, position.getX(index) * taper, vertexY > 0 ? vertexY * 2.6 : vertexY * 0.8, position.getZ(index) * taper);
  }
  geometry.translate(0, 0.8, 0);
  geometry.computeVertexNormals();
  return geometry;
}

// Soft glow sprites around every flame, flickering on the GPU.
function createFlameHalos(flames: readonly Flame[], color: THREE.Color): { points: THREE.Points; material: THREE.ShaderMaterial } {
  const positions = new Float32Array(flames.length * 3);
  const sizes = new Float32Array(flames.length);
  const phases = new Float32Array(flames.length);
  flames.forEach((flame, index) => {
    positions.set([flame.x, flame.y + flame.height * 0.9, flame.z], index * 3);
    sizes[index] = flame.height * 4;
    phases[index] = flame.phase;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("haloSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, pointScale: { value: 600 }, haloColor: { value: color }, flicker: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float haloSize;
      attribute float phase;
      uniform float time;
      uniform float pointScale;
      uniform float flicker;
      varying float brightness;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        float wave = sin(time * 9.3 + phase) * 0.5 + sin(time * 23.1 + phase * 2.7) * 0.3 + sin(time * 41.0 + phase * 5.0) * 0.2;
        brightness = 1.0 + wave * 0.25 * flicker;
        gl_PointSize = haloSize * brightness * pointScale / max(0.1, -viewPosition.z);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 haloColor;
      varying float brightness;
      void main() {
        float distanceFromCenter = length(gl_PointCoord - 0.5) * 2.0;
        float glow = pow(max(0.0, 1.0 - distanceFromCenter), 2.4);
        gl_FragColor = vec4(haloColor * glow * brightness * 0.4, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4;
  return { points, material };
}

function flicker(elapsedSeconds: number, phase: number): number {
  const wave = Math.sin(elapsedSeconds * 9.3 + phase) * 0.5 + Math.sin(elapsedSeconds * 23.1 + phase * 2.7) * 0.3 + Math.sin(elapsedSeconds * 41 + phase * 5) * 0.2;
  return 1 + wave * 0.18 * config.render.candleFlicker;
}

export function createArena(particles: ParticleSystem): ArenaModel {
  const group = new THREE.Group();
  const radius = config.sim.arenaRadius;
  const random = seededRandom(9);
  const blockTexture = createBlockTexture();
  const stoneMaterial = new THREE.MeshStandardMaterial({ color: 0xb0a4a4, map: blockTexture, roughness: 0.95 });
  const ironMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1816, roughness: 0.55, metalness: 0.75 });
  const boneMaterial = new THREE.MeshStandardMaterial({ color: 0xcfc2a0, roughness: 0.75 });
  const socketMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const sigilColor = new THREE.Color(config.render.sigilColor);
  const candleColor = new THREE.Color(config.render.candleColor);

  // The dais.
  const daisTexture = createDaisTexture();
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 128).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: daisTexture, bumpMap: daisTexture, bumpScale: 1.6, roughness: 0.88, metalness: 0.02 }),
  );
  floor.receiveShadow = true;
  group.add(floor);

  const daisSide = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, -ledgeHeight, 128, 1, true), stoneMaterial);
  daisSide.position.y = ledgeHeight / 2;
  group.add(daisSide);

  const ledgeTexture = createTiledStoneTexture(4, 120, 1);
  const ledge = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius + ledgeWidth, 128, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: ledgeTexture, color: 0xb0a8a8, roughness: 0.9 }),
  );
  ledge.position.y = ledgeHeight;
  ledge.receiveShadow = true;
  group.add(ledge);

  const ledgeSide = new THREE.Mesh(new THREE.CylinderGeometry(radius + ledgeWidth, radius + ledgeWidth, ledgeHeight - chamberFloorHeight, 128, 1, true), stoneMaterial);
  ledgeSide.position.y = (ledgeHeight + chamberFloorHeight) / 2;
  group.add(ledgeSide);

  const chamberFloor = new THREE.Mesh(
    new THREE.CircleGeometry(wallRadius, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: createTiledStoneTexture(7, 160, 7), color: 0x9a9090, roughness: 0.95 }),
  );
  chamberFloor.position.y = chamberFloorHeight;
  chamberFloor.receiveShadow = true;
  group.add(chamberFloor);

  const walls = new THREE.Mesh(new THREE.CylinderGeometry(wallRadius, wallRadius, 16, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x6a6068, map: blockTexture.clone(), roughness: 1, side: THREE.BackSide }));
  const wallMap = (walls.material as THREE.MeshStandardMaterial).map!;
  wallMap.wrapS = wallMap.wrapT = THREE.RepeatWrapping;
  wallMap.repeat.set(24, 5);
  wallMap.needsUpdate = true;
  walls.position.y = chamberFloorHeight + 8;
  group.add(walls);

  // The carved circle, glowing like embers under the stone.
  const edgeGlow = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.04, 8, 192).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: sigilColor.clone().multiplyScalar(1.6) }),
  );
  edgeGlow.position.y = 0.01;
  group.add(edgeGlow);

  const sigilMaterial = (alphaMap: THREE.Texture) =>
    new THREE.MeshBasicMaterial({ color: sigilColor.clone().multiplyScalar(0.72), alphaMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const pentagramMaterial = sigilMaterial(createPentagramTexture());
  const pentagram = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.94, 128).rotateX(-Math.PI / 2), pentagramMaterial);
  pentagram.position.y = 0.012;
  group.add(pentagram);
  const glyphMaterial = sigilMaterial(createGlyphRingTexture());
  const glyphRing = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.94, 128).rotateX(-Math.PI / 2), glyphMaterial);
  glyphRing.position.y = 0.013;
  group.add(glyphRing);

  const circleLight = new THREE.PointLight(sigilColor, 10, radius * 1.6, 1.4);
  circleLight.position.set(0, 1.4, 0);
  group.add(circleLight);

  // Candles: clusters at the five points of the star, and more scattered along the ledge.
  const flames: Flame[] = [];
  const candles: Array<{ x: number; y: number; z: number; radius: number; height: number; tone: THREE.Color }> = [];
  const waxTones = [new THREE.Color(0xd8cbb0), new THREE.Color(0xd8cbb0), new THREE.Color(0xcbbd9c), new THREE.Color(0x1d1719), new THREE.Color(0x5e0c12)];
  const addCandle = (x: number, y: number, z: number, candleRadius: number, height: number) => {
    candles.push({ x, y, z, radius: candleRadius, height, tone: waxTones[Math.floor(random() * waxTones.length)]! });
    flames.push({ x, y: y + height, z, width: candleRadius * 0.55, height: 0.07 + candleRadius * 0.6, phase: random() * 100 });
  };
  const clusterLights: Array<{ light: THREE.PointLight; phase: number }> = [];
  // Canvas y is world z, so the star's canvas angles carry straight over to the floor.
  for (let point = 0; point < 5; point += 1) {
    const angle = Math.PI / 2 + (point / 5) * Math.PI * 2;
    const clusterRadius = radius + ledgeWidth * 0.5;
    const clusterX = Math.cos(angle) * clusterRadius;
    const clusterZ = Math.sin(angle) * clusterRadius;
    for (let candle = 0; candle < 7; candle += 1) {
      const spread = candle === 0 ? 0 : 0.18 + random() * 0.38;
      const around = random() * Math.PI * 2;
      addCandle(clusterX + Math.cos(around) * spread, ledgeHeight, clusterZ + Math.sin(around) * spread, 0.06 + random() * 0.05, candle === 0 ? 0.62 : 0.14 + random() * 0.4);
    }
    // A pool of spilled wax, and a skull keeping watch.
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xbfb296, roughness: 0.4 }));
    puddle.position.set(clusterX, ledgeHeight + 0.005, clusterZ);
    group.add(puddle);
    const skull = createSkull(boneMaterial, socketMaterial);
    const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    skull.position.set(clusterX + outward.x * 0.45, ledgeHeight + 0.14, clusterZ + outward.z * 0.45);
    skull.rotation.y = Math.atan2(-outward.x, -outward.z) + (random() - 0.5) * 0.6;
    skull.scale.setScalar(1.2);
    group.add(skull);
    const light = new THREE.PointLight(candleColor, 7, 6.5, 1.5);
    light.position.set(clusterX, 0.7, clusterZ);
    group.add(light);
    clusterLights.push({ light, phase: random() * 100 });
  }
  for (let candle = 0; candle < scatteredCandleCount; candle += 1) {
    const angle = random() * Math.PI * 2;
    const distance = radius + 0.2 + random() * (ledgeWidth - 0.35);
    addCandle(Math.cos(angle) * distance, ledgeHeight, Math.sin(angle) * distance, 0.05 + random() * 0.04, 0.1 + random() * 0.35);
  }

  // Pillars ring the chamber; the ones between the camera and the dais are broken stumps.
  const braziers: THREE.Vector3[] = [];
  for (let pillar = 0; pillar < pillarCount; pillar += 1) {
    const angle = (pillar / pillarCount) * Math.PI * 2 + Math.PI / pillarCount;
    const ringRadius = radius + pillarRingOffset;
    const pillarX = Math.cos(angle) * ringRadius;
    const pillarZ = Math.sin(angle) * ringRadius;
    const nearCamera = Math.sin(angle) > 0.3;
    const height = nearCamera ? 0.8 + random() * 1.4 : 9;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, height, 8), stoneMaterial);
    column.position.set(pillarX, chamberFloorHeight + height / 2, pillarZ);
    column.castShadow = true;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 1.8), stoneMaterial);
    base.position.set(pillarX, chamberFloorHeight + 0.25, pillarZ);
    base.rotation.y = -angle;
    group.add(column, base);
    if (nearCamera) {
      const rubble = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), stoneMaterial, 5);
      const rubbleTransform = new THREE.Object3D();
      for (let piece = 0; piece < 5; piece += 1) {
        rubbleTransform.position.set(pillarX + (random() - 0.5) * 2.6, chamberFloorHeight + 0.1, pillarZ + (random() - 0.5) * 2.6);
        rubbleTransform.rotation.set(random() * 3, random() * 3, random() * 3);
        rubbleTransform.scale.setScalar(0.15 + random() * 0.3);
        rubbleTransform.updateMatrix();
        rubble.setMatrixAt(piece, rubbleTransform.matrix);
      }
      group.add(rubble);
    } else if (pillar % 2 === 0) {
      braziers.push(new THREE.Vector3(Math.cos(angle) * (ringRadius - 1.7), chamberFloorHeight, Math.sin(angle) * (ringRadius - 1.7)));
    }
    if (pillar % 3 === 1) {
      const skull = createSkull(boneMaterial, socketMaterial);
      skull.position.set(pillarX - Math.cos(angle) * 1.1, chamberFloorHeight + 0.14, pillarZ - Math.sin(angle) * 1.1);
      skull.rotation.y = -angle + Math.PI / 2 + (random() - 0.5);
      skull.scale.setScalar(1.3);
      group.add(skull);
    }
  }

  // Iron braziers on tripods, burning hot.
  const emberSources: THREE.Vector3[] = [];
  const brazierLights: Array<{ light: THREE.PointLight; phase: number }> = [];
  const coalMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.25, 0.05).multiplyScalar(2) });
  for (const brazier of braziers) {
    const bowlHeight = 1.25;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.22, 0.38, 12, 1, true), ironMaterial);
    bowl.position.set(brazier.x, brazier.y + bowlHeight, brazier.z);
    bowl.castShadow = true;
    const coals = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12).rotateX(-Math.PI / 2), coalMaterial);
    coals.position.set(brazier.x, brazier.y + bowlHeight + 0.12, brazier.z);
    group.add(bowl, coals);
    for (let leg = 0; leg < 3; leg += 1) {
      const legAngle = (leg / 3) * Math.PI * 2;
      const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.35, 5), ironMaterial);
      legMesh.position.set(brazier.x + Math.cos(legAngle) * 0.22, brazier.y + 0.62, brazier.z + Math.sin(legAngle) * 0.22);
      legMesh.rotation.set(Math.sin(legAngle) * 0.3, 0, -Math.cos(legAngle) * 0.3);
      group.add(legMesh);
    }
    const flameBase = new THREE.Vector3(brazier.x, brazier.y + bowlHeight + 0.1, brazier.z);
    for (let tongue = 0; tongue < 4; tongue += 1) {
      const offsetAngle = random() * Math.PI * 2;
      const offset = tongue === 0 ? 0 : 0.18 + random() * 0.12;
      flames.push({ x: flameBase.x + Math.cos(offsetAngle) * offset, y: flameBase.y, z: flameBase.z + Math.sin(offsetAngle) * offset, width: 0.2, height: tongue === 0 ? 0.42 : 0.26, phase: random() * 100 });
    }
    emberSources.push(flameBase);
    const light = new THREE.PointLight(0xff6a24, 16, 9, 1.4);
    light.position.set(flameBase.x, flameBase.y + 0.8, flameBase.z);
    group.add(light);
    brazierLights.push({ light, phase: random() * 100 });
  }

  const waxGeometry = new THREE.CylinderGeometry(1, 1.06, 1, 10).translate(0, 0.5, 0);
  const wax = new THREE.InstancedMesh(waxGeometry, new THREE.MeshStandardMaterial({ roughness: 0.55, emissive: new THREE.Color(0.09, 0.035, 0.01) }), candles.length);
  const transform = new THREE.Object3D();
  candles.forEach((candle, index) => {
    transform.position.set(candle.x, candle.y, candle.z);
    transform.rotation.set((random() - 0.5) * 0.08, 0, (random() - 0.5) * 0.08);
    transform.scale.set(candle.radius, candle.height, candle.radius);
    transform.updateMatrix();
    wax.setMatrixAt(index, transform.matrix);
    wax.setColorAt(index, candle.tone);
  });
  wax.castShadow = true;
  group.add(wax);

  const flameGeometry = createFlameGeometry();
  const outerFlames = new THREE.InstancedMesh(flameGeometry, new THREE.MeshBasicMaterial({ color: candleColor.clone().multiplyScalar(3.2), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }), flames.length);
  const innerFlames = new THREE.InstancedMesh(flameGeometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.85, 0.55).multiplyScalar(5) }), flames.length);
  outerFlames.frustumCulled = innerFlames.frustumCulled = false;
  group.add(outerFlames, innerFlames);
  const halos = createFlameHalos(flames, candleColor.clone().multiplyScalar(1.4));
  group.add(halos.points);

  const sway = new THREE.Object3D();
  const emberColor = new THREE.Color(1, 0.45, 0.1).multiplyScalar(3);
  const emberEnd = new THREE.Color(0.35, 0.02, 0);
  const moteColor = sigilColor.clone().multiplyScalar(1.1);
  const moteEnd = new THREE.Color(0.1, 0, 0);
  const emitPosition = new THREE.Vector3();
  const rising = new THREE.Vector3(0, 1, 0);

  function update(elapsedSeconds: number, deltaSeconds: number): void {
    flames.forEach((flame, index) => {
      const strength = flicker(elapsedSeconds, flame.phase);
      const lean = Math.sin(elapsedSeconds * 3.1 + flame.phase) * 0.12 * config.render.candleFlicker;
      sway.position.set(flame.x, flame.y, flame.z);
      sway.rotation.set(lean * 0.6, 0, lean);
      sway.scale.set(flame.width / 2.2, (flame.height / 2.2) * strength, flame.width / 2.2);
      sway.updateMatrix();
      outerFlames.setMatrixAt(index, sway.matrix);
      sway.scale.set(flame.width / 4.4, (flame.height / 3.6) * strength, flame.width / 4.4);
      sway.updateMatrix();
      innerFlames.setMatrixAt(index, sway.matrix);
    });
    outerFlames.instanceMatrix.needsUpdate = true;
    innerFlames.instanceMatrix.needsUpdate = true;
    halos.material.uniforms.time!.value = elapsedSeconds;
    halos.material.uniforms.flicker!.value = config.render.candleFlicker;

    clusterLights.forEach(({ light, phase }) => (light.intensity = 7 * flicker(elapsedSeconds, phase)));
    brazierLights.forEach(({ light, phase }) => (light.intensity = 16 * flicker(elapsedSeconds * 0.8, phase)));

    // The circle breathes: a slow pulse with a faster shiver on top.
    const breath = 0.8 + Math.sin(elapsedSeconds * 1.1) * 0.16 + Math.sin(elapsedSeconds * 7.3) * 0.03;
    pentagramMaterial.opacity = breath;
    glyphMaterial.opacity = breath * 0.9;
    glyphRing.rotation.y = elapsedSeconds * 0.025;
    circleLight.intensity = 2 + breath * 4;

    if (deltaSeconds <= 0) return;
    for (const source of emberSources) {
      if (Math.random() < deltaSeconds * 22) {
        particles.emit({ position: source, count: 1, color: emberColor, colorEnd: emberEnd, speedMin: 0.8, speedMax: 2, direction: rising, spread: 0.5, gravity: 0.6, drag: 0.4, sizeStart: 0.1, sizeEnd: 0.02, lifeMin: 1, lifeMax: 2.2, jitter: 0.5 });
      }
    }
    // Embers drift up off the carved lines.
    if (Math.random() < deltaSeconds * 9) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * radius;
      emitPosition.set(Math.cos(angle) * distance, 0.05, Math.sin(angle) * distance);
      particles.emit({ position: emitPosition, count: 1, color: moteColor, colorEnd: moteEnd, speedMin: 0.15, speedMax: 0.5, direction: rising, spread: 0.8, gravity: 0.15, sizeStart: 0.09, sizeEnd: 0.02, lifeMin: 2.5, lifeMax: 4.5 });
    }
  }
  update(0, 0);
  return {
    group,
    update,
    setViewport(heightPixels, fieldOfViewDegrees) {
      halos.material.uniforms.pointScale!.value = heightPixels / (2 * Math.tan(THREE.MathUtils.degToRad(fieldOfViewDegrees) / 2));
    },
  };
}
