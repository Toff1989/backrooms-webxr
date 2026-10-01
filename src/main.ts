import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { AmbientHum } from "./assets/audio/ambientHum";
import { getLanguage, onLanguageChange, setLanguage, t, type Language, type TranslationKey } from "./i18n";
import { runWarmupStep } from "./assets/audio/synth";
import { DEBUG_ENABLED, installDebugLog, isDebugMenuEnabled, log } from "./debug/debugLog";
import { PhysicsWorld, RAPIER } from "./physics/physicsWorld";
import { CamcorderHud } from "./player/camcorderHud";
import { CameraMenu } from "./player/cameraMenu";
import { CADREUR_TRACK_DRAIN_PER_SECOND, CameraTracker } from "./player/cameraTracker";
import { ComfortVignette, type VignetteLevel, VIGNETTE_LEVELS } from "./player/comfortVignette";
import { JUMPSCARE_LEVELS, loadJumpscareLevel, loadVignetteLevel, nextLevel, saveJumpscareLevel, saveVignetteLevel, type JumpscareLevel } from "./player/comfortSettings";
import { EndRunScreen } from "./player/endRunScreen";
import { EndSequence } from "./player/endSequence";
import { Flashlight } from "./player/flashlight";
import { GuideMenu } from "./player/guideMenu";
import { GrabSystem } from "./player/grabSystem";
import { Hand } from "./player/hand";
import { triggerHapticPulse } from "./player/haptics";
import { DebugMenu } from "./player/debugMenu";
import { DeviceMenu } from "./player/deviceMenu";
import { InventoryMenu } from "./player/inventoryMenu";
import { Journal } from "./player/journal";
import { LoadingGate } from "./player/loadingGate";
import { MainMenu } from "./player/mainMenu";
import { NoticeModal } from "./player/noticeModal";
import { TapeSignalModal } from "./player/tapeSignalModal";
import { SettingsMenu } from "./player/settingsMenu";
import { ScoresMenu } from "./player/scoresMenu";
import { AchievementsMenu } from "./player/achievementsMenu";
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
import { CorruptionPatch, PATCH_DAMAGE_PER_SECOND, PATCH_MADNESS_PER_SECOND } from "./world/corruptionPatch";
import { Cadreur } from "./world/cadreur";
import { CollectionStore } from "./world/collection";
import { computePerks } from "./world/collectionPerks";
import { corruption } from "./world/corruption";
import { GrabbableRegistry, type Grabbable, type LorePageData } from "./world/grabbable";
import { InteractionSystem } from "./world/interactions";
import { emitNoise, onNoise } from "./world/noise";
import { ObjectAudio } from "./world/objectAudio";
import { LevelManager, SPAWN_LOCAL_POSITION } from "./world/levelManager";
import { resetProgress } from "./world/playerIdentity";
import { AchievementTracker, computeAchievementPerks } from "./world/achievements";
import { COLLECTIBLE_KINDS, generateCollectibleLore, getCollectibleRarity, type CollectibleKind } from "./shared/collectibles";
import { PROP_HALF_EXTENTS, type PropKind } from "./shared/props";
import { loreFormat, type LoreFormat } from "./shared/lore";
import { LoreJournal } from "./world/loreJournal";
import { SaveManager, type SaveData } from "./world/saveManager";
import { configureLoreServices, updateLoreObjects } from "./world/lorePage";
import { MarkerSurfaces } from "./world/markerSurfaces";
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
// Scénarios de test visuel (`?visualTest=...`) : uniquement sur le serveur de dev, jamais dans une version déployée.
const visualTestParams = new URLSearchParams(import.meta.env.DEV ? window.location.search : "");
const visualTest = visualTestParams.get("visualTest");
const visualTestObject = visualTestParams.get("object");

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Teinte proche du noir, légèrement chaude (cohérente avec la teinte jaunâtre délavée du look VHS).
const BACKGROUND_COLOR = 0x0a0805;
/** Attente maximale (ms) de la synchro serveur initiale avant d'afficher le menu principal. */
const BOOT_SERVER_WAIT_MS = 2500;

