import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { ComfortVignette } from "./player/comfortVignette";
import { Locomotion } from "./player/locomotion";
import { buildStaticChunk, ROOM_HALF_EXTENT } from "./world/chunk";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app introuvable dans index.html");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05050a);
scene.fog = new THREE.FogExp2(0x05050a, 0.035);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 60);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
appRoot.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const playerRig = new THREE.Group();
playerRig.name = "player-rig";
playerRig.position.set(0, 0, 6);
playerRig.add(camera);
scene.add(playerRig);

scene.add(new THREE.HemisphereLight(0xfff3cf, 0x171512, 0.9));
scene.add(new THREE.AmbientLight(0xfff0c0, 0.25));
scene.add(buildStaticChunk());

const locomotion = new Locomotion(renderer, camera, playerRig);
const comfortVignette = new ComfortVignette(camera);

const vignetteToggle = document.querySelector<HTMLInputElement>("#vignette-toggle");
vignetteToggle?.addEventListener("change", () => {
  comfortVignette.enabled = vignetteToggle.checked;
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/** Limite de déplacement provisoire en attendant la vraie collision par grille (étape 2). */
function clampPlayerToRoom(): void {
  playerRig.position.x = THREE.MathUtils.clamp(playerRig.position.x, -ROOM_HALF_EXTENT, ROOM_HALF_EXTENT);
  playerRig.position.z = THREE.MathUtils.clamp(playerRig.position.z, -ROOM_HALF_EXTENT, ROOM_HALF_EXTENT);
}

const timer = new THREE.Timer();

renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  const movementIntensity = locomotion.update(deltaSeconds);
  clampPlayerToRoom();
  comfortVignette.update(movementIntensity, deltaSeconds);
  renderer.render(scene, camera);
});
