/**
 * Rendu visuel minimal de la boussole, même principe que les autres tests de rendu : la vraie
 * détection (`findModelFace` sur l'axe (0,1,0), comme `UP_AXES` dans `interactions.ts` — un seul
 * candidat, contrairement à `FRONT_AXES` ailleurs dans le fichier, donc pas d'ambiguïté haut/bas
 * à reproduire ici) et la vraie classe `FaceCanvas`, avec le même dessin d'aiguille que la
 * factory `compass` (dupliqué ici car `compass`/`dial`/`UP_AXES` ne sont pas exportés), sans
 * InteractionSystem/monde/joueur.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/compass-render.html.
 * Ou en headless : `node scripts/test-compass-render.mjs`.
 */
import * as THREE from "three";
import compassUrl from "../../src/assets/models/collectibles/compass.glb";
import { FaceCanvas } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";

const results: string[] = [];
const log = (line: string): void => {
  results.push(line);
  console.log(line);
  const el = document.getElementById("results");
  if (el) el.textContent = results.join("\n");
};

let resolveNext: (() => void) | null = null;
function waitForNext(): Promise<void> {
  return new Promise((resolve) => {
    resolveNext = resolve;
  });
}
(window as unknown as { __next__: () => void }).__next__ = () => {
  resolveNext?.();
  resolveNext = null;
};
function setStage(name: string): void {
  (window as unknown as Record<string, string>)["__STAGE__"] = name;
}

function frameCameraOnPoint(camera: THREE.PerspectiveCamera, center: THREE.Vector3, radius: number, direction: THREE.Vector3): void {
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360) + radius;
  camera.position.copy(center).addScaledVector(direction, distance * 1.4);
  camera.lookAt(center);
}

// Reproduit exactement le dessin de `compass` dans interactions.ts (voir cette factory) pour un
// angle donné, sans dépendre de la logique de sortie/monde (juste un angle de test fixe).
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
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x333333);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.2);
  fill.position.set(-1, 2, -1);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.01, 20);

  const template = await loadTemplateModel(compassUrl);
  scene.add(template);

  const face = findModelFace(template, new THREE.Vector3(0, 1, 0));
  log(face ? `Face détectée : centre (${face.center.x.toFixed(3)}, ${face.center.y.toFixed(3)}, ${face.center.z.toFixed(3)}), ${face.width.toFixed(3)}×${face.height.toFixed(3)} m` : "Aucune face détectée sur l'axe haut/bas.");
  if (!face) {
    renderer.render(scene, camera);
    setStage("OFF");
    await waitForNext();
    setStage("ON");
    await waitForNext();
    setStage("PROFILE");
    return;
  }
  // Cadré sur le cadran lui-même (pas la bbox globale, faussée par la boucle d'attache au-dessus).
  frameCameraOnPoint(camera, face.center, Math.max(face.width, face.height) * 0.6, new THREE.Vector3(0.35, 1, 0.35));

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériau d'origine) affiché.");
  setStage("OFF");
  await waitForNext();

  const dialCanvas = new FaceCanvas(template, face, 128, 128, { shrink: 0.7, glow: true, transparent: true, raise: -0.08 });
  drawNeedle(dialCanvas.ctx, 0.4);
  dialCanvas.commit();
  dialCanvas.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'aiguille dessinée' (angle de test fixe) affiché.");
  setStage("ON");
  await waitForNext();

  // Vue de profil : révèle un décalage de hauteur (raise) entre le plan de l'aiguille et le
  // verre du cadran, invisible depuis le dessus.
  frameCameraOnPoint(camera, face.center, Math.max(face.width, face.height) * 0.6, new THREE.Vector3(1, 0.05, 0));
  renderer.render(scene, camera);
  log("Rendu 'profil' (pour repérer un décalage de hauteur de l'aiguille) affiché.");
  setStage("PROFILE");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  setStage("ERROR");
});
