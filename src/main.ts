import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { ComfortVignette } from "./player/comfortVignette";
import { Locomotion } from "./player/locomotion";
import type { WallSegment } from "./shared/chunkLayout";
import { CELL_SIZE } from "./shared/constants";
import { DEFAULT_PROFILE } from "./shared/levelProfile";
import { PLAYER_RADIUS, resolveWallCollisions } from "./world/collision";
import { ChunkStreamer } from "./world/chunkStreamer";

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
playerRig.position.set(CELL_SIZE / 2, 0, CELL_SIZE / 2);
playerRig.add(camera);
scene.add(playerRig);

scene.add(new THREE.HemisphereLight(0xfff3cf, 0x171512, 0.9));
scene.add(new THREE.AmbientLight(0xfff0c0, 0.25));

const chunkStreamer = new ChunkStreamer(scene, DEFAULT_PROFILE);
chunkStreamer.update(playerRig.position);

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

const nearbyWallSegments: WallSegment[] = [];
const timer = new THREE.Timer();

renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  const movementIntensity = locomotion.update(deltaSeconds);
  chunkStreamer.update(playerRig.position);
  chunkStreamer.collectNearbyWallSegments(playerRig.position, nearbyWallSegments);
  resolveWallCollisions(playerRig.position, PLAYER_RADIUS, nearbyWallSegments);
  comfortVignette.update(movementIntensity, deltaSeconds);
  renderer.render(scene, camera);
});
