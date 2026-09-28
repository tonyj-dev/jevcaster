import * as THREE from "three";
import { seededRandom, strokeCircle, strokePentagram, strokeSigil } from "../models/occult.ts";

export type CloakBubble = {
  mesh: THREE.Mesh;
  // progress: 0 while hexes start assembling, 1 once the cloak is fully up; negative hides it.
  update(position: THREE.Vector3, color: THREE.Color, progress: number, deltaSeconds: number, elapsedSeconds: number): void;
  ripple(fromDirection: THREE.Vector3): void;
};

const vertexShader = /* glsl */ `
  varying vec3 objectPosition;
  varying vec3 viewNormal;
  varying vec3 viewDirection;
  void main() {
    objectPosition = normalize(position);
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    viewNormal = normalize(normalMatrix * normal);
    viewDirection = normalize(-viewPosition.xyz);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 cloakColor;
  uniform float progress;
  uniform float time;
  uniform float rippleAge;
  uniform vec3 rippleDirection;
  varying vec3 objectPosition;
  varying vec3 viewNormal;
  varying vec3 viewDirection;

  float hash(vec2 cell) { return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453); }

  // Nearest hex centre: returns the offset inside the cell (xy) and the cell id (zw).
  vec4 hexCell(vec2 uv) {
    vec2 ratio = vec2(1.0, 1.7320508);
    vec2 half_ = ratio * 0.5;
    vec2 first = mod(uv, ratio) - half_;
    vec2 second = mod(uv - half_, ratio) - half_;
    vec2 offset = dot(first, first) < dot(second, second) ? first : second;
    return vec4(offset, uv - offset);
  }

  float hexDistance(vec2 offset) {
    offset = abs(offset);
    return max(dot(offset, normalize(vec2(1.0, 1.7320508))), offset.x);
  }

  void main() {
    float fresnel = pow(1.0 - abs(dot(viewNormal, viewDirection)), 2.2);
    vec2 uv = vec2(atan(objectPosition.z, objectPosition.x) * 2.6, objectPosition.y * 4.2);
    vec4 cell = hexCell(uv);
    float edge = smoothstep(0.36, 0.48, hexDistance(cell.xy));
    // During the wind-up, cells appear one by one in random order.
    float cellVisible = step(hash(cell.zw), progress * 1.15);
    float shimmer = 0.6 + 0.4 * sin(time * 3.0 + hash(cell.zw) * 6.28);
    float angleFromHit = acos(clamp(dot(objectPosition, rippleDirection), -1.0, 1.0));
    float ripple = exp(-pow(angleFromHit - rippleAge * 7.0, 2.0) * 18.0) * exp(-rippleAge * 5.0);
    float fullyUp = step(1.0, progress);
    float intensity = cellVisible * (edge * 0.8 * shimmer + 0.05) + fresnel * (0.25 + 0.75 * fullyUp) + ripple * 1.8;
    gl_FragColor = vec4(cloakColor * intensity, 1.0);
  }
`;

// The summoning circle drawn on the floor under a cloaked mage: a pentagram in a ring of sigils.
let circleTexture: THREE.CanvasTexture | null = null;
function getCircleTexture(): THREE.CanvasTexture {
  if (circleTexture) return circleTexture;
  const size = 512;
  const center = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const random = seededRandom(31);
  context.fillStyle = "#000";
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "#fff";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 6;
  strokeCircle(context, center, center, size * 0.47);
  context.lineWidth = 3;
  strokeCircle(context, center, center, size * 0.36);
  context.lineWidth = 5;
  strokePentagram(context, center, center, size * 0.36);
  context.lineWidth = 3;
  for (let glyph = 0; glyph < 14; glyph += 1) {
    const angle = (glyph / 14) * Math.PI * 2;
    context.save();
    context.translate(center + Math.cos(angle) * size * 0.415, center + Math.sin(angle) * size * 0.415);
    context.rotate(angle + Math.PI / 2);
    strokeSigil(context, random, 13);
    context.restore();
  }
  circleTexture = new THREE.CanvasTexture(canvas);
  return circleTexture;
}

export function createCloakBubble(scene: THREE.Scene): CloakBubble {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      cloakColor: { value: new THREE.Color() },
      progress: { value: 0 },
      time: { value: 0 },
      rippleAge: { value: 10 },
      rippleDirection: { value: new THREE.Vector3(0, 0, 1) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
  mesh.scale.set(1.05, 1.2, 1.05);
  mesh.visible = false;
  mesh.renderOrder = 5;
  scene.add(mesh);
  const uniforms = material.uniforms;

  const circleMaterial = new THREE.MeshBasicMaterial({ alphaMap: getCircleTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const circle = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), circleMaterial);
  circle.visible = false;
  circle.renderOrder = 3;
  scene.add(circle);

  return {
    mesh,
    update(position, color, progress, deltaSeconds, elapsedSeconds) {
      mesh.visible = progress >= 0;
      circle.visible = mesh.visible;
      if (!mesh.visible) return;
      // The circle is drawn outward from the caster as the cloak winds up, then turns while it holds.
      const drawn = progress >= 1 ? 1 : 0.35 + progress * 0.65;
      circle.position.set(position.x, 0.03, position.z);
      circle.scale.setScalar(2.9 * drawn);
      circle.rotation.y = -elapsedSeconds * 0.6;
      circleMaterial.color.copy(color).multiplyScalar((progress >= 1 ? 1.6 : 0.9) * (0.9 + Math.sin(elapsedSeconds * 5) * 0.1));
      mesh.position.set(position.x, 1.0, position.z);
      uniforms.cloakColor!.value.copy(color).multiplyScalar(progress >= 1 ? 0.55 : 0.4);
      uniforms.progress!.value = progress;
      uniforms.time!.value = elapsedSeconds;
      uniforms.rippleAge!.value += deltaSeconds;
      const swell = progress >= 1 ? 1 : 0.85 + progress * 0.15;
      mesh.scale.set(1.05 * swell, 1.2 * swell, 1.05 * swell);
    },
    ripple(fromDirection) {
      uniforms.rippleAge!.value = 0;
      uniforms.rippleDirection!.value.copy(fromDirection).normalize();
    },
  };
}
