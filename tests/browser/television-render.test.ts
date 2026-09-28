/**
 * Rendu visuel minimal de la télé, au plus près du comportement réel du jeu :
 * - chargement par le vrai `loadTemplateModel` (Draco + WebP + fusion par matériau + effet VHS,
 *   comme `propLoader.ts`) ;
 * - même détection que la factory `television` : `findTelevisionScreen` puis fallback
 *   `findModelFace(TV_FRONT)` (voir `interactions.ts`) ;
 * - même classe `FaceCanvas` que la factory réelle pour poser/remplacer l'écran.
 *
 * Socle commun (renderer, scène, cadrage, contrôleur d'étapes) dans support/harness.ts.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/television-render.html.
 * Ou en headless : `node scripts/render-test.mjs television-render`.
 */
import * as THREE from "three";
import televisionUrl from "../../src/assets/models/props/television.glb";
import { FaceCanvas, findTelevisionScreen } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";
import { createLogger, createRenderer, createScene, createStageController, drawStaticNoise, frameOnObject } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["OFF", "ON"]);

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  const scene = createScene(0x111111);
  const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.05, 20);

  const template = await loadTemplateModel(televisionUrl);
  scene.add(template);
  frameOnObject(camera, template, new THREE.Vector3(0, 0, 1));

  renderer.render(scene, camera);
  log("Rendu 'éteint' (matériau d'origine) affiché.");
  await stages.enter("OFF");

  // --- Reproduit exactement la logique de la factory `television` (interactions.ts) ---
  const TV_FRONT = new THREE.Vector3(0, 0, 1);
  const existingScreen = findTelevisionScreen(template);
  const face = existingScreen ? null : findModelFace(template, TV_FRONT);
  log(existingScreen ? `Sous-maille écran détectée : "${existingScreen.name || "(sans nom)"}" → remplacement en place.` : "Pas de sous-maille écran dédiée → pose d'un plan sur la face avant détectée (fallback).");

  const screen = existingScreen ? new FaceCanvas(template, null, 160, 120, { existingMesh: existingScreen, glow: true }) : face ? new FaceCanvas(template, face, 160, 120, { shrink: 0.68, glow: true }) : null;

  if (!screen) {
    log("ÉCHEC : ni sous-maille écran ni face avant détectée — impossible de poser un écran.");
    await stages.enter("ON");
    return;
  }

  drawStaticNoise(screen.ctx, 160, 120);
  screen.commit();
  screen.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'allumé' (écran remplacé par le bruit statique) affiché.");
  await stages.enter("ON");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
