import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { AmbientHum } from "./assets/audio/ambientHum";
import { PhysicsWorld } from "./physics/physicsWorld";
import { CamcorderHud } from "./player/camcorderHud";
import { ComfortVignette } from "./player/comfortVignette";
import { EndRunScreen } from "./player/endRunScreen";
import { Flashlight } from "./player/flashlight";
import { GrabSystem } from "./player/grabSystem";
import { Hand } from "./player/hand";
import { triggerHapticPulse } from "./player/haptics";
import { InventoryMenu } from "./player/inventoryMenu";
import { PlayerController } from "./player/playerController";
import { Sfx } from "./player/sfx";
import { VhsOverlay } from "./player/vhsOverlay";
import { XrInput } from "./player/xrInput";
import { UiPointer } from "./ui/uiPointer";
import { Atmosphere } from "./world/atmosphere";
import { CollectionStore } from "./world/collection";
import { corruption } from "./world/corruption";
import { GrabbableRegistry } from "./world/grabbable";
import { LevelManager, SPAWN_LOCAL_POSITION } from "./world/levelManager";
import { endRun, reportLevel, startRun, type RunSessionInfo } from "./world/runSession";
import { updateVhsTime } from "./world/vhsMaterial";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app introuvable dans index.html");

// Teinte proche du noir, légèrement chaude (cohérente avec la teinte jaunâtre délavée du look VHS).
const BACKGROUND_COLOR = 0x0a0805;

const physics = await PhysicsWorld.create();

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND_COLOR);
scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.035);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 60);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
appRoot.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const player = new PlayerController(renderer, camera, physics);
scene.add(player.rig);

const hemisphere = new THREE.HemisphereLight(0xfff3cf, 0x171512, 0.9);
const ambient = new THREE.AmbientLight(0xfff0c0, 0.25);
scene.add(hemisphere, ambient);

const audioListener = new THREE.AudioListener();
camera.add(audioListener);

const collectionStore = new CollectionStore();
const grabbables = new GrabbableRegistry(scene, physics);

/**
 * Étape 7 : la vraie seed de run vient du serveur (`POST /run/start`), mais le premier
 * rendu ne doit jamais attendre l'aller-retour réseau — on démarre sur une seed locale
 * temporaire, remplacée dès que le serveur répond (voir `LevelManager.restartRun`). Si
 * le serveur est injoignable, le jeu reste jouable sur une seed locale.
 */
const LOCAL_FALLBACK_SEED = "local-offline";
const levelManager = new LevelManager(scene, audioListener, physics, grabbables, (id) => collectionStore.has(id), LOCAL_FALLBACK_SEED);
player.teleport(SPAWN_LOCAL_POSITION);

const input = new XrInput(renderer, player.body);
const hands = [new Hand(input.left, physics), new Hand(input.right, physics)];
const sfx = new Sfx(audioListener);

const comfortVignette = new ComfortVignette(camera);
const vhsOverlay = new VhsOverlay(camera);
const hud = new CamcorderHud(camera);
const ambientHum = new AmbientHum(audioListener, scene);
const flashlight = new Flashlight(camera);
const atmosphere = new Atmosphere(scene, hemisphere, ambient);

let currentSession: RunSessionInfo | null = null;

// Déclarée avant les menus : leurs actions y font référence (appelées plus tard, au clic).
let grabSystem: GrabSystem;

const inventoryMenu = new InventoryMenu(
  collectionStore,
  camera,
  player.body,
  {
    takeOut: (hand, entry) => {
      collectionStore.remove(entry.id);
      grabSystem.takeIntoHand(hand, entry, () => collectionStore.add(entry));
    },
    recalibrateHeight: () => player.recalibrate(),
    stopRec: () => endRunScreen.show(levelManager.depth),
  },
  sfx,
);

const endRunScreen = new EndRunScreen(
  camera,
  player.body,
  sfx,
  (pseudo) => {
    if (!currentSession) return Promise.reject(new Error("Pas de session de run active"));
    return endRun(currentSession, pseudo);
  },
  () => beginNewRun(true),
);

const pointer = new UiPointer(hands, scene, [inventoryMenu, endRunScreen]);

grabSystem = new GrabSystem(physics, grabbables, hands, sfx, {
  isOverInventory: (hand) => inventoryMenu.visible && (inventoryMenu.containsPoint(hand.palm) || pointer.frame(hand).target === inventoryMenu),
  store: (item) => collectionStore.add(item),
});

/** Place le joueur au spawn du level courant (changement de level, nouvelle run). */
function respawn(): void {
  player.teleport(SPAWN_LOCAL_POSITION);
  syncHands(timer.getElapsed());
  grabSystem.onTeleport();
  atmosphere.setDepth(levelManager.depth);
  atmosphere.triggerFlicker(0.8);
}

/**
 * Démarre une run côté serveur (seed + token). Serveur injoignable : on reste jouable en
 * local — et sur "nouvelle run", on repart quand même sur une seed locale fraîche.
 */
