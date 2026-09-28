import * as THREE from "three";

// Shared drawing helpers for the dungeon's witchcraft: pentagrams, sigil glyphs and horns.

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// The five points of a pentagram. On a canvas (y down) a rotation of PI/2 puts one point at the
// bottom, which is the inverted star once the texture lies on the floor facing the camera.
export function pentagramPoints(centerX: number, centerY: number, radius: number, rotation: number): Array<[number, number]> {
  return Array.from({ length: 5 }, (_, index) => {
    const angle = rotation + (index / 5) * Math.PI * 2;
    return [centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius] as [number, number];
  });
}

export function strokePentagram(context: CanvasRenderingContext2D, centerX: number, centerY: number, radius: number, rotation = Math.PI / 2): void {
  const points = pentagramPoints(centerX, centerY, radius, rotation);
  context.beginPath();
  for (let step = 0; step <= 5; step += 1) {
    const [pointX, pointY] = points[(step * 2) % 5]!;
    if (step === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
  context.closePath();
  context.stroke();
}

export function strokeCircle(context: CanvasRenderingContext2D, centerX: number, centerY: number, radius: number): void {
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.stroke();
}

// A made-up occult glyph built around a vertical stem, drawn at the origin within about +-size.
// Crescents, crossbars, forks and hooks, in the spirit of planetary and demonic seals.
export function strokeSigil(context: CanvasRenderingContext2D, random: () => number, size: number): void {
  const stemTop = -size;
  const stemBottom = size;
  context.beginPath();
  context.moveTo(0, stemTop * 0.55);
  context.lineTo(0, stemBottom);

  const top = Math.floor(random() * 5);
  if (top === 0) {
    context.moveTo(size * 0.32, stemTop * 0.77);
    context.arc(0, stemTop * 0.77, size * 0.32, 0, Math.PI * 2);
  } else if (top === 1) {
    context.moveTo(-size * 0.45, stemTop);
    context.quadraticCurveTo(0, stemTop * 0.2, size * 0.45, stemTop);
  } else if (top === 2) {
    for (const offsetX of [-0.4, 0, 0.4]) {
      context.moveTo(offsetX * size, stemTop);
      context.lineTo(offsetX * size, stemTop * 0.55);
    }
    context.moveTo(-0.4 * size, stemTop * 0.55);
    context.lineTo(0.4 * size, stemTop * 0.55);
  } else if (top === 3) {
    context.moveTo(-size * 0.4, stemTop * 0.35);
    context.lineTo(0, stemTop);
    context.lineTo(size * 0.4, stemTop * 0.35);
  } else {
    context.moveTo(0, stemTop);
    context.lineTo(0, stemTop * 0.55);
    context.moveTo(-size * 0.3, stemTop * 0.8);
    context.lineTo(size * 0.3, stemTop * 0.8);
  }

  const middle = Math.floor(random() * 4);
  if (middle === 0) {
    context.moveTo(-size * 0.5, 0);
    context.lineTo(size * 0.5, 0);
  } else if (middle === 1) {
    context.moveTo(-size * 0.4, -size * 0.12);
    context.lineTo(size * 0.4, -size * 0.12);
    context.moveTo(-size * 0.4, size * 0.18);
    context.lineTo(size * 0.4, size * 0.18);
  } else if (middle === 2) {
    const side = random() < 0.5 ? -1 : 1;
    context.moveTo(side * size * 0.52, 0);
    context.arc(side * size * 0.34, 0, size * 0.18, 0, Math.PI * 2);
  }

  const bottom = Math.floor(random() * 4);
  if (bottom === 0) {
    context.moveTo(0, stemBottom);
    context.quadraticCurveTo(size * 0.5, stemBottom, size * 0.45, stemBottom * 0.55);
  } else if (bottom === 1) {
    context.moveTo(-size * 0.3, stemBottom * 0.72);
    context.lineTo(size * 0.3, stemBottom * 0.72);
  } else if (bottom === 2) {
    context.moveTo(-size * 0.35, stemBottom);
    context.lineTo(0, stemBottom * 0.6);
    context.lineTo(size * 0.35, stemBottom);
  }
  context.stroke();
}

// A tube along a curve that tapers to a point: horns for the demon, the crescent on each staff.
export function createHornGeometry(curve: THREE.Curve<THREE.Vector3>, baseRadius: number, segments = 12, radialSegments = 7): THREE.BufferGeometry {
  const geometry = new THREE.TubeGeometry(curve, segments, baseRadius, radialSegments, false);
  const position = geometry.attributes.position!;
  const center = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    const along = Math.floor(index / (radialSegments + 1)) / segments;
    curve.getPointAt(along, center);
    vertex.fromBufferAttribute(position, index).sub(center).multiplyScalar(1 - along * 0.94).add(center);
    position.setXYZ(index, vertex.x, vertex.y, vertex.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// A crude skull: cranium, jaw and dark sockets. Small enough on screen that this reads well.
export function createSkull(boneMaterial: THREE.Material, socketMaterial: THREE.Material): THREE.Group {
  const skull = new THREE.Group();
  const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10).scale(1, 0.92, 1.12), boneMaterial);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.08, 0.13), boneMaterial);
  jaw.position.set(0, -0.11, 0.07);
  skull.add(cranium, jaw);
  for (const side of [-1, 1]) {
    const socket = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), socketMaterial);
    socket.position.set(side * 0.058, -0.015, 0.145);
    skull.add(socket);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 3).rotateX(Math.PI), socketMaterial);
  nose.position.set(0, -0.07, 0.165);
  skull.add(nose);
  skull.traverse((child) => {
    if (child instanceof THREE.Mesh) child.castShadow = true;
  });
  return skull;
}
