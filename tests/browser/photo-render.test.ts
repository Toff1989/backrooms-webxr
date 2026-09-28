/**
 * Rendu visuel minimal du cadre photo, même principe que television-render.test.ts : la vraie
 * détection (`findMeshByName(/artwork/i)`, fallback `findModelFace` auto) et la vraie classe
 * `FaceCanvas`, sans InteractionSystem/monde/joueur, sans WebGLRenderer factice.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/photo-render.html.
 * Ou en headless : `node scripts/test-photo-render.mjs`.
 */
import * as THREE from "three";
import photoUrl from "../../src/assets/models/collectibles/photo.glb";
import { FaceCanvas, findMeshByName } from "../../src/world/interactions";
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
  const distance = Math.max(size.x, size.y) / (2 * Math.tan((camera.fov * Math.PI) / 360)) + size.z * 3;
  camera.position.set(center.x + distance * 1.1, center.y, center.z);
  camera.lookAt(center);
}

function markReady(name: string): void {
  (window as unknown as Record<string, boolean>)[`__${name}_READY__`] = true;
}

// Damier bien contrasté : révèle immédiatement un étirement ou un décalage de cadrage, contrairement
// à une texture "trouvée" réaliste où une déformation légère passerait inaperçue à l'œil.
function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const cell = 16;
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      ctx.fillStyle = (x / cell + y / cell) % 2 === 0 ? "#e0463c" : "#ffe08a";
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
}

async function run(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2, 2, 1);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.05, 20);

  const template = await loadTemplateModel(photoUrl);
  scene.add(template);
  frameCamera(camera, template);

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériaux d'origine, cadre + vitre + artwork) affiché.");
  markReady("OFF");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const front = findModelFace(template);
  const artwork = findMeshByName(template, /artwork/i);
  log(artwork ? `Sous-maille artwork détectée : "${artwork.name || "(sans nom)"}" → remplacement en place (derrière la vitre).` : "Pas de sous-maille artwork → pose d'un plan sur la face avant détectée (fallback, risque de déborder sur le cadre).");

  const frontCanvas = artwork ? new FaceCanvas(template, null, 192, 192, { existingMesh: artwork }) : front ? new FaceCanvas(template, front, 192, 192, { shrink: 0.82 }) : null;

  if (!frontCanvas) {
    log("ÉCHEC : aucune surface détectée pour poser la photo.");
    markReady("ON");
    return;
  }

  drawCheckerboard(frontCanvas.ctx, 192, 192);
  frontCanvas.commit();
  frontCanvas.visible = true;

  renderer.render(scene, camera);
  log("Rendu 'photo posée' (damier de test à la place de la vraie image) affiché.");
  markReady("ON");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  markReady("OFF");
  markReady("ON");
});
