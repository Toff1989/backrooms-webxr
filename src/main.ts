import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { AmbientHum } from "./assets/audio/ambientHum";
import { triggerHapticPulse } from "./player/haptics";
import { CamcorderHud } from "./player/camcorderHud";
import { ComfortVignette } from "./player/comfortVignette";
import { Locomotion } from "./player/locomotion";
import { VhsOverlay } from "./player/vhsOverlay";
import type { WallSegment } from "./shared/chunkLayout";
import { PLAYER_RADIUS, resolveWallCollisions } from "./world/collision";
import { corruption } from "./world/corruption";
import { LevelManager, SPAWN_LOCAL_POSITION } from "./world/levelManager";
import { updateVhsTime } from "./world/vhsMaterial";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app introuvable dans index.html");

// Teinte proche du noir, légèrement chaude (cohérente avec la teinte jaunâtre délavée du look VHS).
const BACKGROUND_COLOR = 0x0a0805;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND_COLOR);
scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.035);

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
playerRig.position.copy(SPAWN_LOCAL_POSITION);
playerRig.add(camera);
scene.add(playerRig);

scene.add(new THREE.HemisphereLight(0xfff3cf, 0x171512, 0.9));
scene.add(new THREE.AmbientLight(0xfff0c0, 0.25));

const audioListener = new THREE.AudioListener();
camera.add(audioListener);

const levelManager = new LevelManager(scene, audioListener);

const locomotion = new Locomotion(renderer, camera, playerRig);
const comfortVignette = new ComfortVignette(camera);
const vhsOverlay = new VhsOverlay(camera);
const camcorderHud = new CamcorderHud(camera);
const ambientHum = new AmbientHum(audioListener);

renderer.xr.addEventListener("sessionstart", () => {
  ambientHum.start();
  levelManager.onSessionStart();
});

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

const GLITCH_HAPTIC_INTENSITY = 0.6;
const GLITCH_HAPTIC_DURATION_MS = 120;
const WALL_TRAP_WARNING_HAPTIC_INTENSITY = 0.35;
const WALL_TRAP_WARNING_HAPTIC_DURATION_MS = 90;
const WALL_TRAP_POP_HAPTIC_INTENSITY = 1;
const WALL_TRAP_POP_HAPTIC_DURATION_MS = 180;

renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  const elapsedSeconds = timer.getElapsed();

  const movementIntensity = locomotion.update(deltaSeconds);
  const levelUpdate = levelManager.update(playerRig.position, camera, elapsedSeconds, deltaSeconds);
  levelManager.collectNearbyWallSegments(playerRig.position, nearbyWallSegments);
  resolveWallCollisions(playerRig.position, PLAYER_RADIUS, nearbyWallSegments);

  if (levelUpdate.corruptionDelta > 0) corruption.add(levelUpdate.corruptionDelta);
  if (levelUpdate.glitchTrapJustTriggered) triggerHapticPulse(renderer, GLITCH_HAPTIC_INTENSITY, GLITCH_HAPTIC_DURATION_MS);
  if (levelUpdate.wallTrapJustWarned) triggerHapticPulse(renderer, WALL_TRAP_WARNING_HAPTIC_INTENSITY, WALL_TRAP_WARNING_HAPTIC_DURATION_MS);
  if (levelUpdate.wallTrapJustPopped) triggerHapticPulse(renderer, WALL_TRAP_POP_HAPTIC_INTENSITY, WALL_TRAP_POP_HAPTIC_DURATION_MS);

  if (levelManager.hasReachedExit(playerRig.position)) {
    const spawnPosition = levelManager.descend();
    playerRig.position.copy(spawnPosition);
    camcorderHud.depth = levelManager.depth;
    corruption.add(1);
  }
  corruption.update(deltaSeconds);

  comfortVignette.update(movementIntensity, deltaSeconds);
  vhsOverlay.update(elapsedSeconds, corruption.value);
  camcorderHud.update(deltaSeconds);
  updateVhsTime(elapsedSeconds);
  renderer.render(scene, camera);
});
