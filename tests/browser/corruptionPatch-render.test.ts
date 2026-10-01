/**
 * Aperçu interactif de la corruption VHS : sol jaunâtre, caméra qui regarde la tache ; un clic
 * relance le cycle (annonce, croissance, maintien, résorption). Ouvrir
 * /tests/browser/corruptionPatch-render.html avec le serveur de dev.
 */
import * as THREE from "three";
import { CorruptionPatch } from "../../src/world/corruptionPatch";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const out = document.getElementById("results")!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1810);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.6, 0);
camera.lookAt(0, 0, -1.6);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6b6340 }));
scene.add(floor);

const patch = new CorruptionPatch(scene, new THREE.AudioListener());
const player = new THREE.Vector3(0, 0, 0);
camera.updateMatrixWorld(true);
patch.toggle(player, camera);
// Vue d'ensemble (la tache est posée devant le joueur, à l'origine, regardant vers -z).
camera.position.set(0, 4.2, 3.2);
camera.lookAt(0, 0, -1.1);

addEventListener("click", () => {
  if (patch.active) patch.toggle(player, camera);
  patch.toggle(player, camera);
});

(window as unknown as Record<string, unknown>)["__patch"] = patch;
const clock = new THREE.Clock();
let elapsed = 0;
function frame(dt: number): void {
  elapsed += dt;
  const events = patch.update(dt, player, camera, 1, elapsed);
  out.textContent = `t=${elapsed.toFixed(1)} Corruption VHS — sur la tache : ${events.onPatch ? "OUI" : "non"} (clic = relancer)`;
  renderer.render(scene, camera);
}
/** Avance la simulation de `seconds` (pas de 1/30 s) : pour les captures, quand le navigateur bride requestAnimationFrame. */
(window as unknown as Record<string, unknown>)["__step"] = (seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 30) frame(1 / 30);
};
renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 1)));