function beginNewRun(restartLocallyOnFailure: boolean): void {
  startRun()
    .then((session) => {
      currentSession = session;
      levelManager.restartRun(session.seed);
      hud.resetClock();
      respawn();
    })
    .catch(() => {
      currentSession = null;
      if (!restartLocallyOnFailure) return;
      levelManager.restartRun(`local-${Date.now()}`);
      hud.resetClock();
      respawn();
    });
}

beginNewRun(false);

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

const timer = new THREE.Timer();

function syncHands(time: number): void {
  player.rig.updateMatrixWorld(true);
  for (const hand of hands) hand.update(time);
}

const GLITCH_HAPTIC_INTENSITY = 0.6;
const GLITCH_HAPTIC_DURATION_MS = 120;
const WALL_TRAP_WARNING_HAPTIC_INTENSITY = 0.35;
const WALL_TRAP_WARNING_HAPTIC_DURATION_MS = 90;
const WALL_TRAP_POP_HAPTIC_INTENSITY = 1;
const WALL_TRAP_POP_HAPTIC_DURATION_MS = 180;
const TELEPORT_HAPTIC_INTENSITY = 1;
const TELEPORT_HAPTIC_DURATION_MS = 260;

renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  const elapsedSeconds = timer.getElapsed();

  // Pose de tête de cette frame (sinon celle de la frame précédente, recopiée au rendu).
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);
  input.update();

  // Y : inventaire, B : lampe (contrôles type Saints & Sinners, voir README).
  if (input.left.secondary.justPressed) inventoryMenu.toggle();
  if (input.right.secondary.justPressed) {
    flashlight.toggle();
    sfx.play("click", 0.3);
  }

  player.update(deltaSeconds, input);
  syncHands(elapsedSeconds);
  if (player.teleported) grabSystem.onTeleport();

  pointer.update();
  inventoryMenu.update(deltaSeconds, hands, (hand) => pointer.frame(hand).target === inventoryMenu);
  endRunScreen.update(hands);
  grabSystem.update(elapsedSeconds, pointer);

  physics.step(deltaSeconds, (stepSeconds) => {
    for (const hand of hands) hand.applyKinematicTarget();
    grabSystem.step(stepSeconds);
  });
  grabbables.sync();

  const levelUpdate = levelManager.update(player.headWorld, camera, elapsedSeconds, deltaSeconds, corruption.value);
  if (levelUpdate.corruptionDelta > 0) corruption.add(levelUpdate.corruptionDelta);
  if (levelUpdate.glitchTrapJustTriggered) {
    triggerHapticPulse(renderer, GLITCH_HAPTIC_INTENSITY, GLITCH_HAPTIC_DURATION_MS);
    atmosphere.triggerFlicker(0.5);
    vhsOverlay.triggerTrackingLoss(0.35);
  }
  if (levelUpdate.wallTrapJustWarned) triggerHapticPulse(renderer, WALL_TRAP_WARNING_HAPTIC_INTENSITY, WALL_TRAP_WARNING_HAPTIC_DURATION_MS);
  if (levelUpdate.wallTrapJustPopped) {
    triggerHapticPulse(renderer, WALL_TRAP_POP_HAPTIC_INTENSITY, WALL_TRAP_POP_HAPTIC_DURATION_MS);
    atmosphere.triggerFlicker(0.4);
  }

  if (levelUpdate.teleportDestination) {
    player.teleport(levelUpdate.teleportDestination);
    syncHands(elapsedSeconds);
    grabSystem.onTeleport();
    corruption.add(0.8);
    vhsOverlay.triggerTrackingLoss(1);
    flashlight.cut(0.6);
    atmosphere.triggerFlicker(1.2);
    sfx.play("teleport", 0.8);
    triggerHapticPulse(renderer, TELEPORT_HAPTIC_INTENSITY, TELEPORT_HAPTIC_DURATION_MS);
  }

  if (levelManager.hasReachedExit(player.headWorld)) {
    levelManager.descend();
    respawn();
    corruption.add(1);
    if (currentSession) reportLevel(currentSession, levelManager.depth);
  }
  corruption.update(deltaSeconds);

  hud.status = {
    depth: levelManager.depth,
    crouching: player.crouching,
    sprinting: player.sprinting,
    flashlight: flashlight.on,
    items: collectionStore.count,
  };
  comfortVignette.update(player.movementIntensity, deltaSeconds);
  vhsOverlay.update(elapsedSeconds, corruption.value, deltaSeconds);
  hud.update(deltaSeconds);
  flashlight.update(deltaSeconds, corruption.value);
  atmosphere.update(deltaSeconds, corruption.value);
  ambientHum.update(deltaSeconds, player.headWorld, levelUpdate.darkness, levelManager.depth, atmosphere.level);
  updateVhsTime(elapsedSeconds);
  renderer.render(scene, camera);
});
