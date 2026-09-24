import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { AmbientHum } from "./assets/audio/ambientHum";
import { getLanguage, onLanguageChange, setLanguage, t, type Language } from "./i18n";
import { runWarmupStep } from "./assets/audio/synth";
import { installDebugLog, log } from "./debug/debugLog";
import { PhysicsWorld } from "./physics/physicsWorld";
import { CamcorderHud } from "./player/camcorderHud";
import { ComfortVignette } from "./player/comfortVignette";
import { EndRunScreen } from "./player/endRunScreen";
import { Flashlight } from "./player/flashlight";
import { GrabSystem } from "./player/grabSystem";
import { Hand } from "./player/hand";
import { triggerHapticPulse } from "./player/haptics";
import { InventoryMenu } from "./player/inventoryMenu";
import { PerfStats, setPerf } from "./player/perfStats";
import { PlayerController } from "./player/playerController";
import { Sfx } from "./player/sfx";
import { VhsOverlay } from "./player/vhsOverlay";
import { XrInput } from "./player/xrInput";
import { UiPointer } from "./ui/uiPointer";
import { Atmosphere } from "./world/atmosphere";
import { Blackout } from "./world/blackout";
import { Cadreur } from "./world/cadreur";
import { CollectionStore } from "./world/collection";
import { computePerks } from "./world/collectionPerks";
import { corruption } from "./world/corruption";
import { GrabbableRegistry } from "./world/grabbable";
import { LevelManager, SPAWN_LOCAL_POSITION } from "./world/levelManager";
import { Poltergeist } from "./world/poltergeist";
import { initMaterials } from "./world/materials";
import { endRun, reportLevel, startRun, type RunSessionInfo } from "./world/runSession";
import { setFlashlightBounce, updateVhsTime } from "./world/vhsMaterial";

installDebugLog();

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app introuvable dans index.html");

// Teinte proche du noir, légèrement chaude (cohérente avec la teinte jaunâtre délavée du look VHS).
const BACKGROUND_COLOR = 0x0a0805;

const physics = await PhysicsWorld.create();

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND_COLOR);
scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.035);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 60);

