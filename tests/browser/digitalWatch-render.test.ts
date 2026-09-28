/**
 * Rendu visuel minimal de la montre digitale, même principe que compass-render.test.ts : la
 * vraie détection (`findModelFace` sur l'axe (0,1,0), comme `UP_AXES`/`faceOf` dans
 * `interactions.ts`) et la vraie classe `FaceCanvas`, avec le même dessin d'écran que la factory
 * `digitalWatch` (dupliqué ici car `digitalWatch`/`dial`/`UP_AXES` ne sont pas exportés). Ce
 * modèle n'a pas de repère "centre" dédié (contrairement au compass/dial_center) : la face
 * auto-détectée est directement le cadran.
 *
 * Socle commun (renderer, scène, cadrage, contrôleur d'étapes) dans support/harness.ts.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/digitalWatch-render.html.
 * Ou en headless : `node scripts/render-test.mjs digitalWatch-render`.
 */
import * as THREE from "three";
import digitalWatchUrl from "../../src/assets/models/collectibles/digitalWatch.glb";
import { FaceCanvas } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";
import { createLogger, createRenderer, createScene, createStageController, frameOnPoint } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["OFF", "ON", "PROFILE"]);
const UP_AXES = [new THREE.Vector3(0, 1, 0)];

// Reproduit exactement le dessin de `digitalWatch` dans interactions.ts, pour un temps de test fixe.
function drawClock(ctx: CanvasRenderingContext2D, totalSeconds: number): void {
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = "#9fb08a";
  ctx.fillRect(0, 28, 128, 72);
  ctx.fillStyle = "#1f2a18";
  ctx.font = "bold 30px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const total = Math.floor(totalSeconds);
  ctx.fillText(`${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`, 64, 64);
}

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  const scene = createScene(0x333333);
  const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.01, 20);

  const template = await loadTemplateModel(digitalWatchUrl);
  scene.add(template);

  const face = findModelFace(template, undefined, UP_AXES);
  log(face ? `Face détectée : centre (${face.center.x.toFixed(3)}, ${face.center.y.toFixed(3)}, ${face.center.z.toFixed(3)}), ${face.width.toFixed(3)}×${face.height.toFixed(3)} m` : "Aucune face détectée sur l'axe haut.");
  if (!face) {
    renderer.render(scene, camera);
    await stages.enter("OFF");
    await stages.enter("ON");
    await stages.enter("PROFILE");
    return;
  }
  frameOnPoint(camera, face.center, Math.max(face.width, face.height) * 0.6, new THREE.Vector3(0.35, 1, 0.35));

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériau d'origine) affiché.");
  await stages.enter("OFF");

  const screenCanvas = new FaceCanvas(template, face, 128, 128, { shrink: 0.7, glow: true, transparent: true, raise: 0.08 });
  drawClock(screenCanvas.ctx, 754);
  screenCanvas.commit();
  screenCanvas.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'écran allumé' (heure de test fixe) affiché.");
  await stages.enter("ON");

  // Vue de profil : révèle un décalage de hauteur entre le plan de l'écran et le boîtier,
  // invisible depuis le dessus (même vérification que pour le compass).
  frameOnPoint(camera, face.center, Math.max(face.width, face.height) * 0.6, new THREE.Vector3(1, 0.05, 0));
  renderer.render(scene, camera);
  log("Rendu 'profil' (pour repérer un décalage de hauteur de l'écran) affiché.");
  await stages.enter("PROFILE");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
