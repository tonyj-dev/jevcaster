import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { config } from "../config.ts";

export type PostEffects = {
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
  resize(width: number, height: number): void;
  render(elapsedSeconds: number): void;
};

// Heavy vignette, a touch of film grain and crushed, blood-warm shadows. Runs in linear space
// before the output pass tone maps.
const dungeonGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    vignette: { value: 1 },
    grain: { value: 0.05 },
    time: { value: 0 },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float grain;
    uniform float time;
    uniform float aspect;
    varying vec2 vUv;

    float hash(vec2 point) { return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      vec2 centered = (vUv - 0.5) * vec2(aspect, 1.0);
      float edge = smoothstep(0.35, 1.05, length(centered) * vignette);
      color *= 1.0 - edge * 0.92;
      // Pull the darks toward a dried-blood brown.
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      vec3 shadowTint = vec3(1.12, 0.9, 0.86);
      color *= mix(shadowTint, vec3(1.0), smoothstep(0.0, 0.35, luminance));
      float noise = hash(vUv * 1024.0 + fract(time * 7.13) * 91.0) - 0.5;
      color += noise * grain * (0.35 + luminance);
      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

export function createPostEffects(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): PostEffects {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(size, config.render.bloomStrength, config.render.bloomRadius, config.render.bloomThreshold);
  composer.addPass(bloomPass);
  const gradePass = new ShaderPass(dungeonGradeShader);
  composer.addPass(gradePass);
  composer.addPass(new OutputPass());
  const gradeUniforms = gradePass.uniforms as typeof dungeonGradeShader.uniforms;
  gradeUniforms.aspect.value = size.x / Math.max(1, size.y);
  return {
    composer,
    bloomPass,
    resize(width, height) {
      composer.setSize(width, height);
      gradeUniforms.aspect.value = width / Math.max(1, height);
    },
    render(elapsedSeconds) {
      // Read live so the dev panel can tune the look while playing.
      bloomPass.strength = config.render.bloomStrength;
      bloomPass.radius = config.render.bloomRadius;
      bloomPass.threshold = config.render.bloomThreshold;
      renderer.toneMappingExposure = config.render.toneMappingExposure;
      gradeUniforms.vignette.value = config.render.vignetteStrength;
      gradeUniforms.grain.value = config.render.filmGrain;
      gradeUniforms.time.value = elapsedSeconds;
      composer.render();
    },
  };
}