// Pas d'antialiasing : en XR, three.js le traduit en MSAA ×4 sur le rendu du casque (coût
// GPU/bande passante réel sur la puce mobile du Quest), pour un gain quasi invisible — le
// grain VHS et la quantification des couleurs masquent déjà les crénelages.
const renderer = new THREE.WebGLRenderer({ antialias: false });
// Le pixel ratio ne concerne que l'aperçu écran : en XR, la résolution vient du casque
// (framebufferScaleFactor). Rendu fovéal au maximum : périphérie moins détaillée, gros
// gain GPU sur Quest, invisible avec le grain VHS.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.xr.setFramebufferScaleFactor(1);
renderer.xr.setFoveation(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
appRoot.appendChild(renderer.domElement);
// Pas de bouton "Entrer en VR" proposé par le navigateur (offerSession) : il lance la session
// sans aucun geste sur la page, et le navigateur refuse alors de démarrer le son jusqu'au
// premier appui sur une gâchette (43 s de silence au dernier test). Avec le bouton de la page,
// le clic sert aussi à débloquer l'audio (voir `resumeAudio`).
if (navigator.xr && "offerSession" in navigator.xr) Object.defineProperty(navigator.xr, "offerSession", { value: undefined, configurable: true });
document.body.appendChild(VRButton.createButton(renderer));

// Textures KTX2 transcodées avant de construire le premier level (matériaux partagés).
await initMaterials(renderer);

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
/** Vignette de confort : réglable dans les options (écran) et dans le menu du casque, mémorisée. */
const VIGNETTE_KEY = "backrooms-vr:vignette";
const vignetteToggle = document.querySelector<HTMLInputElement>("#vignette-toggle");
function loadVignettePreference(): boolean {
  try {
    return localStorage.getItem(VIGNETTE_KEY) !== "off";
  } catch {
    return true;
  }
}
function setVignette(enabled: boolean): void {
  comfortVignette.enabled = enabled;
  if (vignetteToggle) vignetteToggle.checked = enabled;
  try {
    localStorage.setItem(VIGNETTE_KEY, enabled ? "on" : "off");
  } catch {
    // Stockage indisponible : réglage valable pour cette session seulement.
  }
}
const vhsOverlay = new VhsOverlay(camera);
const hud = new CamcorderHud(camera);
const ambientHum = new AmbientHum(audioListener, scene);
const flashlight = new Flashlight(camera);
const perfStats = new PerfStats(renderer, camera);
setPerf(perfStats);
perfStats.extra = () => {
  let awakeBodies = 0;
  physics.world.bodies.forEach((body) => {
    if (body.isDynamic() && !body.isSleeping()) awakeBodies++;
  });
  return {
    xr: renderer.xr.isPresenting,
    audio: audioListener.context.state,
    depth: levelManager.depth,
    pos: [Math.round(player.headWorld.x * 10) / 10, Math.round(player.headWorld.z * 10) / 10],
    grabbables: grabbables.all.size,
    awakeBodies,
    corruption: Math.round(corruption.value * 100) / 100,
    flashlight: flashlight.on,
    blackout: blackout.active,
    cadreur: cadreur.present,
  };
};
const atmosphere = new Atmosphere(scene, hemisphere, ambient);
const poltergeist = new Poltergeist(scene, audioListener, grabbables);
/** Menaces : la Coupure (néons qui meurent en vague) et le Cadreur (il bouge quand on ne le voit pas). */
const blackout = new Blackout(scene, audioListener);
const cadreur = new Cadreur(scene, audioListener, physics);

/** Bonus de collection : recalculés à chaque rangement/sortie d'objet. */
function applyPerks(): void {
  const perks = computePerks(collectionStore.getAll());
  flashlight.capacity = perks.batteryCapacity;
  corruption.decayMultiplier = perks.corruptionDecay;
  levelManager.beaconSteadiness = perks.beaconSteadiness;
}
collectionStore.onChange(applyPerks);
applyPerks();

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
    vignetteEnabled: () => comfortVignette.enabled,
    toggleVignette: () => {
      setVignette(!comfortVignette.enabled);
      return comfortVignette.enabled;
    },
    // Mode debug : tester les menaces et effets sans attendre (rangée bleue du menu).
    debug: [
      {
        label: () => (blackout.active ? t("debug.blackoutStop") : t("debug.blackoutStart")),
        run: () => {
          blackout.toggle();
          return blackout.active ? t("debug.blackoutStarted") : t("debug.blackoutStopped");
        },
      },
      {
        label: () => (cadreur.present ? t("debug.cadreurStop") : t("debug.cadreurStart")),
        run: () => {
          const wasPresent = cadreur.present;
          cadreur.toggle();
          return wasPresent ? t("debug.cadreurDismissed") : t("debug.cadreurCalled");
        },
      },
      {
        label: () => t("debug.level"),
        run: () => {
          goDeeper(false);
          return t("debug.levelDone");
        },
      },
      {
        label: () => t("debug.battery"),
        run: () => {
          flashlight.recharge(1);
          return t("debug.batteryDone");
        },
      },
    ],
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
  inventorySlotAt: (hand) => inventoryMenu.slotIndexFor(hand),
  store: (item, slotIndex) => collectionStore.add(item, slotIndex ?? null),
  head: () => ({ position: player.headWorld, forward: camera.getWorldDirection(new THREE.Vector3()) }),
}, scene);

/** Place le joueur au spawn du level courant (changement de level, nouvelle run). */
function respawn(): void {
  player.teleport(SPAWN_LOCAL_POSITION);
  syncHands(timer.getElapsed());
  grabSystem.onTeleport();
  atmosphere.setDepth(levelManager.depth);
  atmosphere.triggerFlicker(0.8);
  blackout.reset(levelManager.depth);
  cadreur.reset(levelManager.depth);
}

/** Niveau suivant : sortie atteinte, rattrapé par le Cadreur (réveil les mains vides), ou menu debug. */
function goDeeper(caught: boolean): void {
  if (caught) grabSystem.loseHeld();
  levelManager.descend();
  log("level", { action: caught ? "caught" : "descend", depth: levelManager.depth });
  respawn();
  const lines = [t("blue.level", { n: levelManager.depth })];
  if (caught) lines.unshift(t("blue.lost"));
  vhsOverlay.blueScreen(caught ? 2.6 : 1.4, lines);
  corruption.add(1);
  if (currentSession) reportLevel(currentSession, levelManager.depth);
}

/**
 * Démarre une run côté serveur (seed + token). Serveur injoignable : on reste jouable en
 * local — et sur "nouvelle run", on repart quand même sur une seed locale fraîche.
 */
function beginNewRun(restartLocallyOnFailure: boolean): void {
  startRun()
    .then((session) => {
      currentSession = session;
      restartWorld(session.seed);
    })
    .catch(() => {
      currentSession = null;
      if (restartLocallyOnFailure) restartWorld(`local-${Date.now()}`);
    });
}

