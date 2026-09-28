import * as THREE from "three";
import { config } from "../config.ts";

// A dungeon lit mostly by fire: a dim bloody ambient, a pale shaft from a hole in the vault above
// (the only shadow caster) and a crimson rim from behind. Candles, braziers and the glowing circle
// add their own point lights in the arena.
export function addLighting(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0x6a3a3c, 0x100607, 0.9));

  const shaftLight = new THREE.DirectionalLight(0xd8b8a8, 1.1);
  shaftLight.position.set(-5, 16, 6);
  shaftLight.castShadow = true;
  shaftLight.shadow.mapSize.set(2048, 2048);
  // Shadow frustum covers the dais and its ledge with a little margin.
  const shadowExtent = config.sim.arenaRadius + 3;
  shaftLight.shadow.camera.left = -shadowExtent;
  shaftLight.shadow.camera.right = shadowExtent;
  shaftLight.shadow.camera.top = shadowExtent;
  shaftLight.shadow.camera.bottom = -shadowExtent;
  shaftLight.shadow.camera.near = 1;
  shaftLight.shadow.camera.far = 40;
  shaftLight.shadow.bias = -0.0005;
  shaftLight.shadow.normalBias = 0.02;
  scene.add(shaftLight);

  const rimLight = new THREE.DirectionalLight(0xff2a2a, 1.7);
  rimLight.position.set(3, 5, -12);
  scene.add(rimLight);
}