/**
 * Données serveur récupérées dès le tout début du chargement, en parallèle du moteur physique,
 * des shaders et des textures (et non plus seulement au lancement d'une partie) : identité,
 * archives lues, succès, sauvegarde en cours. Le local (IndexedDB) reste la source de vérité si
 * le serveur est injoignable : rien ici ne bloque ni ne fait échouer le démarrage.
 */
/** Archives perdues : progression indépendante de l'inventaire, gardée d'une run à l'autre (et côté serveur). */
const loreJournal = new LoreJournal();
/** Succès (~30 défis permanents, voir achievements.ts) : statistiques cumulées, indépendantes de la run en cours. */
const achievements = new AchievementTracker();
/** Sauvegarde de la partie en cours (seed, profondeur, inventaire, vitals, position) : locale, synchronisée entre appareils jumelés (voir saveManager.ts). */
const saveManager = new SaveManager();
const localProgressLoaded = Promise.all([loreJournal.load(), achievements.load()]);
const bootServerSync: Promise<unknown> = localProgressLoaded.then(() => Promise.allSettled([loreJournal.sync(), achievements.sync()]));
let bootSavePromise: Promise<SaveData | null> | null = saveManager.load().catch(() => null);

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
// La page d'archive posée dans le premier level dépend de la progression : attendre le local.
await localProgressLoaded;
loreJournal.onChange(() => achievements.raise("archivesRead", loreJournal.count));
achievements.raise("archivesRead", loreJournal.count);

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
/** Sursaut de capture (tête du Cadreur) et fondu rouge/noir de la mort par santé, avant l'écran de score. */
const endSequence = new EndSequence(camera, audioListener, vhsOverlay);
/** Écran de chargement unique (voir loadingGate.ts) : démarré avant même le premier rendu, pour
 * que le niveau 0 fictif du menu principal apparaisse déjà masqué par l'écran bleu. */