/** Nouvelle partie : monde neuf, inventaire vidé, rien en main. */
function restartWorld(seed: string): void {
  grabSystem.loseHeld();
  collectionStore.clear();
  levelManager.restartRun(seed);
  hud.resetClock();
  respawn();
  log("run", { action: "start", seed });
}

beginNewRun(false);

/**
 * Son : les navigateurs (dont celui du Quest) ne démarrent l'audio que pendant un geste de
 * l'utilisateur. L'événement "sessionstart" n'en est pas toujours un : on relance donc le
 * contexte audio à chaque geste (clic sur "Entrer en VR", gâchette/grip en VR) tant qu'il
 * n'est pas actif. Chaque tentative est journalisée en mode debug.
 */
function resumeAudio(reason: string): void {
  const context = audioListener.context;
  if (context.state === "running") return;
  context
    .resume()
    .then(() => log("audio", { action: "resume", reason, state: context.state }))
    .catch((error: unknown) => log("audio", { action: "resume-failed", reason, state: context.state, error: String(error) }));
}
for (const type of ["pointerdown", "pointerup", "click", "keydown", "touchstart"]) document.addEventListener(type, () => resumeAudio(type), { capture: true });
audioListener.context.addEventListener("statechange", () => log("audio", { action: "statechange", state: audioListener.context.state }));

renderer.xr.addEventListener("sessionstart", () => {
  resumeAudio("sessionstart");
  ambientHum.start();
  levelManager.onSessionStart();
  const session = renderer.xr.getSession();
  if (session) {
    for (const type of ["selectstart", "squeezestart"] as const) session.addEventListener(type, () => resumeAudio(`xr-${type}`));
    log("xr", {
      action: "sessionstart",
      frameRate: session.frameRate,
      supportedFrameRates: session.supportedFrameRates ? [...session.supportedFrameRates] : undefined,
      foveation: renderer.xr.getFoveation(),
      inputs: [...session.inputSources].map((source) => `${source.handedness}:${source.profiles[0] ?? "?"}`),
      audio: audioListener.context.state,
    });
  }
});
renderer.xr.addEventListener("sessionend", () => log("xr", { action: "sessionend" }));

/** Panneau d'options HTML (aperçu écran, avant d'entrer en VR) : textes traduits + choix de langue. */
function translateOptions(): void {
  document.documentElement.lang = getLanguage();
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset["i18n"] as Parameters<typeof t>[0]);
  });
  const select = document.querySelector<HTMLSelectElement>("#language-select");
  if (select) select.value = getLanguage();
}
document.querySelector<HTMLSelectElement>("#language-select")?.addEventListener("change", (event) => {
  setLanguage((event.target as HTMLSelectElement).value as Language);
});
onLanguageChange(translateOptions);
translateOptions();
// Version affichée (options + inventaire) : permet de vérifier que le casque charge bien le dernier build.
const buildLabel = document.querySelector<HTMLElement>("#build-id");
if (buildLabel) buildLabel.textContent = `build ${__BUILD_ID__}`;

vignetteToggle?.addEventListener("change", () => setVignette(vignetteToggle.checked));
setVignette(loadVignettePreference());

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

const WALL_TRAP_WARNING_HAPTIC_INTENSITY = 0.35;
const WALL_TRAP_WARNING_HAPTIC_DURATION_MS = 90;
const WALL_TRAP_POP_HAPTIC_INTENSITY = 1;
const WALL_TRAP_POP_HAPTIC_DURATION_MS = 180;
/** Charge rendue par une pile ramassée (fraction de la batterie de la lampe). */
const BATTERY_RECHARGE = 0.45;
const handPalms = hands.map((hand) => hand.palm);
const bouncePosition = new THREE.Vector3();

