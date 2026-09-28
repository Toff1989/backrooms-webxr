/**
 * Rendu visuel minimal de la télé, au plus près du comportement réel du jeu :
 * - chargement par le vrai `loadTemplateModel` (Draco + WebP + fusion par matériau + effet VHS,
 *   comme `propLoader.ts`) ;
 * - même détection que la factory `television` : `findTelevisionScreen` puis fallback
 *   `findModelFace(TV_FRONT)` (voir `interactions.ts`) ;
 * - même classe `FaceCanvas` que la factory réelle pour poser/remplacer l'écran.
 *
 * Pas de moteur de jeu, pas d'InteractionSystem, pas de player/monde : juste une scène three.js,
 * une caméra et une lumière — l'environnement le plus simple qui exerce le vrai code de rendu.
 * WebGL tourne ici en logiciel (SwiftShader) puisqu'on est en Chromium headless sans GPU.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/television-render.html.
 * Ou en headless avec capture d'écran : `node scripts/test-television-render.mjs`.
 */
import * as THREE from "three";
import televisionUrl from "../../src/assets/models/props/television.glb";
import { FaceCanvas, findTelevisionScreen } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";

const results: string[] = [];
const log = (line: string): void => {
  results.push(line);
  console.log(line);
  const el = document.getElementById("results");
  if (el) el.textContent = results.join("\n");
};

function frameCamera(camera: THREE.PerspectiveCamera, object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const distance = Math.max(size.x, size.y) / (2 * Math.tan((camera.fov * Math.PI) / 360)) + size.z;
  camera.position.set(center.x, center.y, center.z + distance * 1.4);
  camera.lookAt(center);
}

// Signale au runner headless que le rendu est prêt à être capturé.
function markReady(name: string): void {
  (window as unknown as Record<string, boolean>)[`__${name}_READY__`] = true;
}

async function run(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  // preserveDrawingBuffer : sans lui, toDataURL() peut lire un buffer déjà effacé (le runner
  // headless capture le canvas juste après le render, hors de toute boucle de compositing).
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(1, 2, 3);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.05, 20);

  const template = await loadTemplateModel(televisionUrl);
  scene.add(template);
  frameCamera(camera, template);

  renderer.render(scene, camera);
  log("Rendu 'éteint' (matériau d'origine) affiché.");
  markReady("OFF");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // --- Reproduit exactement la logique de la factory `television` (interactions.ts) ---
  const TV_FRONT = new THREE.Vector3(0, 0, 1);
  const existingScreen = findTelevisionScreen(template);
  const face = existingScreen ? null : findModelFace(template, TV_FRONT);
  log(existingScreen ? `Sous-maille écran détectée : "${existingScreen.name || "(sans nom)"}" → remplacement en place.` : "Pas de sous-maille écran dédiée → pose d'un plan sur la face avant détectée (fallback).");

  const screen = existingScreen ? new FaceCanvas(template, null, 160, 120, { existingMesh: existingScreen, glow: true }) : face ? new FaceCanvas(template, face, 160, 120, { shrink: 0.68, glow: true }) : null;

  if (!screen) {
    log("ÉCHEC : ni sous-maille écran ni face avant détectée — impossible de poser un écran.");
    markReady("ON");
    return;
  }

  // Dessine un bruit "statique" comme le fait `drawStatic` dans interactions.ts.
  const noise = screen.ctx.createImageData(160, 120);
  for (let i = 0; i < noise.data.length; i += 4) {
    const v = Math.random() * 230;
    noise.data[i] = v;
    noise.data[i + 1] = v;
    noise.data[i + 2] = v * 1.05;
    noise.data[i + 3] = 255;
  }
  screen.ctx.putImageData(noise, 0, 0);
  screen.commit();
  screen.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'allumé' (écran remplacé par le bruit statique) affiché.");
  markReady("ON");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  markReady("OFF");
  markReady("ON");
});
