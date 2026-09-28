/**
 * Rendu visuel minimal de la boussole, même principe que les autres tests de rendu : la vraie
 * détection (`findModelFace` sur l'axe (0,1,0), comme `UP_AXES` dans `interactions.ts` — un seul
 * candidat, donc pas d'ambiguïté haut/bas à reproduire ici), le repère "dial_center" (si présent)
 * pour recentrer l'aiguille, et la vraie classe `FaceCanvas`, avec le même dessin d'aiguille que
 * la factory `compass` (dupliqué ici car `compass`/`dial`/`UP_AXES` ne sont pas exportés).
 *
 * Socle commun (renderer, scène, cadrage, contrôleur d'étapes) dans support/harness.ts.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/compass-render.html.
 * Ou en headless : `node scripts/render-test.mjs compass-render`.
 */
import * as THREE from "three";
import compassUrl from "../../src/assets/models/collectibles/compass.glb";
import { FaceCanvas, findMeshByName } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";
import { createLogger, createRenderer, createScene, createStageController, frameOnPoint } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["OFF", "ON", "PROFILE"]);

// Reproduit exactement le dessin de `compass` dans interactions.ts, pour un angle de test fixe
// (sans dépendre de la logique de sortie/monde).
function drawNeedle(ctx: CanvasRenderingContext2D, angle: number): void {
  ctx.clearRect(0, 0, 128, 128);
  ctx.save();
  ctx.translate(64, 64);
  ctx.rotate(angle);
  ctx.fillStyle = "rgba(200, 30, 30, 0.95)";
  ctx.beginPath();
  ctx.moveTo(0, -46);
  ctx.lineTo(7, 0);
  ctx.lineTo(-7, 0);
  ctx.fill();
  ctx.fillStyle = "rgba(230, 230, 220, 0.9)";
  ctx.beginPath();
  ctx.moveTo(0, 46);
  ctx.lineTo(7, 0);
  ctx.lineTo(-7, 0);
  ctx.fill();
  ctx.restore();
}

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  const scene = createScene(0x333333);
  const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.01, 20);

  const template = await loadTemplateModel(compassUrl);
  scene.add(template);

  const face = findModelFace(template, new THREE.Vector3(0, 1, 0));
  log(face ? `Face détectée : centre (${face.center.x.toFixed(3)}, ${face.center.y.toFixed(3)}, ${face.center.z.toFixed(3)}), ${face.width.toFixed(3)}×${face.height.toFixed(3)} m` : "Aucune face détectée sur l'axe haut.");
  if (!face) {
    renderer.render(scene, camera);
    await stages.enter("OFF");
    await stages.enter("ON");
    await stages.enter("PROFILE");
    return;
  }
  // Cadré sur le cadran lui-même (pas la bbox globale, faussée par le couvercle ouvert).
  frameOnPoint(camera, face.center, Math.max(face.width, face.height) * 0.6, new THREE.Vector3(0.35, 1, 0.35));

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériau d'origine) affiché.");
  await stages.enter("OFF");

  const dialCanvas = new FaceCanvas(template, face, 128, 128, { shrink: 0.7, glow: true, transparent: true, raise: -0.08 });
  const centerMesh = findMeshByName(template, /dial_center/i);
  log(centerMesh ? 'Repère "dial_center" détecté → recentrage de l\'aiguille dessus.' : 'Pas de repère "dial_center" → l\'aiguille reste sur la face auto-détectée.');
  if (centerMesh) {
    centerMesh.geometry.computeBoundingBox();
    dialCanvas.mesh.position.copy(centerMesh.geometry.boundingBox!.getCenter(new THREE.Vector3()));
  }
  drawNeedle(dialCanvas.ctx, 0.4);
  dialCanvas.commit();
  dialCanvas.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'aiguille dessinée' (angle de test fixe) affiché.");
  await stages.enter("ON");

  // Vue de profil : révèle un décalage de hauteur entre le plan de l'aiguille et le cadran,
  // invisible depuis le dessus.
  const profileCenter = centerMesh ? dialCanvas.mesh.position : face.center;
  frameOnPoint(camera, profileCenter, Math.max(face.width, face.height) * 0.6, new THREE.Vector3(1, 0.05, 0));
  renderer.render(scene, camera);
  log("Rendu 'profil' (pour repérer un décalage de hauteur de l'aiguille) affiché.");
  await stages.enter("PROFILE");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
