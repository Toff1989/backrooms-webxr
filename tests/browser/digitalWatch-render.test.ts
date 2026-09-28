/**
 * Rendu visuel minimal de la montre digitale, même principe que television-render.test.ts : la
 * vraie détection (`findMeshByName(/glass/i)`, la vitre du cadran étant une vraie sous-maille
 * séparée du modèle, fallback `findModelFace(UP_AXES)` sinon), le vrai recadrage d'UV
 * (`remapPlateUVToFace`) et la vraie classe `FaceCanvas`, avec le même dessin d'écran que la
 * factory `digitalWatch` (dupliqué ici car `digitalWatch`/`dial`/`UP_AXES` ne sont pas exportés).
 * Contrairement au compass, ce modèle n'a pas de repère "centre" dédié — la vitre-écran est posée
 * directement sur le modèle, comme l'écran de la télé.
 *
 * Socle commun (renderer, scène, cadrage, contrôleur d'étapes) dans support/harness.ts.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/digitalWatch-render.html.
 * Ou en headless : `node scripts/render-test.mjs digitalWatch-render`.
 */
import * as THREE from "three";
import digitalWatchUrl from "../../src/assets/models/collectibles/digitalWatch.glb";
import { FaceCanvas, findMeshByName, remapPlateUVToFace } from "../../src/world/interactions";
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

  const glass = findMeshByName(template, /glass/i);
  const face = glass ? null : findModelFace(template, undefined, UP_AXES);
  log(glass ? `Sous-maille vitre détectée : "${glass.name || "(sans nom)"}" → écran posé en place (dessus le vrai cadran).` : face ? "Pas de sous-maille vitre → pose d'un plan sur la face auto-détectée (fallback)." : "Aucune surface détectée.");
  if (!glass && !face) {
    renderer.render(scene, camera);
    await stages.enter("OFF");
    await stages.enter("ON");
    await stages.enter("PROFILE");
    return;
  }

  if (glass) {
    // La vitre partage son unwrap entre sa face plate et ses chants biseautés (même modèle
    // partagé, cf. dial()) : on ne recadre le dessin que sur le sous-rectangle de la face plate.
    remapPlateUVToFace(glass, UP_AXES[0]!);
    glass.geometry.computeBoundingBox();
  }
  const box = new THREE.Box3().setFromObject(template);
  const focusCenter = glass ? glass.geometry.boundingBox!.getCenter(new THREE.Vector3()) : face!.center;
  const focusRadius = glass ? box.getSize(new THREE.Vector3()).length() * 0.12 : Math.max(face!.width, face!.height) * 0.6;
  frameOnPoint(camera, focusCenter, focusRadius, new THREE.Vector3(0.35, 1, 0.35));

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériau d'origine, vitre translucide) affiché.");
  await stages.enter("OFF");

  const screenCanvas = glass ? new FaceCanvas(template, null, 128, 128, { existingMesh: glass, glow: true, transparent: false }) : new FaceCanvas(template, face!, 128, 128, { shrink: 0.7, glow: true, transparent: true, raise: 0.08 });
  drawClock(screenCanvas.ctx, 754);
  screenCanvas.commit();
  screenCanvas.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'écran allumé' (heure de test fixe) affiché.");
  await stages.enter("ON");

  // Vue de profil : révèle un décalage de hauteur entre le plan de l'écran et le boîtier,
  // invisible depuis le dessus (même vérification que pour le compass) — sans objet, sur une
  // vraie sous-maille collée au modèle il ne devrait plus y en avoir.
  frameOnPoint(camera, focusCenter, focusRadius, new THREE.Vector3(1, 0.05, 0));
  renderer.render(scene, camera);
  log("Rendu 'profil' (pour repérer un décalage de hauteur de l'écran) affiché.");
  await stages.enter("PROFILE");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
