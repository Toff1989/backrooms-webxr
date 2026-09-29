import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { AmbientHum } from "./assets/audio/ambientHum";
import { getLanguage, onLanguageChange, setLanguage, t, type Language } from "./i18n";
import { runWarmupStep } from "./assets/audio/synth";
import { DEBUG_ENABLED, installDebugLog, isDebugMenuEnabled, log } from "./debug/debugLog";
import { PhysicsWorld, RAPIER } from "./physics/physicsWorld";
import { CamcorderHud } from "./player/camcorderHud";
import { ComfortVignette } from "./player/comfortVignette";
import { EndRunScreen } from "./player/endRunScreen";
import { Flashlight } from "./player/flashlight";
import { GrabSystem } from "./player/grabSystem";
import { Hand } from "./player/hand";
import { triggerHapticPulse } from "./player/haptics";
import { DebugMenu } from "./player/debugMenu";
import { InventoryMenu } from "./player/inventoryMenu";
import { Journal } from "./player/journal";
import { LoadingGate } from "./player/loadingGate";
import { MainMenu } from "./player/mainMenu";
import { SettingsMenu } from "./player/settingsMenu";
import { PerfStats, setPerf } from "./player/perfStats";
import { LiveViews } from "./player/liveViews";
import { createObjectCapture, createPhotoCapture } from "./player/photoCapture";
import { PlayerController } from "./player/playerController";
import { PlayerVitals } from "./player/vitals";
import { Sfx } from "./player/sfx";
import { TapePlayer } from "./player/tapePlayer";
import { VhsOverlay } from "./player/vhsOverlay";
import { XrInput } from "./player/xrInput";
import { installAccountPanel } from "./ui/accountPanel";
import { UiPointer } from "./ui/uiPointer";
import { Atmosphere } from "./world/atmosphere";
import { Blackout } from "./world/blackout";
import { Cadreur } from "./world/cadreur";
import { CollectionStore } from "./world/collection";
import { computePerks } from "./world/collectionPerks";
import { corruption } from "./world/corruption";
import { GrabbableRegistry, type Grabbable, type LorePageData } from "./world/grabbable";
import { InteractionSystem } from "./world/interactions";
import { emitNoise, onNoise } from "./world/noise";
import { ObjectAudio } from "./world/objectAudio";
import { LevelManager, SPAWN_LOCAL_POSITION } from "./world/levelManager";
import { COLLECTIBLE_KINDS, generateCollectibleLore, getCollectibleRarity, type CollectibleKind } from "./shared/collectibles";
import { PROP_HALF_EXTENTS, type PropKind } from "./shared/props";
import { loreFormat } from "./shared/lore";
import { LoreJournal } from "./world/loreJournal";
import { SaveManager, type SaveData } from "./world/saveManager";
import { configureLoreServices, updateLoreObjects } from "./world/lorePage";
import { Poltergeist } from "./world/poltergeist";
import { spawnCollectibleModel } from "./world/collectibleLoader";
import { spawnProp } from "./world/propLoader";
import { initMaterials } from "./world/materials";
import { endRun, reportLevel, startRun, type RunSessionInfo } from "./world/runSession";
import { setFlashlightBounce, updateVhsTime } from "./world/vhsMaterial";
import { Warmup } from "./world/warmup";

installDebugLog();

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app introuvable dans index.html");
/**
 * Placeholder HTML statique (voir index.html) pour le tout début du chargement, avant que le
 * moteur WebGL puisse rendre quoi que ce soit (chargement des modules, WASM physique, KTX2...) —
 * masqué dès que l'écran de chargement générique (VHS bleu, voir `loadingGate.ts`) prend le
 * relais pour le niveau 0 fictif du menu principal, seule fenêtre de chargement du jeu ensuite.
 */
const htmlLoadingScreen = document.getElementById("loading-screen");
const visualTestParams = new URLSearchParams(window.location.search);
const visualTest = visualTestParams.get("visualTest");
const visualTestObject = visualTestParams.get("object");

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Teinte proche du noir, légèrement chaude (cohérente avec la teinte jaunâtre délavée du look VHS).
const BACKGROUND_COLOR = 0x0a0805;

const physics = await PhysicsWorld.create();

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND_COLOR);
scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.05);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 60);

