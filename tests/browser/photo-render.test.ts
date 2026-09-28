/**
 * Rendu visuel minimal du cadre photo, même principe que television-render.test.ts : la vraie
 * détection (`findMeshByName(/artwork/i)`/`/back/i`, fallback `findModelFace` auto) et la vraie
 * classe `FaceCanvas`, sans InteractionSystem/monde/joueur/WebGLRenderer factice.
 *
 * Socle commun (renderer, scène, cadrage, contrôleur d'étapes) dans support/harness.ts.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/photo-render.html.
 * Ou en headless : `node scripts/render-test.mjs photo-render`.
 */
import * as THREE from "three";
import photoUrl from "../../src/assets/models/collectibles/photo.glb";
import { FaceCanvas, canvasSizeForAspect, findMeshByName, meshPlateAspect } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";
import { createLogger, createRenderer, createScene, createStageController, drawCheckerboard, frameOnPoint } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["OFF", "ON", "BACK", "BACK_ANGLE"]);
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

  const front = findModelFace(template);
  const artwork = findMeshByName(template, /artwork/i);
  log(artwork ? `Sous-maille artwork détectée : "${artwork.name || "(sans nom)"}" → remplacement en place (derrière la vitre).` : "Pas de sous-maille artwork → pose d'un plan sur la face avant détectée (fallback, risque de déborder sur le cadre).");

  if (!artwork && !front) {
    log("ÉCHEC : aucune surface détectée pour poser la photo.");
    await stages.enter("ON");
    await stages.enter("BACK");
    await stages.enter("BACK_ANGLE");
    return;
  }
  const [fw, fh] = canvasSizeForAspect(artwork ? meshPlateAspect(artwork) : front!.width / front!.height);
  log(`Ratio retenu pour l'avant : ${fw}×${fh}px (au lieu d'un carré 192×192).`);
  const frontCanvas = artwork ? new FaceCanvas(template, null, fw, fh, { existingMesh: artwork }) : new FaceCanvas(template, front!, fw, fh, { shrink: 0.82 });

  drawCheckerboard(frontCanvas.ctx, fw, fh);
  frontCanvas.commit();
  frontCanvas.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'photo posée' (damier de test à la place de la vraie image) affiché.");
  await stages.enter("ON");

  // --- Dos du cadre : message manuscrit en alpha, sans fond peint, sur le vrai bois du cadre ---
  if (!front) {
    await stages.enter("BACK");
    await stages.enter("BACK_ANGLE");
    return;
  }
  const back = findModelFace(template, front.normal.clone().negate());
  const backMesh = findMeshByName(template, /back/i);
  if (!backMesh && !back) {
    log("Pas de face arrière détectée.");
    await stages.enter("BACK");
    await stages.enter("BACK_ANGLE");
    return;
  }
  log(backMesh ? `Sous-maille dos détectée : "${backMesh.name || "(sans nom)"}" → remplacement en place.` : "Pas de sous-maille dos dédiée → pose d'un plan sur la face arrière détectée (fallback).");
  const boxCenter = new THREE.Box3().setFromObject(template).getCenter(new THREE.Vector3());
  const boxRadius = new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3()).length() * 0.35;
  frameOnPoint(camera, boxCenter, boxRadius, FRONT_DIR.clone().negate());

  const backAspect = backMesh ? meshPlateAspect(backMesh) : back!.width / back!.height;
  const [bw, bh] = canvasSizeForAspect(backAspect);
  log(`Ratio retenu pour le dos : ${bw}×${bh}px.`);
  const backCanvas = backMesh ? new FaceCanvas(template, null, bw, bh, { existingMesh: backMesh, transparent: true }) : new FaceCanvas(template, back!, bw, bh, { shrink: 0.9, transparent: true });
  const ctx = backCanvas.ctx;
  // Composé sur un cadre virtuel 192×192 (mise en page d'origine), mis à l'échelle non uniforme
  // vers les dimensions réelles du dos — voir le commentaire équivalent dans `photo` (interactions.ts).
  ctx.save();
  ctx.scale(bw / 192, bh / 192);
  ctx.strokeStyle = "rgba(120, 92, 55, 0.28)";
  ctx.lineWidth = 2;
  for (let y = 18; y < 192; y += 18) {
    ctx.beginPath();
    ctx.moveTo(10, y);
    ctx.lineTo(182, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#1c2753";
  ctx.font = "20px sans-serif";
  ctx.fillText("test alpha", 14, 40);
  ctx.restore();
  backCanvas.commit();
  backCanvas.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'dos annoté' (texte en alpha, sans fond — le bois du cadre doit rester visible) affiché.");
  await stages.enter("BACK");

  // Vue de 3/4 (pas de face) : un plan simplement collé devant la surface se détache visiblement
  // par parallaxe (bord flottant, décalage de profondeur) alors qu'une vraie sous-maille suit le
  // modèle sous tous les angles.
  const angled = FRONT_DIR.clone().negate().addScaledVector(new THREE.Vector3(0, 0.25, 1), 0.35).normalize();
  frameOnPoint(camera, boxCenter, boxRadius, angled);
  renderer.render(scene, camera);
  log("Rendu 'dos, vue de 3/4' (pour repérer un décalage de profondeur/bord flottant) affiché.");
  await stages.enter("BACK_ANGLE");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
