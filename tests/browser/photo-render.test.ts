/**
 * Rendu visuel minimal du cadre photo, même principe que television-render.test.ts : la vraie
 * détection de la sous-maille dédiée (`findMeshByName(/artwork/i)`), sans
 * InteractionSystem/monde/joueur/WebGLRenderer factice.
 *
 * Socle commun (renderer, scène, cadrage, contrôleur d'étapes) dans support/harness.ts.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/photo-render.html.
 * Ou en headless : `node scripts/render-test.mjs photo-render`.
 */
import * as THREE from "three";
import photoUrl from "../../src/assets/models/collectibles/photo.glb";
import { canvasSizeForAspect, createMeshCanvas, findMeshByName, meshPlateAspect } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { createLogger, createRenderer, createScene, createStageController, drawCheckerboard, frameOnPoint } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["OFF", "ON"]);
const FRONT_DIR = new THREE.Vector3(1, 0, 0);

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  const scene = createScene(0x111111);
  const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.05, 20);

  const template = await loadTemplateModel(photoUrl);
  scene.add(template);
  // Direction physique connue de l'avant du modèle (indépendante de `findModelFace(template)`
  // sans axe imposé, qui compare l'aire des 6 faces candidates : avec un dos séparé en vraie
  // plaque, son aire peut dépasser celle de la façade et faire "gagner" le mauvais côté).
  frameOnPoint(camera, new THREE.Box3().setFromObject(template).getCenter(new THREE.Vector3()), new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3()).length() * 0.35, FRONT_DIR);

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériaux d'origine, cadre + vitre + artwork) affiché.");
  await stages.enter("OFF");

  const artwork = findMeshByName(template, /artwork/i);
  log(artwork ? `Sous-maille artwork détectée : "${artwork.name || "(sans nom)"}" → remplacement en place (derrière la vitre).` : "Sous-maille artwork absente.");

  if (!artwork) {
    log("ÉCHEC : aucune surface détectée pour poser la photo.");
    await stages.enter("ON");
    return;
  }
  const [fw, fh] = canvasSizeForAspect(meshPlateAspect(artwork));
  log(`Ratio retenu pour l'avant : ${fw}×${fh}px (au lieu d'un carré 192×192).`);
  const frontCanvas = createMeshCanvas(artwork, fw, fh, { remapUv: true });

  drawCheckerboard(frontCanvas.ctx, fw, fh);
  frontCanvas.commit();
  frontCanvas.activate();

  renderer.render(scene, camera);
  log("Rendu 'photo posée' (damier de test à la place de la vraie image) affiché.");
  await stages.enter("ON");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