// Pas d'antialiasing : en XR, three.js le traduit en MSAA ×4 sur le rendu du casque (coût
// GPU/bande passante réel sur la puce mobile du Quest), pour un gain quasi invisible — le
// grain VHS et la quantification des couleurs masquent déjà les crénelages.
const renderer = new THREE.WebGLRenderer({ antialias: false });
// Le pixel ratio ne concerne que l'aperçu écran : en XR, la résolution vient du casque
// (framebufferScaleFactor). Rendu fovéal au maximum : périphérie moins détaillée, gros
// gain GPU sur Quest, invisible avec le grain VHS.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
// Légèrement sous la résolution native du casque : moins de pixels à calculer (lampe torche
// et overlay VHS tournent sur tout le champ de vision, à chaque frame), donc moins de charge
// GPU et de conso batterie — perte de netteté négligeable, déjà masquée par le grain VHS.
renderer.xr.setFramebufferScaleFactor(0.85);
renderer.xr.setFoveation(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Vérification des shaders (lecture synchrone des journaux de compilation) : utile en debug
// seulement — en jeu, elle force le fil principal à attendre chaque compilation.
renderer.debug.checkShaderErrors = DEBUG_ENABLED;
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
/** Archives perdues : progression indépendante de l'inventaire, gardée d'une run à l'autre (et côté serveur). */
const loreJournal = new LoreJournal();
await loreJournal.load();
/** Sauvegarde de la partie en cours (seed, profondeur, inventaire, vitals, position) : locale, synchronisée entre appareils jumelés (voir saveManager.ts). */
const saveManager = new SaveManager();

/**
 * Seed fixe du niveau 0 fictif (voir `buildMenuRoom` plus bas) : l'espace où s'affiche le menu
 * principal, joueur figé, jamais une vraie run. Amorcé dès la construction du `LevelManager`,
 * avant même de savoir si une sauvegarde existe ou s'il faut une run neuve — cette décision
 * (Continuer/Nouvelle partie) n'a lieu qu'au premier choix du joueur, voir plus bas.
 */
const MENU_ROOM_SEED = "menu-room";
const levelManager = new LevelManager(
  scene,
  audioListener,
  physics,
  grabbables,
  (id) => collectionStore.has(id),
  () => loreJournal.nextFragment,
  MENU_ROOM_SEED,
);
player.teleport(SPAWN_LOCAL_POSITION);
// Doit exister avant le tout premier `respawn()` (niveau 0 fictif au démarrage, voir plus bas).
const timer = new THREE.Timer();

const input = new XrInput(renderer, player.body);
const hands = [new Hand(input.left, physics), new Hand(input.right, physics)];
const sfx = new Sfx(audioListener);

const vhsOverlay = new VhsOverlay(camera);
const comfortVignette = new ComfortVignette(vhsOverlay);
/** Écran de chargement unique (voir loadingGate.ts) : démarré avant même le premier rendu, pour
 * que le niveau 0 fictif du menu principal apparaisse déjà masqué par l'écran bleu. */
const loadingGate = new LoadingGate(vhsOverlay);
loadingGate.start();
// Laisser le navigateur peindre l'écran avant la génération synchrone des chunks initiaux.
await nextPaint();
levelManager.primeInitialArea();
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
const hud = new CamcorderHud(camera);
const vitals = new PlayerVitals();
/** Archives perdues : cassettes lues dans le viseur, polaroids photographiés derrière le joueur. */
const tapePlayer = new TapePlayer(audioListener, hud);
const capturePhoto = createPhotoCapture(renderer, scene, camera, physics);
const captureObject = createObjectCapture(renderer, scene, camera);
/** Vues en direct (télé, caméra de surveillance, jumelles, loupe, caméscope). */
const liveViews = new LiveViews(renderer, scene, camera);
configureLoreServices({
  capturePhoto,
  playTape: (fragment) => tapePlayer.play(fragment),
});
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
    views: liveViews.drainStats(),
  };
};
const atmosphere = new Atmosphere(scene, hemisphere, ambient);
const poltergeist = new Poltergeist(scene, audioListener, grabbables);
/** Menaces : la Coupure (néons qui meurent en vague) et le Cadreur (il bouge quand on ne le voit pas). */
const blackout = new Blackout(scene, audioListener);
const cadreur = new Cadreur(scene, audioListener, physics);
/** Le bruit (télé, réveil, objets lancés) attire le Cadreur, partout. */
onNoise((event) => cadreur.hear(event, levelManager.depth));

/** Pré-chauffage (modèles, enveloppes physiques, shaders, textures) : voir `warmup.ts`. */
const warmup = new Warmup(renderer, scene, camera);
warmup.start([cadreur.ready, ...hands.map((hand) => hand.models)]);

/** Bonus de collection : recalculés à chaque rangement/sortie d'objet. */
function applyPerks(): void {
  const perks = computePerks(collectionStore.getAll());
  flashlight.capacity = perks.batteryCapacity;
  player.sprintRecovery = perks.sprintRecovery;
  corruption.decayMultiplier = perks.corruptionDecay;
  levelManager.beaconSteadiness = perks.beaconSteadiness;
}
collectionStore.onChange(applyPerks);
applyPerks();

let currentSession: RunSessionInfo | null = null;
/**
 * Vrai tant que le joueur est dans le niveau 0 fictif (voir `buildMenuRoom`) : joueur figé,
 * menaces/vitals/corruption suspendus, seul le menu principal est interactif.
 */
let menuLimbo = false;
/** Run mise en pause en entrant dans le niveau 0 fictif depuis l'inventaire (null au démarrage
 * ou après un game over déjà clôturé — rien à reprendre) : voir `openMainMenu`/`continueRun`. */
let pausedRun: SaveData | null = null;
/** Résolution en arrière-plan (sauvegarde existante ou run neuve) pendant le tout premier
 * affichage du niveau 0 fictif au démarrage — consommée par le premier "Continuer". */
let bootSavePromise: Promise<SaveData | null> | null = null;
/** Paramètres ouverts directement depuis l'inventaire (aperçu léger) plutôt que depuis le menu
 * principal : "retour" referme simplement le panneau au lieu de réafficher le menu. */
let settingsOpenedStandalone = false;

