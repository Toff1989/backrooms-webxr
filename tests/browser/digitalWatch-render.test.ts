/**
 * Rendu visuel minimal de la montre digitale, même principe que television-render.test.ts : la
 * vraie détection (`findMeshByName(/glass/i)`, la vitre du cadran étant une vraie sous-maille
 * séparée du modèle), le vrai recadrage d'UV (`remapPlateUVToFace`) et l'application directe du
 * canvas sur cette sous-maille, avec le même dessin d'écran que la
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
import { createMeshCanvas, findMeshByName, remapPlateUVToFace } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
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
  log(glass ? `Sous-maille vitre détectée : "${glass.name || "(sans nom)"}" → écran posé en place (dessus le vrai cadran).` : "Pas de sous-maille vitre : aucun écran de repli n'est créé.");
  if (!glass) {
    renderer.render(scene, camera);
    await stages.enter("OFF");
    await stages.enter("ON");
    await stages.enter("PROFILE");
    return;
  }

  if (glass) {
    // La vitre partage son unwrap entre sa face plate et ses chants biseautés (même modèle
    // partagé, cf. dial()) : on ne recadre le dessin que sur le sous-rectangle de la face plate,
    // en miroir vertical (comme dans dial()) pour corriger le montage inversé de cette vitre.
    remapPlateUVToFace(glass, UP_AXES[0]!, 0.9, { v: true });
    glass.geometry.computeBoundingBox();
  }
  const box = new THREE.Box3().setFromObject(template);
  const focusCenter = glass.geometry.boundingBox!.getCenter(new THREE.Vector3());
  const focusRadius = box.getSize(new THREE.Vector3()).length() * 0.12;
  frameOnPoint(camera, focusCenter, focusRadius, new THREE.Vector3(0.35, 1, 0.35));

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériau d'origine, vitre translucide) affiché.");
  await stages.enter("OFF");

  const screenCanvas = createMeshCanvas(glass, 128, 128, { glow: true, transparent: false });
  drawClock(screenCanvas.ctx, 754);
  screenCanvas.commit();
  screenCanvas.activate();

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
