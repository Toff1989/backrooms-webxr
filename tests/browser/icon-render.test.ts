/**
 * Icône du site : texture du mur des Backrooms (assets-src/textures/wall/basecolor.webp) avec,
 * par-dessus, la tête du Cadreur (la vraie caméra 8 mm du jeu) de face, LED "REC" allumée.
 * Lancer : `node scripts/render-test.mjs icon-render` (sortie : tests/browser/out/icon-icon.png).
 */
import * as THREE from "three";
import wallUrl from "../../assets-src/textures/wall/basecolor.webp";
import { spawnCollectibleModel } from "../../src/world/collectibleLoader";
import { createLogger, createRenderer, createStageController } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["ICON"]);

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0805);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);

  const wall = await new THREE.TextureLoader().loadAsync(wallUrl);
  wall.colorSpace = THREE.SRGBColorSpace;
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: wall, color: 0xb8b8b8 }));
  backdrop.position.z = -1;
  scene.add(backdrop);

  const { model } = await spawnCollectibleModel("cadreurHead");
  const pivot = new THREE.Group();
  pivot.add(model);
  scene.add(pivot);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(box.getCenter(new THREE.Vector3()));
  pivot.scale.setScalar(1.05 / Math.max(size.x, size.y, size.z));
  const front = new URLSearchParams(location.search).get("rot");
  model.rotation.y = front ? THREE.MathUtils.degToRad(Number(front)) : 0;
  model.updateMatrixWorld(true);

  // LED REC allumée (même position que cadreurModel.ts), avec halo.
  const ledPos = new THREE.Vector3(0.028, 0.07, 0.015);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false }));
  led.position.copy(ledPos);
  model.add(led);
  const haloCanvas = document.createElement("canvas");
  haloCanvas.width = haloCanvas.height = 64;
  const hctx = haloCanvas.getContext("2d")!;
  const grad = hctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,60,40,1)");
  grad.addColorStop(0.25, "rgba(255,40,30,0.55)");
  grad.addColorStop(1, "rgba(255,30,20,0)");
  hctx.fillStyle = grad;
  hctx.fillRect(0, 0, 64, 64);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(haloCanvas), blending: THREE.AdditiveBlending, depthTest: false, toneMapped: false }));
  halo.scale.setScalar(0.06);
  halo.position.copy(ledPos);
  model.add(halo);

  scene.add(new THREE.HemisphereLight(0xfff3cf, 0x171512, 1.6));
  const key = new THREE.DirectionalLight(0xfff1d6, 2.2);
  key.position.set(0.5, 1, 3);
  scene.add(key);

  camera.position.set(0, 0, 3.2);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  log(`Icône rendue (modèle ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}).`);
  await stages.enter("ICON");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