// Déclarée avant les menus : leurs actions y font référence (appelées plus tard, au clic).
let grabSystem: GrabSystem;
const DEBUG_SPAWN_KINDS: Array<CollectibleKind | PropKind> = [...COLLECTIBLE_KINDS, ...(Object.keys(PROP_HALF_EXTENTS) as PropKind[])];
let debugSpawnIndex = 0;

const inventoryMenu = new InventoryMenu(
  collectionStore,
  camera,
  player.body,
  {
    takeOut: (hand, entry) => {
      collectionStore.remove(entry.id);
      grabSystem.takeIntoHand(hand, entry, () => collectionStore.add(entry));
    },
    openJournal: () => journal.openFloating(),
    openSettings: () => {
      settingsOpenedStandalone = true;
      settingsMenu.open();
    },
    openMainMenu: () => openMainMenu(),
    isDebugEnabled: () => isDebugMenuEnabled(),
    openDebugMenu: () => debugMenu.open(),
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
  () => {
    loadingGate.start();
    beginNewRun(true);
  },
  () => {
    pausedRun = null;
    loadingGate.start();
    buildMenuRoom();
  },
  () => loreJournal.serverProfile?.pseudo ?? null,
);

const journal = new Journal(camera, player.body, loreJournal, sfx);

const settingsMenu = new SettingsMenu(camera, player.body, sfx, {
  recalibrateHeight: () => player.recalibrate(),
  vignetteEnabled: () => comfortVignette.enabled,
  toggleVignette: () => {
    setVignette(!comfortVignette.enabled);
    return comfortVignette.enabled;
  },
  currentPseudo: () => loreJournal.serverProfile?.pseudo ?? null,
  // Ouverts depuis l'inventaire en jeu (aperçu léger, sans figer le joueur), "retour" referme
  // simplement le panneau ; ouverts depuis le menu principal (niveau 0 fictif, joueur déjà figé),
  // "retour" y réaffiche le menu — jamais de rechargement, on ne quitte pas le niveau 0 fictif.
  back: () => {
    if (!settingsOpenedStandalone) mainMenu.open();
  },
});

// Mode debug : tester les menaces et effets sans attendre (menu dédié, voir debugMenu.ts).
const debugMenu = new DebugMenu(camera, player.body, sfx, [
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
      goDeeper();
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
  {
    label: () => t("debug.spawn", { kind: DEBUG_SPAWN_KINDS[debugSpawnIndex % DEBUG_SPAWN_KINDS.length]! }),
    run: () => {
      const kind = DEBUG_SPAWN_KINDS[debugSpawnIndex % DEBUG_SPAWN_KINDS.length]!;
      debugSpawnIndex = (debugSpawnIndex + 1) % DEBUG_SPAWN_KINDS.length;
      void spawnDebugObject(kind);
      return t("debug.spawnStarted", { kind });
    },
  },
]);

const mainMenu = new MainMenu(camera, player.body, sfx, {
  // Reprend la run mise en pause (voir `pausedRun`), ou celle résolue en arrière-plan au
  // démarrage (sauvegarde existante ou run neuve, voir `bootSavePromise`) — dans les deux cas
  // via l'écran de chargement générique, jamais un simple dépilement du menu.
  continueRun: () => {
    mainMenu.close();
    if (pausedRun) {
      const save = pausedRun;
      pausedRun = null;
      loadingGate.start();
      resumeFromSave(save, true);
      return;
    }
    const pending = bootSavePromise;
    bootSavePromise = null;
    loadingGate.start();
    (pending ?? Promise.resolve(null)).then((save) => {
      if (save) resumeFromSave(save);
      else beginNewRun(true);
    });
  },
  newGame: () => {
    mainMenu.close();
    pausedRun = null;
    bootSavePromise = null;
    saveManager.clear();
    loadingGate.start();
    beginNewRun(true);
  },
  openSettings: () => {
    settingsOpenedStandalone = false;
    mainMenu.close();
    settingsMenu.open();
  },
  // Ex-STOP REC de l'inventaire : ne termine plus la run (la sauvegarde mise en pause, voir
  // `openMainMenu`, reste intacte pour "Continuer" la prochaine fois) — un simple "sauvegarder
  // et quitter", confirmé par un écran bleu qui reste affiché (rien d'autre à faire ensuite que
  // fermer l'onglet). La saisie du pseudo/score reste réservée aux vraies fins de run (mort,
  // capturé, victoire), voir `triggerGameOver`.
  quit: () => {
    mainMenu.close();
    vhsOverlay.showLoading([t("blue.saved"), t("blue.closeTab")]);
  },
});
installAccountPanel(loreJournal);

const pointer = new UiPointer(hands, scene, [inventoryMenu, endRunScreen, journal, mainMenu, settingsMenu, debugMenu]);
for (const panel of [inventoryMenu, endRunScreen, journal, mainMenu, settingsMenu, debugMenu]) {
  liveViews.hideFromOffscreen(panel.group);
  panel.prepareForDisplay(renderer, camera, scene);
}

/**
 * Archive perdue saisie : lue selon sa forme (photo qui se développe, cassette qui se lance), elle
 * entre au journal (et au serveur si la run y est enregistrée).
 */
function readLorePage(page: LorePageData, hand: Hand): void {
  const { fragment } = page;
  page.onRead();
  levelManager.pinLorePage(fragment);
  if (!loreJournal.read(fragment)) return;
  hud.showNotice(t("lore.new", { n: fragment + 1 }));
  hand.pulse(0.5, 120);
  log("lore", { action: "read", fragment, format: loreFormat(fragment), depth: levelManager.depth });
  // Condition de victoire : toutes les archives réunies.
  if (loreJournal.nextFragment === null) triggerGameOver("victory");
}

grabSystem = new GrabSystem(physics, grabbables, hands, sfx, {
  isOverInventory: (hand) => inventoryMenu.visible && (inventoryMenu.containsPoint(hand.palm) || pointer.frame(hand).target === inventoryMenu),
  inventorySlotAt: (hand) => inventoryMenu.slotIndexFor(hand),
  store: (item, slotIndex) => collectionStore.add(item, slotIndex ?? null),
  onGrab: (grabbable) => {
    if (!(grabbable.heldBy instanceof Hand)) return;
    if (grabbable.lorePage) readLorePage(grabbable.lorePage, grabbable.heldBy);
    interactions.grabbed(grabbable.heldBy, grabbable);
  },
  onUse: (hand, grabbable) => {
    if (!grabbable.batteryId) {
      interactions.use(hand, grabbable);
      return;
    }
    levelManager.markBatteryPicked(grabbable.batteryId);
    flashlight.recharge(BATTERY_RECHARGE);
    hand.pulse(0.45, 70);
    sfx.play("battery", 0.45);
    grabSystem.consumeHeld(hand, grabbable);
  },
  head: () => ({ position: player.headWorld, forward: camera.getWorldDirection(new THREE.Vector3()) }),
}, scene);

/** Objets qui s'animent : télé, réveil, lampes... (voir `interactions.ts`). */
const objectAudio = new ObjectAudio(scene, audioListener);
const interactions = new InteractionSystem({
  audio: objectAudio,
  physics,
  registry: grabbables,
  scene,
  camera,
  head: () => player.headWorld,
  cadreurPosition: () => cadreur.worldPosition,
  cadreurObject: () => cadreur.renderObject,
  stunCadreur: (seconds) => cadreur.stun(seconds),
  exitPosition: () => levelManager.exitPosition,
  capturePhoto,
  captureObject,
  isRemoteTarget: (grabbable) => grabSystem.isRemoteTarget(grabbable),
  take: () => take,
  runSeconds: () => hud.recordingSeconds,
  drop: (grabbable) => grabSystem.drop(grabbable),
  views: liveViews,
  cadreurEye: () => {
    const position = cadreur.eyeWorld;
    return position ? { position, target: player.headWorld } : null;
  },
});

const DEBUG_SPAWN_UP = new THREE.Vector3(0, 1, 0);
const debugSpawnDirection = new THREE.Vector3();

interface DebugSpawnOptions {
  position?: THREE.Vector3;
  rotation?: number;
}

async function spawnDebugObject(kind: CollectibleKind | PropKind, options: DebugSpawnOptions = {}): Promise<Grabbable> {
  camera.getWorldDirection(debugSpawnDirection);
  debugSpawnDirection.y = 0;
  if (debugSpawnDirection.lengthSq() < 1e-6) debugSpawnDirection.set(0, 0, -1);
  debugSpawnDirection.normalize();
  const position = options.position?.clone() ?? player.headWorld.clone().addScaledVector(debugSpawnDirection, 1.2);
  const rotation = options.rotation ?? Math.atan2(-debugSpawnDirection.x, -debugSpawnDirection.z);

  if ((COLLECTIBLE_KINDS as readonly string[]).includes(kind)) {
    const collectibleKind = kind as CollectibleKind;
    const { model, template } = await spawnCollectibleModel(collectibleKind);
    const lore = generateCollectibleLore(collectibleKind, 0.5, 0.5);
    const grabbable = grabbables.createCollectible(
      {
        id: `debug-${collectibleKind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: collectibleKind,
        rarity: getCollectibleRarity(collectibleKind),
        scale: 1,
        depth: levelManager.depth,
        ...lore,
        collectedAt: 0,
      },
      model,
      template,
      position,
      new THREE.Quaternion().setFromAxisAngle(DEBUG_SPAWN_UP, rotation),
    );
    log("debug", { action: "spawn", kind });
    return grabbable;
  } else {
    const propKind = kind as PropKind;
    const { model, template } = await spawnProp(propKind);
    const grabbable = grabbables.createProp(propKind, model, template, position.x, position.z, rotation, position.y);
    log("debug", { action: "spawn", kind });
    return grabbable;
  }
}

const VISUAL_INTERACTION_STAGES = ["ALIGNED", "INTERACTED"] as const;
let resolveVisualCapture: (() => void) | null = null;

interface VisualObjectPreview {
  setAngle(angleRadians: number): void;
  update(): void;
}

let visualObjectPreview: VisualObjectPreview | null = null;

function captureVisualStage(stage: string): Promise<void> {
  (window as unknown as Record<string, string>) ["__STAGE__"] = stage;
  return new Promise<void>((resolve) => {
    resolveVisualCapture = resolve;
  });
}

async function runVisualInteractionTest(): Promise<void> {
  (window as unknown as Record<string, readonly string[]>) ["__STAGES__"] = VISUAL_INTERACTION_STAGES;
  (window as unknown as { __next__: () => void }) ["__next__"] = () => {
    resolveVisualCapture?.();
    resolveVisualCapture = null;
  };

  const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(forward, DEBUG_SPAWN_UP).normalize();
  const rotation = Math.atan2(-forward.x, -forward.z);
  const center = player.headWorld.clone().addScaledVector(forward, 2.2).setY(0);
  const television = await spawnDebugObject("television", { position: center.clone().addScaledVector(right, -0.65), rotation });
  const sign = await spawnDebugObject("wetFloorSign", { position: center.clone(), rotation });
  const can = await spawnDebugObject("can", { position: center.clone().addScaledVector(right, 0.65), rotation });
  const photo = await spawnDebugObject("photo", { position: center.clone().addScaledVector(right, 1.15), rotation });
  for (const grabbable of [television, sign, can, photo]) grabbable.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);

  log("visual-test", { action: "aligned", kinds: [television.kind, sign.kind, can.kind, photo.kind] });
  await captureVisualStage("ALIGNED");
  interactions.use(hands[0]!, television);
  await new Promise<void>((resolve) => window.setTimeout(resolve, 2600));
  interactions.use(hands[0]!, sign);
  interactions.use(hands[0]!, can);
  log("visual-test", { action: "interacted", kinds: [television.kind, sign.kind, can.kind, photo.kind] });
  await captureVisualStage("INTERACTED");
}

async function runVisualObjectTest(kind: CollectibleKind | PropKind): Promise<void> {
  const angles = Array.from({ length: 8 }, (_, index) => index * 45);
  const stages = angles.map((angle) => `${angle.toString().padStart(3, "0")}DEG`);
  (window as unknown as Record<string, readonly string[]>) ["__STAGES__"] = stages;
  (window as unknown as { __next__: () => void }) ["__next__"] = () => {
    resolveVisualCapture?.();
    resolveVisualCapture = null;
  };

  const forward = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const right = new THREE.Vector3().crossVectors(forward, DEBUG_SPAWN_UP).normalize();
  const rotation = Math.atan2(-forward.x, -forward.z);
  const target = player.headWorld.clone().addScaledVector(forward, 0.9);
  const nearbyCollectible = kind === "photo" ? await spawnDebugObject("can", { position: target.clone().addScaledVector(right, 0.55), rotation }) : null;
  const grabbable = await spawnDebugObject(kind, { position: target, rotation });
  grabbable.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
  nearbyCollectible?.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
  grabbable.object.updateMatrixWorld(true);

  const visualCenter = new THREE.Box3().setFromObject(grabbable.object).getCenter(new THREE.Vector3());
  const localCenter = grabbable.object.worldToLocal(visualCenter).multiply(grabbable.object.scale);
  const position = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const baseRotation = grabbable.object.quaternion.clone();
  const orientation = new THREE.Quaternion();
  let angleRadians = 0;
  visualObjectPreview = {
    setAngle(angle) {
      angleRadians = angle;
    },
    update() {
      spin.setFromAxisAngle(DEBUG_SPAWN_UP, angleRadians);
      orientation.copy(baseRotation).multiply(spin);
      offset.copy(localCenter).applyQuaternion(orientation);
      position.copy(target).sub(offset);
      grabbable.body.setRotation(orientation, true);
      grabbable.body.setTranslation(position, true);
    },
  };
  visualObjectPreview.update();

  log("visual-test", { action: "preview", kind });
  for (let index = 0; index < stages.length; index++) {
    visualObjectPreview.setAngle(THREE.MathUtils.degToRad(angles[index]!));
    visualObjectPreview.update();
    await captureVisualStage(stages[index]!);
  }
}

/** Place le joueur au spawn du level courant (changement de level, nouvelle run). */
function respawn(): void {
  tapePlayer.stop();
  player.teleport(SPAWN_LOCAL_POSITION);
  syncHands(timer.getElapsed());
  grabSystem.onTeleport();
  atmosphere.setDepth(levelManager.depth);
  atmosphere.triggerFlicker(0.8);
  blackout.reset(levelManager.depth);
  cadreur.reset(levelManager.depth);
}

/**
 * Niveau suivant : sortie atteinte ou menu debug. Une capture est désormais un game over.
 * Écran de chargement générique pendant la reconstruction du chunk (voir loadingGate.ts),
 * puis carton "NIV {n}" (voir showCard) avant de révéler le jeu — jamais l'un sans l'autre.
 */
let take = 1;
function goDeeper(): void {
  levelManager.descend();
  log("level", { action: "descend", depth: levelManager.depth });
  respawn();
  loadingGate.start([t("blue.loading")], () => vhsOverlay.showCard(1.4, [t("blue.level", { n: levelManager.depth })]));
  loadingGate.ready();
  corruption.add(1);
  if (currentSession) reportLevel(currentSession, levelManager.depth);
  autosave();
}

let gameOver = false;

/** Referme tous les panneaux de menu (inventaire, journal, paramètres, debug, menu principal). */
function closeAllMenus(): void {
  if (inventoryMenu.visible) inventoryMenu.close();
  if (journal.visible) journal.close();
  if (settingsMenu.visible) settingsMenu.close();
  if (debugMenu.visible) debugMenu.close();
  if (mainMenu.visible) mainMenu.close();
}

function triggerGameOver(reason: "health" | "caught" | "victory"): void {
  if (gameOver) return;
  gameOver = true;
  player.paused = true;
  closeAllMenus();
  grabSystem.loseHeld();
  cadreur.reset(levelManager.depth);
  saveManager.clear();
  endRunScreen.showGameOver(levelManager.depth, reason);
  log("run", { action: reason === "victory" ? "victory" : "game-over", reason, depth: levelManager.depth });
}

/**
 * Démarre une run côté serveur (seed + token). Serveur injoignable : on reste jouable en
 * local — et sur "nouvelle run", on repart quand même sur une seed locale fraîche. Toujours
 * appelé avec l'écran de chargement générique déjà démarré (voir les actions du menu principal
 * et de l'écran de fin de run) : `restartWorld` le referme une fois le monde prêt.
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

/** Nouvelle partie : monde neuf, inventaire vidé, rien en main — quitte le niveau 0 fictif. */
function restartWorld(seed: string): void {
  gameOver = false;
  menuLimbo = false;
  player.paused = false;
  vitals.reset();
  grabSystem.loseHeld();
  collectionStore.clear();
  levelManager.restartRun(seed);
  take = 1;
  hud.resetClock();
  respawn();
  loadingGate.ready();
  log("run", { action: "start", seed });
}

/** Ce qu'une sauvegarde doit garder pour retrouver exactement la même partie (voir saveManager.ts). */
function snapshot(): SaveData {
  return {
    seed: levelManager.seed,
    depth: levelManager.depth,
    take,
    health: vitals.health,
    madness: vitals.madness,
    flashlightBattery: flashlight.battery,
    position: { x: player.headWorld.x, z: player.headWorld.z },
    inventory: collectionStore.getAll().slice(),
  };
}

/**
 * Sauvegarde silencieuse (changement de level, minuteur, page masquée) : jamais pendant un game
 * over (la run est de toute façon effacée juste après, voir `triggerGameOver`) ni dans le
 * niveau 0 fictif (elle y snapshotterait ce faux niveau au lieu de la run mise en pause).
 */
function autosave(): void {
  if (gameOver || menuLimbo) return;
  saveManager.save(snapshot());
}

/**
 * Reprend une partie sauvegardée : même seed (le level se reconstruit à l'identique), même
 * profondeur, inventaire/santé/folie/batterie/position restaurés. Quitte le niveau 0 fictif.
 * `keepSession` : vrai pour une run mise en pause (session serveur toujours valide, aucun level
 * signalé pendant le passage par le menu) ; faux pour une sauvegarde relue au démarrage — pas de
 * suivi anti-triche pour la suite de cette run (`/run/level` exige une progression séquentielle
 * depuis la profondeur 0 d'une run fraîchement créée, incompatible avec une reprise à une
 * profondeur quelconque) ; un "Quitter"/game over ultérieur ne pourra pas envoyer de score, comme
 * hors ligne. Les archives perdues restent suivies localement dans tous les cas.
 */
function resumeFromSave(save: SaveData, keepSession = false): void {
  gameOver = false;
  if (!keepSession) currentSession = null;
  vitals.health = save.health;
  vitals.madness = save.madness;
  flashlight.battery = save.flashlightBattery;
  grabSystem.loseHeld();
  collectionStore.clear();
  // add() sans index pose l'objet en tête (comme un ramassage) : on repart de la fin pour
  // reconstruire le même ordre que la sauvegarde plutôt que de l'inverser.
  for (const entry of [...save.inventory].reverse()) collectionStore.add(entry);
  levelManager.restartRun(save.seed, save.depth);
  take = save.take;
  hud.resetClock();
  respawn();
  player.teleport(new THREE.Vector3(save.position.x, 0, save.position.z));
  menuLimbo = false;
  player.paused = false;
  loadingGate.ready();
  log("run", { action: keepSession ? "resume-paused" : "resume", seed: save.seed, depth: save.depth });
}

/**
 * Reconstruit le niveau 0 fictif (voir `MENU_ROOM_SEED`) et y installe le joueur, figé, avec le
 * menu principal affiché — seul panneau interactif tant qu'on y reste. À appeler avec l'écran de
 * chargement générique déjà démarré (voir `openMainMenu`, le bouton "Menu principal" de l'écran
 * de fin de run, et le tout premier appel ci-dessous, au démarrage).
 */
function buildMenuRoom(): void {
  menuLimbo = true;
  levelManager.restartRun(MENU_ROOM_SEED, 0);
  take = 1;
  respawn();
  player.paused = true;
  mainMenu.open();
  loadingGate.ready();
}

/**
 * Ouvre le menu principal depuis l'inventaire, en jeu : la run en cours est mise en pause (voir
 * `pausedRun`, restaurée par "Continuer") puis on bascule dans le niveau 0 fictif. Sans effet
 * si le menu y est déjà (juste réaffiché, voir `settingsMenu`'s "retour").
 */
function openMainMenu(): void {
  if (menuLimbo) {
    mainMenu.open();
    return;
  }
  pausedRun = snapshot();
  saveManager.save(pausedRun);
  loadingGate.start();
  buildMenuRoom();
}

// Démarrage : le niveau 0 fictif (menu principal) s'affiche tout de suite, joueur figé ; la
// sauvegarde éventuelle (ou la décision de repartir à neuf) se résout en arrière-plan et n'est
// appliquée qu'au premier choix du joueur (voir `bootSavePromise`, consommé par "Continuer").
bootSavePromise = saveManager.load();
buildMenuRoom();
htmlLoadingScreen?.classList.add("is-hidden");
void loreJournal.sync();

// Sauvegarde périodique (filet de sécurité) et à la mise en arrière-plan de la page (casque
// retiré, onglet changé) — plus fiable que `beforeunload` pour un travail asynchrone (IndexedDB).
const AUTOSAVE_INTERVAL_SECONDS = 20;
let autosaveTimer = AUTOSAVE_INTERVAL_SECONDS;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") autosave();
});

// Mode debug : commandes pour les bancs de test automatisés (session XR émulée) — déplacer le
// joueur d'un coup (streaming de chunks dans le pire cas), descendre, ouvrir l'inventaire.
if (DEBUG_ENABLED) {
  (window as unknown as Record<string, unknown>)["__game"] = {
    teleport: (x: number, z: number) => {
      player.teleport(new THREE.Vector3(x, 0, z));
      grabSystem.onTeleport();
    },
    descend: () => goDeeper(),
    toggleInventory: () => inventoryMenu.toggle(),
    head: () => ({ x: player.headWorld.x, z: player.headWorld.z }),
    exit: () => levelManager.exitPosition,
    spawn: (kind: string) => {
      if (!DEBUG_SPAWN_KINDS.some((candidate) => candidate === kind)) return Promise.reject(new Error(`Unknown debug spawn kind: ${kind}`));
      return spawnDebugObject(kind as CollectibleKind | PropKind);
    },
    awakeBodies: () => {
      let awake = 0;
      physics.world.bodies.forEach((body) => {
        if (body.isDynamic() && !body.isSleeping()) awake++;
      });
      return awake;
    },
    renderer,
  };
}

if (visualTest === "interactions") {
  void runVisualInteractionTest().catch((error: unknown) => {
    console.error("Échec du scénario visuel d'interactions", error);
    (window as unknown as Record<string, string>) ["__STAGE__"] = "ERROR";
  });
}
if (visualTest === "object") {
  if (!visualTestObject || !DEBUG_SPAWN_KINDS.some((kind) => kind === visualTestObject)) {
    console.error(`Objet de test visuel invalide : ${visualTestObject ?? "absent"}`);
    (window as unknown as Record<string, string>) ["__STAGE__"] = "ERROR";
  } else {
    void runVisualObjectTest(visualTestObject as CollectibleKind | PropKind).catch((error: unknown) => {
      console.error("Échec du scénario visuel d'objet", error);
      (window as unknown as Record<string, string>) ["__STAGE__"] = "ERROR";
    });
  }
}

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

/** Cadence visée en VR (Hz). */
const TARGET_FRAME_RATE = 72;

renderer.xr.addEventListener("sessionstart", () => {
  resumeAudio("sessionstart");
  ambientHum.start();
  levelManager.onSessionStart();
  vhsOverlay.showCard(2.5, [t("blue.loading"), t("blue.level", { n: levelManager.depth })]);
  const session = renderer.xr.getSession();
  if (session) {
    // Cadence fixée à 72 Hz (budget de 13,9 ms, celui que suit `PerfStats`) si le casque en
    // propose une plus haute par défaut : 72 images stables valent mieux qu'un 90 Hz qui
    // décroche (chaque frame manquée se voit, reprojetée). Pratique courante sur Quest.
    if (session.supportedFrameRates?.includes(TARGET_FRAME_RATE) && session.frameRate !== TARGET_FRAME_RATE) {
      session.updateTargetFrameRate?.(TARGET_FRAME_RATE).catch((error: unknown) => log("xr", { action: "frame-rate-failed", error: String(error) }));
    }
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

function syncHands(time: number): void {
  player.rig.updateMatrixWorld(true);
  for (const hand of hands) hand.update(time);
}

const WALL_TRAP_WARNING_HAPTIC_INTENSITY = 0.35;
const WALL_TRAP_WARNING_HAPTIC_DURATION_MS = 90;
const WALL_TRAP_POP_HAPTIC_INTENSITY = 1;
const WALL_TRAP_POP_HAPTIC_DURATION_MS = 180;
const BATTERY_RECHARGE = 0.45;
const bouncePosition = new THREE.Vector3();
let playerNoiseTimer = 0;

renderer.setAnimationLoop((timestamp) => {
  perfStats.beginFrame(timestamp);
  timer.update(timestamp);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  const elapsedSeconds = timer.getElapsed();

  // Pose de tête de cette frame (sinon celle de la frame précédente, recopiée au rendu).
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);
  input.update();

  // Y : inventaire, B : lampe (contrôles type Saints & Sinners, voir README) — indisponibles
  // pendant un game over ou dans le niveau 0 fictif (rien d'autre que le menu n'y est interactif).
  if (!gameOver && !menuLimbo && input.left.secondary.justPressed) inventoryMenu.toggle();
  if (!gameOver && !menuLimbo && input.right.secondary.justPressed) {
    sfx.play(flashlight.toggle() ? "click" : "denied", 0.3);
  }

  perfStats.begin("joueur");
  player.update(deltaSeconds, input);
  playerNoiseTimer -= deltaSeconds;
  if (playerNoiseTimer <= 0 && player.movementNoise > 0) {
    emitNoise(player.headWorld, player.movementNoise);
    playerNoiseTimer = 0.35;
  }
  syncHands(elapsedSeconds);
  if (player.teleported) grabSystem.onTeleport();

  pointer.update();
  inventoryMenu.update(deltaSeconds, hands, (hand) => pointer.frame(hand).target === inventoryMenu);
  endRunScreen.update(hands);
  settingsMenu.update(deltaSeconds);
  mainMenu.update(deltaSeconds);
  debugMenu.update(deltaSeconds);
  autosaveTimer -= deltaSeconds;
  if (autosaveTimer <= 0) {
    autosaveTimer = AUTOSAVE_INTERVAL_SECONDS;
    autosave();
  }
  grabSystem.update(elapsedSeconds, pointer);
  perfStats.end("joueur");

  perfStats.begin("physique");
  physics.step(deltaSeconds, (stepSeconds) => {
    for (const hand of hands) hand.applyKinematicTarget();
    grabSystem.step(stepSeconds);
  });
  visualObjectPreview?.update();
  grabbables.sync(player.headWorld);
  grabSystem.updateVisuals();
  interactions.update(deltaSeconds);
  perfStats.end("physique");

  perfStats.begin("monde");
  const levelUpdate = levelManager.update(player.headWorld, camera, elapsedSeconds, deltaSeconds, corruption.value);
  perfStats.end("monde");

  // Niveau 0 fictif (menu principal, voir buildMenuRoom) : joueur figé et sans enjeu, aucune des
  // menaces/de la fatigue de la vraie run ne doit s'y appliquer (santé, folie, corruption, sortie).
  let darkness = levelUpdate.darkness;
  let localLight = 1;
  if (!menuLimbo) {
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
    localLight = blackout.lightAt(head.x, head.z);
    darkness = Math.max(levelUpdate.darkness, 1 - localLight);
    const cadreurEvents = cadreur.update(deltaSeconds, {
      head,
      camera,
      flashlight: flashlight.shining,
      lightAt: (x, z) => levelManager.zoneLightAt(x, z) * blackout.lightAt(x, z) * atmosphere.level,
      depth: levelManager.depth,
    });
    // Découvert : la bande décroche une fraction de seconde.
    if (cadreurEvents.sighted) vhsOverlay.triggerTrackingLoss(0.35);
    if (cadreurEvents.nearby) vhsOverlay.triggerTrackingLoss(0.45);
    if (cadreurEvents.playerDamage > 0 && vitals.damage(cadreurEvents.playerDamage)) triggerGameOver("health");
    if (cadreurEvents.sighted) vitals.addMadness(10);
    if (cadreurEvents.watched) vitals.addMadness(deltaSeconds * 4);
    perfStats.end("menaces");

    if (cadreurEvents.caught) triggerGameOver("caught");
    else if (!gameOver && levelManager.hasReachedExit(player.headWorld)) goDeeper();
    if (levelUpdate.corruptionDelta > 0) vitals.addMadness(levelUpdate.corruptionDelta * 8);
    if (levelUpdate.wallTrapJustPopped) vitals.addMadness(12);
    if (blackoutEvents.reachedPlayer) vitals.addMadness(8);
    if (vitals.update(deltaSeconds, flashlight.shining && player.movementIntensity < 0.1)) triggerGameOver("health");
    corruption.update(deltaSeconds);
  }

  hud.status = {
    depth: levelManager.depth,
    crouching: player.crouching,
    sprinting: player.sprinting,
    flashlight: flashlight.on,
    items: collectionStore.count,
    battery: flashlight.battery,
    sprintEnergy: player.sprintEnergy,
    health: vitals.health / vitals.maxHealth,
    madness: vitals.madness / vitals.maxMadness,
    // Plein à moins de 5 m, vide au-delà de 60 m ; brouillé par la corruption.
    signal: THREE.MathUtils.clamp(1 - (levelUpdate.exitDistance - 5) / 55, 0, 1) * (1 - corruption.value * 0.6 * Math.random()),
    debug: perfStats.readAndReset(),
  };
  perfStats.begin("effets");
  comfortVignette.update(player.movementIntensity, deltaSeconds);
  vhsOverlay.update(elapsedSeconds, corruption.value, deltaSeconds);
  tapePlayer.update(deltaSeconds);
  updateLoreObjects(deltaSeconds);
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
  perfStats.begin("préchauffage");
  warmup.step();
  perfStats.end("préchauffage");
  perfStats.begin("vues");
  liveViews.render(deltaSeconds);
  perfStats.end("vues");
  perfStats.begin("rendu");
  perfStats.beginGpu();
  renderer.render(scene, camera);
  loadingGate.update(deltaSeconds);
  perfStats.endGpu();
  perfStats.end("rendu");
  perfStats.endFrame(deltaSeconds);
});
