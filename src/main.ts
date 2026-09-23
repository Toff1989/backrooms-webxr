import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { AmbientHum } from "./assets/audio/ambientHum";
import { triggerHapticPulse } from "./player/haptics";
import { CamcorderHud } from "./player/camcorderHud";
import { ComfortVignette } from "./player/comfortVignette";
import { ControllerRig } from "./player/controllerRig";
import { EndRunScreen } from "./player/endRunScreen";
import { GrabInteraction } from "./player/grabInteraction";
import { Locomotion } from "./player/locomotion";
import { StopRecControl } from "./player/stopRecControl";
import { VhsOverlay } from "./player/vhsOverlay";
import { WristMenu } from "./player/wristMenu";
import type { WallSegment } from "./shared/chunkLayout";
import { CollectionStore, toCollectionEntry } from "./world/collection";
import { PLAYER_RADIUS, resolveWallCollisions } from "./world/collision";
import { corruption } from "./world/corruption";
import { LevelManager, SPAWN_LOCAL_POSITION } from "./world/levelManager";
import { endRun, reportLevel, startRun, type RunSessionInfo } from "./world/runSession";
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

/**
 * Étape 7 : la vraie seed de run vient du serveur (`POST /run/start`), mais le premier
 * rendu ne doit jamais attendre l'aller-retour réseau — on démarre sur une seed locale
 * temporaire, remplacée dès que le serveur répond (voir `LevelManager.restartRun`). Si
 * le serveur est injoignable, le jeu reste jouable indéfiniment sur cette seed locale
 * (aucune fonctionnalité de jeu ne dépend du classement).
 */
const LOCAL_FALLBACK_SEED = "local-offline";
const levelManager = new LevelManager(scene, audioListener, LOCAL_FALLBACK_SEED);

let currentSession: RunSessionInfo | null = null;

const locomotion = new Locomotion(renderer, camera, playerRig);
const comfortVignette = new ComfortVignette(camera);
const vhsOverlay = new VhsOverlay(camera);
const camcorderHud = new CamcorderHud(camera);
const ambientHum = new AmbientHum(audioListener);

const controllerRig = new ControllerRig(renderer, playerRig);
const collectionStore = new CollectionStore();
const wristMenu = new WristMenu(renderer, controllerRig, collectionStore);
const GRAB_RADIUS = 0.4;
// Ramassage confirmé seulement si l'objet est relâché près du corps (le "sac par-dessus
// l'épaule" de la fiche) ; relâché plus loin, il tombe simplement (physique légère).
const COLLECT_CONFIRM_RADIUS = 0.5;
const releasePosition = new THREE.Vector3();
new GrabInteraction(renderer, controllerRig, {
  onGrabAttempt: (controller, worldPosition) => {
    const instance = levelManager.tryHoldCollectible(worldPosition, GRAB_RADIUS);
    if (instance) instance.beginHold(controller);
    return instance;
  },
  onRelease: (_controller, instance) => {
    releasePosition.copy(instance.endHold(scene));
    const dx = releasePosition.x - playerRig.position.x;
    const dz = releasePosition.z - playerRig.position.z;
    if (Math.hypot(dx, dz) < COLLECT_CONFIRM_RADIUS) {
      collectionStore.add(toCollectionEntry(instance.placement, levelManager.depth));
      wristMenu.notifyCollectionChanged();
      instance.beginCollect();
    } else {
      instance.dropWithPhysics();
      levelManager.adoptDroppedCollectible(instance);
    }
  },
});

const endRunScreen = new EndRunScreen(
  renderer,
  camera,
  (pseudo) => {
    if (!currentSession) return Promise.reject(new Error("Pas de session de run active"));
    return endRun(currentSession, pseudo);
  },
  () => {
    stopRecControl.enabled = true;
    beginNewRun();
  },
);

const stopRecControl = new StopRecControl(renderer, () => {
  stopRecControl.enabled = false;
  endRunScreen.show(levelManager.depth);
});

/** Démarre une run côté serveur (seed + token) ; jouable en local si le serveur est injoignable (voir `runSession.ts`). */
function beginNewRun(): void {
  startRun()
    .then((session) => {
      currentSession = session;
      const spawnPosition = levelManager.restartRun(session.seed);
      playerRig.position.copy(spawnPosition);
      camcorderHud.depth = levelManager.depth;
    })
    .catch(() => {
      currentSession = null;
    });
}

beginNewRun();

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
    if (currentSession) reportLevel(currentSession, levelManager.depth);
  }
  corruption.update(deltaSeconds);

  comfortVignette.update(movementIntensity, deltaSeconds);
  vhsOverlay.update(elapsedSeconds, corruption.value);
  camcorderHud.update(deltaSeconds);
  wristMenu.update(!endRunScreen.isVisible);
  stopRecControl.update(deltaSeconds);
  endRunScreen.update();
  updateVhsTime(elapsedSeconds);
  renderer.render(scene, camera);
});