renderer.setAnimationLoop((timestamp) => {
  perfStats.beginFrame(timestamp);
  timer.update(timestamp);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  const elapsedSeconds = timer.getElapsed();

  // Pose de tête de cette frame (sinon celle de la frame précédente, recopiée au rendu).
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);
  input.update();

  // Y : inventaire, B : lampe (contrôles type Saints & Sinners, voir README).
  if (input.left.secondary.justPressed) inventoryMenu.toggle();
  if (input.right.secondary.justPressed) {
    sfx.play(flashlight.toggle() ? "click" : "denied", 0.3);
  }

  perfStats.begin("joueur");
  player.update(deltaSeconds, input);
  syncHands(elapsedSeconds);
  if (player.teleported) grabSystem.onTeleport();

  pointer.update();
  inventoryMenu.update(deltaSeconds, hands, (hand) => pointer.frame(hand).target === inventoryMenu);
  endRunScreen.update(hands);
  grabSystem.update(elapsedSeconds, pointer);
  perfStats.end("joueur");

  perfStats.begin("physique");
  physics.step(deltaSeconds, (stepSeconds) => {
    for (const hand of hands) hand.applyKinematicTarget();
    grabSystem.step(stepSeconds);
  });
  grabbables.sync(player.headWorld);
  grabSystem.updateVisuals();
  perfStats.end("physique");

  perfStats.begin("monde");
  const levelUpdate = levelManager.update(player.headWorld, handPalms, camera, elapsedSeconds, deltaSeconds, corruption.value);
  perfStats.end("monde");
  if (levelUpdate.batteriesPicked > 0) {
    flashlight.recharge(BATTERY_RECHARGE * levelUpdate.batteriesPicked);
    sfx.play("battery", 0.6);
  }
  if (levelUpdate.corruptionDelta > 0) corruption.add(levelUpdate.corruptionDelta);
  if (levelUpdate.wallTrapJustWarned) triggerHapticPulse(renderer, WALL_TRAP_WARNING_HAPTIC_INTENSITY, WALL_TRAP_WARNING_HAPTIC_DURATION_MS);
  if (levelUpdate.wallTrapJustPopped) {
    triggerHapticPulse(renderer, WALL_TRAP_POP_HAPTIC_INTENSITY, WALL_TRAP_POP_HAPTIC_DURATION_MS);
    atmosphere.triggerFlicker(0.4);
  }

  perfStats.begin("menaces");
  const head = player.headWorld;
  const blackoutEvents = blackout.update(deltaSeconds, head, levelManager.depth);
  // Avant la coupure, les néons s'étranglent.
  if (blackout.warning && Math.random() < deltaSeconds * 3) atmosphere.triggerFlicker(0.12);
  if (blackoutEvents.reachedPlayer) {
    triggerHapticPulse(renderer, 0.25, 70);
    cadreur.summon();
  }
  const localLight = blackout.lightAt(head.x, head.z);
  const darkness = Math.max(levelUpdate.darkness, 1 - localLight);
  const cadreurEvents = cadreur.update(deltaSeconds, {
    head,
    camera,
    flashlight: flashlight.shining,
    lightAt: (x, z) => levelManager.zoneLightAt(x, z) * blackout.lightAt(x, z) * atmosphere.level,
    depth: levelManager.depth,
  });
  // Découvert : la bande décroche une fraction de seconde.
  if (cadreurEvents.sighted) vhsOverlay.triggerTrackingLoss(0.35);
  perfStats.end("menaces");

  if (cadreurEvents.caught || levelManager.hasReachedExit(player.headWorld)) goDeeper(cadreurEvents.caught);
  corruption.update(deltaSeconds);

  hud.status = {
    depth: levelManager.depth,
    crouching: player.crouching,
    sprinting: player.sprinting,
    flashlight: flashlight.on,
    items: collectionStore.count,
    battery: flashlight.battery,
    // Plein à moins de 5 m, vide au-delà de 60 m ; brouillé par la corruption.
    signal: THREE.MathUtils.clamp(1 - (levelUpdate.exitDistance - 5) / 55, 0, 1) * (1 - corruption.value * 0.6 * Math.random()),
    debug: perfStats.readAndReset(),
  };
  perfStats.begin("effets");
  comfortVignette.update(player.movementIntensity, deltaSeconds);
  vhsOverlay.update(elapsedSeconds, corruption.value, deltaSeconds);
  hud.update(deltaSeconds);
  flashlight.update(deltaSeconds, corruption.value);
  // Lumière renvoyée par la lampe : centrée un mètre devant, là où tombe le faisceau.
  bouncePosition.copy(camera.getWorldDirection(bouncePosition)).setY(0).normalize().add(player.headWorld).setY(1);
  setFlashlightBounce(bouncePosition, flashlight.strength);
  atmosphere.update(deltaSeconds, corruption.value);
  poltergeist.update(deltaSeconds, camera, player.headWorld, levelManager.depth, darkness);
  ambientHum.update(deltaSeconds, player.headWorld, darkness, levelManager.depth, atmosphere.level * localLight);
  updateVhsTime(elapsedSeconds);
  runWarmupStep(renderer.xr.isPresenting);
  perfStats.end("effets");
  perfStats.begin("rendu");
  perfStats.beginGpu();
  renderer.render(scene, camera);
  perfStats.endGpu();
  perfStats.end("rendu");
  perfStats.endFrame(deltaSeconds);
});
