/**
 * Rendu visuel minimal du cadre photo, même principe que television-render.test.ts : la vraie
 * détection (`findMeshByName(/artwork/i)`, fallback `findModelFace` auto) et la vraie classe
 * `FaceCanvas`, sans InteractionSystem/monde/joueur, sans WebGLRenderer factice.
 *
 * Chaque étape peint son rendu puis BLOQUE (`waitForNext`) jusqu'à ce que le runner Playwright
 * appelle `window.__next__()` après avoir pris sa capture — sans handshake explicite, un délai
 * approximatif (rAF ×2) peut laisser le script avancer d'une étape avant que Playwright ait fini
 * de lire le canvas, et la capture "ON" se retrouve à contenir le rendu "BACK" (constaté en
 * pratique : les captures étaient décalées d'un cran).
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/photo-render.html (bouton "suivant" au clavier :
 * exécuter `__next__()` dans la console). Ou en headless : `node scripts/test-photo-render.mjs`.
 */
import * as THREE from "three";
import photoUrl from "../../src/assets/models/collectibles/photo.glb";
import { FaceCanvas, canvasSizeForAspect, findMeshByName, meshPlateAspect, remapPlateUV } from "../../src/world/interactions";
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

function frameCamera(camera: THREE.PerspectiveCamera, object: THREE.Object3D, direction = new THREE.Vector3(1, 0, 0)): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z) / (2 * Math.tan((camera.fov * Math.PI) / 360)) + size.length();
  camera.position.copy(center).addScaledVector(direction, distance * 1.1);
  camera.lookAt(center);
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
  // Direction physique connue de l'avant du modèle (indépendante de `findModelFace(template)` sans
  // axe imposé, qui compare l'aire des 6 faces candidates : avec le dos maintenant séparé en une
  // vraie plaque, son aire peut dépasser celle de la façade et faire "gagner" le mauvais côté).
  const FRONT_DIR = new THREE.Vector3(1, 0, 0);
  frameCamera(camera, template, FRONT_DIR);

  renderer.render(scene, camera);
  log("Rendu 'vierge' (matériaux d'origine, cadre + vitre + artwork) affiché.");
  setStage("OFF");
  await waitForNext();

  const front = findModelFace(template);
  const artwork = findMeshByName(template, /artwork/i);
  log(artwork ? `Sous-maille artwork détectée : "${artwork.name || "(sans nom)"}" → remplacement en place (derrière la vitre).` : "Pas de sous-maille artwork → pose d'un plan sur la face avant détectée (fallback, risque de déborder sur le cadre).");

  if (!artwork && !front) {
    log("ÉCHEC : aucune surface détectée pour poser la photo.");
    setStage("ON");
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
  setStage("ON");
  await waitForNext();

  // --- Dos du cadre : message manuscrit en alpha, sans fond peint, sur le vrai bois du cadre ---
  if (!front) {
    setStage("BACK");
    await waitForNext();
    setStage("BACK_ANGLE");
    return;
  }
  const back = findModelFace(template, front.normal.clone().negate());
  const backMesh = findMeshByName(template, /back/i);
  if (!backMesh && !back) {
    log("Pas de face arrière détectée.");
    setStage("BACK");
    await waitForNext();
    setStage("BACK_ANGLE");
    return;
  }
  log(backMesh ? `Sous-maille dos détectée : "${backMesh.name || "(sans nom)"}" → remplacement en place.` : "Pas de sous-maille dos dédiée → pose d'un plan sur la face arrière détectée (fallback).");
  frameCamera(camera, template, FRONT_DIR.clone().negate());
  if (backMesh) remapPlateUV(backMesh);

  const backAspect = backMesh ? meshPlateAspect(backMesh) : back!.width / back!.height;
  const [bw, bh] = canvasSizeForAspect(backAspect);
  log(`Ratio retenu pour le dos : ${bw}×${bh}px.`);
  const backCanvas = backMesh ? new FaceCanvas(template, null, bw, bh, { existingMesh: backMesh, transparent: true }) : new FaceCanvas(template, back!, bw, bh, { shrink: 0.9, transparent: true });
  const ctx = backCanvas.ctx;
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
  setStage("BACK");
  await waitForNext();

  // Vue de 3/4 (pas de face) : un plan simplement collé devant la surface se détache visiblement
  // par parallaxe (bord flottant, décalage de profondeur) alors qu'une vraie sous-maille suit le
  // modèle sous tous les angles.
  const backNormal = FRONT_DIR.clone().negate();
  const angled = backNormal.clone().addScaledVector(new THREE.Vector3(0, 0.25, 1), 0.35).normalize();
  frameCamera(camera, template, angled);
  renderer.render(scene, camera);
  log("Rendu 'dos, vue de 3/4' (pour repérer un décalage de profondeur/bord flottant) affiché.");
  setStage("BACK_ANGLE");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  setStage("ERROR");
});
