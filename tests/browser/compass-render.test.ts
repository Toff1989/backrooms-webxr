/**
 * Rendu visuel minimal de la boussole : le modèle n'a pas de sous-maille de cadran dédiée, donc
 * son comportement crée son aiguille directement sur la face supérieure.
 *
 * Socle commun (renderer, scène, cadrage, contrôleur d'étapes) dans support/harness.ts.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/compass-render.html.
 * Ou en headless : `node scripts/render-test.mjs compass-render`.
 */
import * as THREE from "three";
import compassUrl from "../../src/assets/models/collectibles/compass.glb";
import { findMeshByName } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";
import { createLogger, createRenderer, createScene, createStageController, frameOnPoint } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["OFF", "ON", "PROFILE"]);

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

  const texture = new THREE.CanvasTexture(document.createElement("canvas"));
  texture.image.width = texture.image.height = 128;
  const ctx = texture.image.getContext("2d")!;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true });
  const needle = new THREE.Mesh(new THREE.PlaneGeometry(face.width * 0.7, face.height * 0.7), material);
  const right = new THREE.Vector3().crossVectors(face.up, face.normal).normalize();
  needle.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, face.up, face.normal));
  needle.position.copy(face.center);
  const centerMesh = findMeshByName(template, /dial_center/i);
  if (centerMesh) {
    centerMesh.geometry.computeBoundingBox();
    needle.position.copy(centerMesh.geometry.boundingBox!.getCenter(new THREE.Vector3()));
  }
  drawNeedle(ctx, 0.4);
  texture.needsUpdate = true;
  template.add(needle);

  renderer.render(scene, camera);
  log("Rendu 'aiguille dessinée' (angle de test fixe) affiché.");
  await stages.enter("ON");

  frameOnPoint(camera, needle.position, Math.max(face.width, face.height) * 0.6, new THREE.Vector3(1, 0.05, 0));
  renderer.render(scene, camera);
  log("Rendu 'profil' (pour repérer le décalage de hauteur de l'aiguille) affiché.");
  await stages.enter("PROFILE");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
