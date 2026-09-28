import * as THREE from "three";

// One pooled, additive point-sprite system for every spark, ember and trail in the game.
export type ParticleBurst = {
  position: THREE.Vector3;
  count: number;
  color: THREE.Color;
  colorEnd?: THREE.Color;
  speedMin?: number;
  speedMax?: number;
  direction?: THREE.Vector3;
  spread?: number;
  sizeStart: number;
  sizeEnd?: number;
  lifeMin: number;
  lifeMax: number;
  gravity?: number;
  drag?: number;
  jitter?: number;
};

export type ParticleSystem = {
  points: THREE.Points;
  emit(burst: ParticleBurst): void;
  update(deltaSeconds: number): void;
  setViewport(heightPixels: number, fieldOfViewDegrees: number): void;
};

const vertexShader = /* glsl */ `
  attribute vec3 particleColor;
  attribute float particleSize;
  attribute float particleAlpha;
  uniform float pointScale;
  varying vec3 fragmentColor;
  varying float fragmentAlpha;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = particleSize * pointScale / max(0.1, -viewPosition.z);
    fragmentColor = particleColor;
    fragmentAlpha = particleAlpha;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 fragmentColor;
  varying float fragmentAlpha;
  void main() {
    float distanceFromCenter = length(gl_PointCoord - 0.5) * 2.0;
    float falloff = pow(max(0.0, 1.0 - distanceFromCenter), 1.6);
    if (falloff * fragmentAlpha < 0.004) discard;
    gl_FragColor = vec4(fragmentColor * falloff * fragmentAlpha, 1.0);
  }
`;

export function createParticleSystem(capacity: number): ParticleSystem {
  const positions = new Float32Array(capacity * 3);
  const velocities = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const startColors = new Float32Array(capacity * 3);
  const endColors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const startSizes = new Float32Array(capacity);
  const endSizes = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);
  const ages = new Float32Array(capacity);
  const lifetimes = new Float32Array(capacity);
  const gravities = new Float32Array(capacity);
  const drags = new Float32Array(capacity);
  let nextSlot = 0;

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colorAttribute = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttribute = new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage);
  const alphaAttribute = new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("particleColor", colorAttribute);
  geometry.setAttribute("particleSize", sizeAttribute);
  geometry.setAttribute("particleAlpha", alphaAttribute);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { pointScale: { value: 400 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;

  const randomDirection = new THREE.Vector3();
  const color = new THREE.Color();
  const endColor = new THREE.Color();

  function emit(burst: ParticleBurst): void {
    const speedMin = burst.speedMin ?? 0;
    const speedMax = burst.speedMax ?? speedMin;
    const colorEnd = burst.colorEnd ?? burst.color;
    for (let index = 0; index < burst.count; index += 1) {
      const slot = nextSlot;
      nextSlot = (nextSlot + 1) % capacity;
      const slot3 = slot * 3;
      const jitter = burst.jitter ?? 0;
      positions[slot3] = burst.position.x + (Math.random() - 0.5) * jitter;
      positions[slot3 + 1] = burst.position.y + (Math.random() - 0.5) * jitter;
      positions[slot3 + 2] = burst.position.z + (Math.random() - 0.5) * jitter;

      randomDirection.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (burst.direction) randomDirection.multiplyScalar(burst.spread ?? 1).add(burst.direction).normalize();
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      velocities[slot3] = randomDirection.x * speed;
      velocities[slot3 + 1] = randomDirection.y * speed;
      velocities[slot3 + 2] = randomDirection.z * speed;

      startColors[slot3] = burst.color.r;
      startColors[slot3 + 1] = burst.color.g;
      startColors[slot3 + 2] = burst.color.b;
      endColors[slot3] = colorEnd.r;
      endColors[slot3 + 1] = colorEnd.g;
      endColors[slot3 + 2] = colorEnd.b;
      startSizes[slot] = burst.sizeStart;
      endSizes[slot] = burst.sizeEnd ?? 0;
      ages[slot] = 0;
      lifetimes[slot] = burst.lifeMin + Math.random() * (burst.lifeMax - burst.lifeMin);
      gravities[slot] = burst.gravity ?? 0;
      drags[slot] = burst.drag ?? 0;
    }
  }

  function update(deltaSeconds: number): void {
    for (let slot = 0; slot < capacity; slot += 1) {
      if (lifetimes[slot] === 0) continue;
      const age = ages[slot]! + deltaSeconds;
      const lifetime = lifetimes[slot]!;
      if (age >= lifetime) {
        lifetimes[slot] = 0;
        sizes[slot] = 0;
        alphas[slot] = 0;
        continue;
      }
      ages[slot] = age;
      const progress = age / lifetime;
      const slot3 = slot * 3;
      const dragFactor = Math.exp(-drags[slot]! * deltaSeconds);
      velocities[slot3] = velocities[slot3]! * dragFactor;
      velocities[slot3 + 1] = velocities[slot3 + 1]! * dragFactor + gravities[slot]! * deltaSeconds;
      velocities[slot3 + 2] = velocities[slot3 + 2]! * dragFactor;
      positions[slot3] = positions[slot3]! + velocities[slot3]! * deltaSeconds;
      positions[slot3 + 1] = positions[slot3 + 1]! + velocities[slot3 + 1]! * deltaSeconds;
      positions[slot3 + 2] = positions[slot3 + 2]! + velocities[slot3 + 2]! * deltaSeconds;
      color.setRGB(startColors[slot3]!, startColors[slot3 + 1]!, startColors[slot3 + 2]!);
      color.lerp(endColor.setRGB(endColors[slot3]!, endColors[slot3 + 1]!, endColors[slot3 + 2]!), progress);
      colors[slot3] = color.r;
      colors[slot3 + 1] = color.g;
      colors[slot3 + 2] = color.b;
      sizes[slot] = startSizes[slot]! + (endSizes[slot]! - startSizes[slot]!) * progress;
      alphas[slot] = 1 - progress * progress;
    }
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    sizeAttribute.needsUpdate = true;
    alphaAttribute.needsUpdate = true;
  }

  return {
    points,
    emit,
    update,
    setViewport(heightPixels, fieldOfViewDegrees) {
      material.uniforms.pointScale!.value = heightPixels / (2 * Math.tan(THREE.MathUtils.degToRad(fieldOfViewDegrees) / 2));
    },
  };
}