const loadingGate = new LoadingGate(vhsOverlay);
loadingGate.start();
// Laisser le navigateur peindre l'écran avant la génération synchrone des chunks initiaux.
await nextPaint();
levelManager.primeInitialArea();
/** Vignette de confort (4 niveaux) et intensité des sursauts : réglables dans les options (écran) et dans le menu du casque, mémorisés. */
const vignetteToggle = document.querySelector<HTMLInputElement>("#vignette-toggle");
let jumpscareLevel: JumpscareLevel = loadJumpscareLevel();
function setVignetteLevel(level: VignetteLevel): void {
  comfortVignette.level = level;
  if (vignetteToggle) vignetteToggle.checked = level !== "off";
  saveVignetteLevel(level);
}
const hud = new CamcorderHud(camera);
/** Bandeau bien visible (succès, archive trouvée) : distinct du HUD discret, avec son propre son. */
const noticeModal = new NoticeModal(camera, sfx);
achievements.onUnlock((def) => noticeModal.show("achievement", t(def.titleKey)));
const vitals = new PlayerVitals();
/** Archives perdues : cassettes lues dans un modal dédié (signal + transcription), polaroids photographiés derrière le joueur. */
const tapeSignalModal = new TapeSignalModal(camera);
const tapePlayer = new TapePlayer(audioListener, tapeSignalModal);
const capturePhoto = createPhotoCapture(renderer, scene, camera, physics);
const captureObject = createObjectCapture(renderer, scene, camera);
/** Vues en direct (télé, caméra de surveillance, jumelles, loupe, caméscope). */
const liveViews = new LiveViews(renderer, scene, camera);
configureLoreServices({
  capturePhoto: () => {
    const canvas = capturePhoto();
    if (canvas) achievements.bump("photosCount");
    return canvas;
  },
  playTape: (fragment) => {
    tapePlayer.play(fragment);
    achievements.bump("tapesPlayed");
  },
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
/** Corruption VHS : tache au sol qui ronge la santé, monte la folie et interdit le sprint. */
const corruptionPatch = new CorruptionPatch(scene, audioListener);
/** Le bruit (télé, réveil, objets lancés) attire le Cadreur, partout. */
onNoise((event) => cadreur.hear(event, levelManager.depth));

/** Pré-chauffage (modèles, enveloppes physiques, shaders, textures) : voir `warmup.ts`. */
const warmup = new Warmup(renderer, scene, camera);
warmup.start([cadreur.ready, endSequence.ready, ...hands.map((hand) => hand.models)]);

/** Bonus de collection : recalculés à chaque rangement/sortie d'objet. */
/** Perks de run (inventaire, remis à zéro chaque partie) + perks permanents des succès débloqués (cumulés). */
function applyPerks(): void {
  const runPerks = computePerks(collectionStore.getAll());
  const achievementPerks = computeAchievementPerks(achievements.unlockedIds);
  flashlight.capacity = runPerks.batteryCapacity + achievementPerks.batteryCapacity;
  player.sprintRecovery = runPerks.sprintRecovery + achievementPerks.sprintRecovery;
  corruption.decayMultiplier = runPerks.corruptionDecay + achievementPerks.corruptionDecay;
  levelManager.beaconSteadiness = runPerks.beaconSteadiness + achievementPerks.beaconSteadiness;
}
collectionStore.onChange(applyPerks);
collectionStore.onChange(() => achievements.raise("maxItemsHeldInRun", collectionStore.count));
achievements.onUnlock(applyPerks);
applyPerks();

let currentSession: RunSessionInfo | null = null;
/**
 * Vrai tant que le joueur est dans le niveau 0 fictif (voir `buildMenuRoom`) : joueur figé,
 * menaces/vitals/corruption suspendus, seul le menu principal est interactif.
 */
let menuLimbo = false;
let menuRoomNeedsPlacement = true;
/** Run mise en pause en entrant dans le niveau 0 fictif depuis l'inventaire (null au démarrage
 * ou après un game over déjà clôturé — rien à reprendre) : voir `openMainMenu`/`continueRun`. */
let pausedRun: SaveData | null = null;
/** Résolution en arrière-plan (sauvegarde existante ou run neuve) pendant le tout premier
 * affichage du niveau 0 fictif au démarrage — consommée par le premier "Continuer". */
/** Paramètres ouverts directement depuis l'inventaire (aperçu léger) plutôt que depuis le menu
 * principal : "retour" referme simplement le panneau au lieu de réafficher le menu. */
let settingsOpenedStandalone = false;

// Déclarée avant les menus : leurs actions y font référence (appelées plus tard, au clic).
let grabSystem: GrabSystem;
let guideMenu: GuideMenu;
let deviceMenu: DeviceMenu;
let scoresMenu: ScoresMenu;
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
    openCamera: () => cameraMenu.open(),
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
  () => loreJournal.currentPseudo,
);

const journal = new Journal(camera, player.body, loreJournal, sfx);
/** Signal du caméscope : ce qu'il traque (sortie, Cadreur, archive perdue), voir cameraTracker.ts. */
const cameraTracker = new CameraTracker();
const cameraMenu = new CameraMenu(camera, player.body, sfx, cameraTracker);

const settingsMenu = new SettingsMenu(camera, player.body, sfx, {
  recalibrateHeight: () => player.recalibrate(),
  vignetteLevel: () => comfortVignette.level,
  cycleVignette: () => {
    setVignetteLevel(nextLevel(VIGNETTE_LEVELS, comfortVignette.level));
    return comfortVignette.level;
  },
  jumpscareLevel: () => jumpscareLevel,
  cycleJumpscare: () => {
    jumpscareLevel = nextLevel(JUMPSCARE_LEVELS, jumpscareLevel);
    saveJumpscareLevel(jumpscareLevel);
    return jumpscareLevel;
  },
  currentPseudo: () => loreJournal.currentPseudo,
  setPseudo: (pseudo) =>
    loreJournal.setPseudo(pseudo).then((confirmed) => {
      if (confirmed) {
        achievements.raise("pseudoChanged", 1);
        void achievements.sync();
      }
      return confirmed;
    }),
  // Efface toujours l'état local (même hors ligne) ; l'appel serveur (archives, sauvegarde,
  // succès) est best-effort, comme le reste de la synchro — voir `resetProgress` dans playerIdentity.ts.
  resetProgress: async () => {
    pausedRun = null;
    saveManager.clear();
    loreJournal.reset();
    achievements.reset();
    return resetProgress();
  },
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
    label: () => (corruptionPatch.active ? t("debug.patchStop") : t("debug.patchStart")),
    run: () => {
      corruptionPatch.toggle(player.headWorld, camera);
      return corruptionPatch.active ? t("debug.patchStarted") : t("debug.patchStopped");
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
  openGuide: () => {
    mainMenu.close();
    guideMenu.open();
  },
  openDevices: () => {
    mainMenu.close();
    deviceMenu.open();
  },
  openScores: () => {
    mainMenu.close();
    scoresMenu.open();
  },
  openAchievements: () => {
    mainMenu.close();
    achievementsMenu.open();
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
guideMenu = new GuideMenu(camera, player.body, sfx, () => mainMenu.open());
deviceMenu = new DeviceMenu(camera, player.body, loreJournal, sfx, () => mainMenu.open());
scoresMenu = new ScoresMenu(camera, player.body, loreJournal, sfx, () => mainMenu.open());
const achievementsMenu = new AchievementsMenu(camera, player.body, sfx, achievements, () => mainMenu.open());
installAccountPanel(loreJournal, achievements);

const pointer = new UiPointer(hands, scene, [inventoryMenu, endRunScreen, journal, cameraMenu, mainMenu, settingsMenu, debugMenu, guideMenu, deviceMenu, scoresMenu, achievementsMenu]);
for (const panel of [inventoryMenu, endRunScreen, journal, cameraMenu, mainMenu, settingsMenu, debugMenu, guideMenu, deviceMenu, scoresMenu, achievementsMenu]) {
  liveViews.hideFromOffscreen(panel.group);
  panel.prepareForDisplay(renderer, camera, scene);
}

const LORE_FORMAT_LABEL_KEY: Record<LoreFormat, TranslationKey> = {
  journal: "lore.format.journal",
  fiche: "lore.format.fiche",
  polaroid: "lore.format.polaroid",
  audio: "lore.format.audio",
};

/**
 * Archive perdue saisie : lue selon sa forme (photo qui se développe, cassette qui se lance), elle
 * entre au journal (et au serveur si la run y est enregistrée).
 */
function readLorePage(page: LorePageData, hand: Hand): void {
  const { fragment } = page;
  page.onRead();
  levelManager.pinLorePage(fragment);
  if (!loreJournal.read(fragment)) return;
  const format = loreFormat(fragment);
  noticeModal.show("lore", t("lore.title", { n: fragment + 1 }), t(LORE_FORMAT_LABEL_KEY[format]));
  hand.pulse(0.5, 120);
  log("lore", { action: "read", fragment, format, depth: levelManager.depth });
  archiveReadThisLevel = true;
  // Condition de victoire : toutes les archives réunies.
  if (loreJournal.nextFragment === null) triggerGameOver("victory");
}

// Un objet ramassé puis reposé (id inchangé) ne doit compter qu'une fois — contrairement à
// l'inventaire de run (vidé à chaque partie), cet ensemble n'est jamais réinitialisé : les ids
// sont uniques par apparition, jamais réutilisés d'une run à l'autre.
const seenCollectibleIds = new Set<string>();
function recordItemCollected(entry: { id: string; rarity: "common" | "rare" | "legendary" }): void {
  if (seenCollectibleIds.has(entry.id)) return;
  seenCollectibleIds.add(entry.id);
  achievements.bump("itemsTotal");
  achievements.bump(entry.rarity === "common" ? "itemsCommon" : entry.rarity === "rare" ? "itemsRare" : "itemsLegendary");
}

grabSystem = new GrabSystem(physics, grabbables, hands, sfx, {
  isOverInventory: (hand) => inventoryMenu.visible && (inventoryMenu.containsPoint(hand.palm) || pointer.frame(hand).target === inventoryMenu),
  inventorySlotAt: (hand) => inventoryMenu.slotIndexFor(hand),
  store: (item, slotIndex) => {
    recordItemCollected(item);
    collectionStore.add(item, slotIndex ?? null);
  },
  onGrab: (grabbable) => {
    if (!(grabbable.heldBy instanceof Hand)) return;
    if (grabbable.lorePage) readLorePage(grabbable.lorePage, grabbable.heldBy);
    interactions.grabbed(grabbable.heldBy, grabbable);
  },
  onUse: (hand, grabbable) => {
    if (grabbable.medkitId) {
      // Trousse de soin : rend de la santé (jamais au-delà du maximum) et disparaît.
      if (vitals.health >= vitals.maxHealth) {
        sfx.play("denied", 0.3);
        return;
      }
      levelManager.markMedkitPicked(grabbable.medkitId);
      vitals.heal(MEDKIT_HEAL);
      hand.pulse(0.5, 120);
      sfx.play("unlock", 0.45);
      grabSystem.consumeHeld(hand, grabbable);
      return;
    }
    if (!grabbable.batteryId) {
      interactions.use(hand, grabbable);
      return;
    }
    levelManager.markBatteryPicked(grabbable.batteryId);
    flashlight.recharge(BATTERY_RECHARGE);
    achievements.bump("batteriesPicked");
    batteriesPickedThisRun++;
    hand.pulse(0.45, 70);
    sfx.play("battery", 0.45);
    grabSystem.consumeHeld(hand, grabbable);
  },
  head: () => ({ position: player.headWorld, forward: camera.getWorldDirection(new THREE.Vector3()) }),
}, scene);

/** Objets qui s'animent : télé, réveil, lampes... (voir `interactions.ts`). */
const objectAudio = new ObjectAudio(scene, audioListener);
/** Dessin au marqueur sur sol/murs/plafond : tuiles canvas, effacées à chaque niveau (voir markerSurfaces.ts). */
const markerSurfaces = new MarkerSurfaces(scene, physics);
levelManager.onChunkLoaded = (bounds) => markerSurfaces.queueRevalidate(bounds);
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
  surfaces: markerSurfaces,
  comfort: (grabbable, amount) => comfortObject(grabbable, amount),
});

/** Délai (s) avant qu'un même objet réconfortant (ballon, canard...) puisse apaiser à nouveau. */
const COMFORT_COOLDOWN_SECONDS = 45;
const comfortUsedAt = new Map<string, number>();
function comfortObject(grabbable: Grabbable, amount: number): boolean {
  if (menuLimbo || gameOver || vitals.madness <= 0) return false;
  const key = grabbable.item?.id ?? `${grabbable.kind}:${Math.round(grabbable.object.position.x)}:${Math.round(grabbable.object.position.z)}`;
  const now = timer.getElapsed();
  const last = comfortUsedAt.get(key);
  if (last !== undefined && now - last < COMFORT_COOLDOWN_SECONDS) return false;
  comfortUsedAt.set(key, now);
  vitals.soothe(amount);
  const hand = grabbable.heldBy;
  if (hand instanceof Hand) hand.pulse(0.3, 140);
  return true;
}

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

// État de run pour les succès (voir achievements.ts) : remis à zéro à chaque vraie run
// (restartWorld/resumeFromSave), jamais dans le niveau 0 fictif (pas une run).
let wasSighted = false;
let damagedThisLevel = false;
let flashlightToggledOffThisRun = false;
let batteriesPickedThisRun = 0;
let archiveReadThisLevel = false;
let archiveStreak = 0;
let runStartedAt = 0;
/** Sous ce délai réel (pas le temps de jeu simulé), atteindre le niveau 10 débloque "fastDepth10". */
const FAST_DEPTH10_MS = 10 * 60 * 1000;

/** Nouvelle run (jamais à la reprise d'une run mise en pause, voir `resumeFromSave`) : l'ardoise des succès liés "depuis le début de cette run" est effacée. */
function resetRunAchievementState(): void {
  wasSighted = false;
  damagedThisLevel = false;
  flashlightToggledOffThisRun = false;
  batteriesPickedThisRun = 0;
  archiveReadThisLevel = false;
  archiveStreak = 0;
  runStartedAt = performance.now();
}

/** Place le joueur au spawn du level courant (changement de level, nouvelle run). */
function respawn(): void {
  tapePlayer.stop();
  markerSurfaces.clear();
  player.teleport(SPAWN_LOCAL_POSITION);
  syncHands(timer.getElapsed());
  grabSystem.onTeleport();
  atmosphere.setDepth(levelManager.depth);
  atmosphere.triggerFlicker(0.8);
  blackout.reset(levelManager.depth);
  corruptionPatch.reset(levelManager.depth);
  cadreur.reset(levelManager.depth);
}

/**
 * Niveau suivant : sortie atteinte ou menu debug. Une capture est désormais un game over.
 * Écran de chargement générique pendant la reconstruction du chunk (voir loadingGate.ts),
 * puis carton "NIV {n}" (voir showCard) avant de révéler le jeu — jamais l'un sans l'autre.
 */
let take = 1;
function goDeeper(): void {
  // Bilan du level qu'on quitte, avant d'incrémenter la profondeur.
  if (!damagedThisLevel) achievements.bump("levelsNoDamage");
  if (archiveReadThisLevel) {
    archiveStreak += 1;
    achievements.raise("archiveStreakLevels", archiveStreak);
  } else {
    archiveStreak = 0;
  }
  damagedThisLevel = false;
  archiveReadThisLevel = false;

  levelManager.descend();
  log("level", { action: "descend", depth: levelManager.depth });
  achievements.raise("depthMax", levelManager.depth);
  if (levelManager.depth === 10) {
    if (batteriesPickedThisRun === 0) achievements.raise("reachedDepth10NoBattery", 1);
    if (performance.now() - runStartedAt <= FAST_DEPTH10_MS) achievements.raise("fastDepth10", 1);
  }
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
  if (cameraMenu.visible) cameraMenu.close();
  if (settingsMenu.visible) settingsMenu.close();
  if (debugMenu.visible) debugMenu.close();
  if (mainMenu.visible) mainMenu.close();
  if (guideMenu?.visible) guideMenu.close();
  if (deviceMenu?.visible) deviceMenu.close();
  if (scoresMenu?.visible) scoresMenu.close();
  if (achievementsMenu.visible) achievementsMenu.close();
}

function triggerGameOver(reason: "health" | "caught" | "victory"): void {
  if (gameOver) return;
  gameOver = true;
  player.paused = true;
  closeAllMenus();
  grabSystem.loseHeld();
  cadreur.reset(levelManager.depth);
  saveManager.clear();
  // Capture/santé à zéro : la séquence (sursaut ou fondu) précède l'écran de score ; la victoire l'affiche tout de suite.
  const reasonDepth = levelManager.depth;
  if (reason === "victory") endRunScreen.showGameOver(reasonDepth, reason);
  else endSequence.start(reason === "caught" ? "caught" : "health", jumpscareLevel, () => endRunScreen.showGameOver(reasonDepth, reason));
  log("run", { action: reason === "victory" ? "victory" : "game-over", reason, depth: levelManager.depth });

  achievements.raise("depthMax", levelManager.depth);
  achievements.bump("runsEnded");
  if (!flashlightToggledOffThisRun) achievements.bump("runsNoFlashlightOff");
  if (reason === "health") achievements.bump("deaths");
  else if (reason === "caught") achievements.bump("catches");
  else {
    if (achievements.get("deaths") === 0) achievements.raise("victoryWithoutPriorDeath", 1);
    achievements.bump("victories");
  }
  void achievements.sync();
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
  endSequence.reset();
  gameOver = false;
  menuLimbo = false;
  player.paused = false;
  vitals.reset();
  grabSystem.loseHeld();
  collectionStore.clear();
  flashlight.reset();
  levelManager.restartRun(seed);
  take = 1;
  hud.resetClock();
  respawn();
  resetRunAchievementState();
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
    ...(currentSession ? { session: { runId: currentSession.runId, token: currentSession.token, seed: currentSession.seed } } : {}),
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
 * signalé pendant le passage par le menu) ; faux pour une sauvegarde relue au démarrage : la
 * session serveur est alors restaurée depuis la sauvegarde (`save.session`), ce qui permet
 * d'envoyer le score en fin de run ; sans elle (ancienne sauvegarde, run hors ligne), l'envoi du
 * score n'est pas possible, comme hors ligne. Les archives perdues restent suivies localement dans tous les cas.
 */
function resumeFromSave(save: SaveData, keepSession = false): void {
  endSequence.reset();
  gameOver = false;
  if (!keepSession) {
    // Session serveur rangée dans la sauvegarde : sans elle, la fin de la run reprise ne pourrait
    // pas envoyer de score (et l'écran de fin affichait à tort "serveur injoignable").
    currentSession = save.session ?? null;
    resetRunAchievementState();
  }
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
  endSequence.reset();
  menuLimbo = true;
  menuRoomNeedsPlacement = true;
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
// Laisse au serveur un court délai pour répondre (archives, succès) avant d'afficher le menu :
// passé ce délai, la synchro continue en arrière-plan et le menu se met à jour tout seul.
await Promise.race([bootServerSync, new Promise<void>((resolve) => window.setTimeout(resolve, BOOT_SERVER_WAIT_MS))]);
buildMenuRoom();
htmlLoadingScreen?.classList.add("is-hidden");

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
    openMenu: (name: "main" | "inventory" | "settings" | "journal" | "debug" | "guide" | "devices" | "scores" | "achievements" | "end") => {
      closeAllMenus();
      if (name === "main") mainMenu.open();
      else if (name === "inventory") inventoryMenu.open();
      else if (name === "settings") settingsMenu.open();
      else if (name === "journal") journal.openFloating();
      else if (name === "debug") debugMenu.open();
      else if (name === "guide") guideMenu.open();
      else if (name === "devices") deviceMenu.open();
      else if (name === "scores") scoresMenu.open();
      else if (name === "achievements") achievementsMenu.open();
      else endRunScreen.showGameOver(levelManager.depth, "health");
    },
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
    closeMenus: () => closeAllMenus(),
    achievementsUnlocked: () => achievements.unlockedCount,
    achievements,
    noticeModal,
    tapeSignalModal,
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
  // Le menu principal avait été placé à la hauteur de l'aperçu écran : à l'entrée en VR il est replacé
  // (une fois la hauteur recalée) à la vraie hauteur des yeux — sinon il flottait trop haut.
  if (menuLimbo) menuRoomNeedsPlacement = true;
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

vignetteToggle?.addEventListener("change", () => setVignetteLevel(vignetteToggle.checked ? (comfortVignette.level === "off" ? "normal" : comfortVignette.level) : "off"));
setVignetteLevel(loadVignetteLevel());

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
/** Santé rendue par une trousse de soin (sur 100). */
const MEDKIT_HEAL = 35;
const bouncePosition = new THREE.Vector3();
const trackForward = { x: 0, z: -1 };
const trackDirection = new THREE.Vector3();
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
  // X (main gauche, mains vides) : change la cible du signal du caméscope (voir cameraMenu.ts).
  if (!gameOver && !menuLimbo && input.left.primary.justPressed && !hands[0]!.holding) {
    cameraTracker.cycle();
    cameraMenu.refreshMode();
    sfx.play("click", 0.3);
  }
  if (!gameOver && !menuLimbo && input.right.secondary.justPressed) {
    const toggled = flashlight.toggle();
    sfx.play(toggled ? "click" : "denied", 0.3);
    if (toggled && !flashlight.on) flashlightToggledOffThisRun = true;
  }

  perfStats.begin("joueur");
  player.update(deltaSeconds, input);
  if (menuLimbo && menuRoomNeedsPlacement && (!renderer.xr.isPresenting || player.heightCalibrated)) {
    mainMenu.reposition();
    menuRoomNeedsPlacement = false;
  }
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
  markerSurfaces.update(deltaSeconds, player.headWorld);
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
      achievements.bump("blackoutsTriggered");
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
    if (cadreurEvents.sighted && !wasSighted) achievements.bump("cadreurSightings");
    wasSighted = cadreurEvents.sighted;
    if (cadreurEvents.sighted) vhsOverlay.triggerTrackingLoss(0.35);
    if (cadreurEvents.nearby) vhsOverlay.triggerTrackingLoss(0.45);
    if (cadreurEvents.playerDamage > 0 && vitals.damage(cadreurEvents.playerDamage)) triggerGameOver("health");
    if (cadreurEvents.playerDamage > 0) damagedThisLevel = true;
    if (cadreurEvents.sighted) vitals.addMadness(10);
    if (cadreurEvents.watched) vitals.addMadness(deltaSeconds * 4);
    const patchEvents = corruptionPatch.update(deltaSeconds, head, camera, levelManager.depth, elapsedSeconds);
    if (patchEvents.announced) {
      triggerHapticPulse(renderer, 0.3, 120);
      atmosphere.triggerFlicker(0.25);
      vhsOverlay.triggerTrackingLoss(0.5);
    }
    player.sprintBlocked = patchEvents.onPatch;
    if (patchEvents.onPatch) {
      damagedThisLevel = true;
      vitals.addMadness(PATCH_MADNESS_PER_SECOND * deltaSeconds);
      corruption.add(deltaSeconds * 0.4);
      if (vitals.damage(PATCH_DAMAGE_PER_SECOND * deltaSeconds)) triggerGameOver("health");
    }
    perfStats.end("menaces");

    if (cadreurEvents.caught) triggerGameOver("caught");
    else if (!gameOver && levelManager.hasReachedExit(player.headWorld)) goDeeper();
    if (levelUpdate.corruptionDelta > 0) vitals.addMadness(levelUpdate.corruptionDelta * 8);
    if (levelUpdate.wallTrapJustPopped) vitals.addMadness(12);
    if (blackoutEvents.reachedPlayer) vitals.addMadness(8);
    const healthBeforeVitalsUpdate = vitals.health;
    if (vitals.update(deltaSeconds, flashlight.shining && player.movementIntensity < 0.1)) triggerGameOver("health");
    if (vitals.health < healthBeforeVitalsUpdate) damagedThisLevel = true;
    corruption.update(deltaSeconds);
  }

  camera.getWorldDirection(trackDirection);
  trackDirection.y = 0;
  if (trackDirection.lengthSq() > 1e-6) {
    trackDirection.normalize();
    trackForward.x = trackDirection.x;
    trackForward.z = trackDirection.z;
  }
  const trackReading = cameraTracker.read({
    head: player.headWorld,
    forward: trackForward,
    exit: levelManager.exitPosition,
    cadreur: cadreur.worldPosition,
    archive: loreJournal.nextFragment !== null && !archiveReadThisLevel ? levelManager.lorePagePosition : null,
    battery: flashlight.battery,
    noise: corruption.value,
  });
  // Suivre le Cadreur vide la pile de la lampe (jamais dans le niveau 0 fictif du menu).
  if (trackReading.draining && !menuLimbo) flashlight.drain(CADREUR_TRACK_DRAIN_PER_SECOND * deltaSeconds);
  const trackLabel = t(trackReading.mode === "exit" ? "hud.signalExit" : trackReading.mode === "cadreur" ? "hud.signalCadreur" : "hud.signalArchive");
  const trackAim =
    trackReading.bearing === null ? "" : trackReading.distance === null ? "--" : `${Math.round(trackReading.distance)}m`;
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
    signal: trackReading.unavailable ? 0 : trackReading.signal,
    signalLabel: trackLabel,
    signalAim: trackAim,
    debug: perfStats.readAndReset(),
  };
  perfStats.begin("effets");
  comfortVignette.update(player.movementIntensity, deltaSeconds);
  endSequence.update(deltaSeconds);
  vhsOverlay.update(elapsedSeconds, corruption.value, deltaSeconds);
  tapePlayer.update(deltaSeconds);
  updateLoreObjects(deltaSeconds);
  hud.update(deltaSeconds);
  noticeModal.update(deltaSeconds);
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
