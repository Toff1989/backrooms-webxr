/**
 * Rendu visuel du Cadreur (le monstre) en conditions de jeu réelles : vrai rig
 * (`loadCadreur`/`cadreurModel.ts`, mannequin + tête-caméra + effet VHS sur les matériaux), vraie
 * lampe torche (mêmes réglages que `flashlight.ts` : SpotLight 30°, 18 m de portée), même fond/
 * brouillard que `main.ts` (BACKGROUND_COLOR, FogExp2 0.05), et vrai overlay VHS de l'écran
 * (`VhsOverlay`) plutôt qu'un fond neutre de banc d'essai — ce test ne vérifie pas une interaction
 * (pas de FaceCanvas ici), juste à quoi ressemble le monstre tel qu'on le rencontre en jeu.
 *
 * Trois étapes, qui reproduisent les trois régimes de vitesse réels du Cadreur (voir cadreur.ts) :
 * - WATCHED : sous les yeux du joueur, éclairé par la lampe → il avance au ralenti (0,6 m/s).
 * - FROZEN : pris en pleine face dans le faisceau, de près → figé (vitesse 0), LED "REC" visible.
 * - HUNTING : hors de vue, dans le noir (lampe éteinte) → il fonce (vitesse "hunting" ~1,75 m/s).
 *
 * Socle commun (renderer, contrôleur d'étapes) dans support/harness.ts ; scène propre à ce test
 * (celle de harness.ts est neutre/éclairée, pensée pour juger un matériau, pas une ambiance).
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/cadreur-render.html.
 * Ou en headless : `node scripts/render-test.mjs cadreur-render`.
 */
import * as THREE from "three";
import { loadCadreur } from "../../src/world/cadreurModel";
import { VhsOverlay } from "../../src/player/vhsOverlay";
import { createLogger, createRenderer, createStageController } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["WATCHED", "FROZEN", "HUNTING", "NECK_FRONT", "NECK_34", "NECK_SIDE", "NECK_BACK"]);

// Mêmes valeurs que main.ts (fond/brouillard) et flashlight.ts (lampe torche).
const BACKGROUND_COLOR = 0x0a0805;
const FLASHLIGHT_COLOR = 0xfff1d6;
const FLASHLIGHT_RANGE = 18;
const FLASHLIGHT_ANGLE = THREE.MathUtils.degToRad(30);
const FLASHLIGHT_PENUMBRA = 0.6;
const FLASHLIGHT_DECAY = 1.3;
const FLASHLIGHT_INTENSITY = 26;
// Mêmes régimes de vitesse que cadreur.ts (WATCHED_SPEED, hunting à profondeur ~5).
const WATCHED_SPEED = 0.6;
const HUNTING_SPEED = Math.min(2.3, 1.25 + 5 * 0.1);

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  const camera = new THREE.PerspectiveCamera(70, canvas.width / canvas.height, 0.03, 60);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND_COLOR);
  scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.05);
  scene.add(new THREE.HemisphereLight(0xfff3cf, 0x171512, 0.9));
  scene.add(new THREE.AmbientLight(0xfff0c0, 0.25));

  const flashlight = new THREE.SpotLight(FLASHLIGHT_COLOR, 0, FLASHLIGHT_RANGE, FLASHLIGHT_ANGLE, FLASHLIGHT_PENUMBRA, FLASHLIGHT_DECAY);
  flashlight.position.set(0, -0.08, 0);
  flashlight.target.position.set(0, -0.3, -3);
  camera.add(flashlight, flashlight.target);
  scene.add(camera);

  const vhs = new VhsOverlay(camera);

  log("Chargement du rig réel (loadCadreur) : mannequin Mixamo + tête-caméra + effet VHS sur les matériaux…");
  const rig = await loadCadreur({ suit: true });
  scene.add(rig.root);
  log("Rig chargé.");

  const settle = (speed: number, lookAt: THREE.Vector3, steps = 30): void => {
    // Plusieurs pas de simulation (pas juste une frame) pour laisser la démarche/le regard de la
    // tête-caméra se stabiliser sur la pose voulue, comme après quelques frames en jeu.
    for (let i = 0; i < steps; i++) rig.update(1 / 30, speed, lookAt);
  };

  const renderFrame = (elapsed: number): void => {
    vhs.update(elapsed, 0.1, 1 / 30);
    renderer.render(scene, camera);
  };

  // --- WATCHED : à quelques mètres, sous les yeux du joueur, lampe allumée ---
  rig.root.position.set(0, 0, -4.5);
  rig.root.rotation.y = Math.PI;
  flashlight.intensity = FLASHLIGHT_INTENSITY;
  camera.position.set(0, 1.65, 0);
  camera.lookAt(rig.root.position.x, 1.4, rig.root.position.z);
  settle(WATCHED_SPEED, camera.position);
  renderFrame(1);
  log(`Rendu 'observé' (vitesse ${WATCHED_SPEED} m/s, lampe allumée) affiché.`);
  await stages.enter("WATCHED");

  // --- FROZEN : pris de près en pleine face dans le faisceau ---
  rig.root.position.set(0, 0, -1.8);
  camera.lookAt(rig.root.position.x, 1.5, rig.root.position.z);
  settle(0, camera.position, 45);
  renderFrame(2);
  log("Rendu 'figé dans le faisceau' (vitesse 0, LED REC) affiché.");
  await stages.enter("FROZEN");

  // --- HUNTING : hors de vue, dans le noir, lampe éteinte, il fonce ---
  flashlight.intensity = 0;
  rig.root.position.set(1.2, 0, -6);
  rig.root.rotation.y = Math.PI + 0.4;
  camera.position.set(0, 1.65, 0);
  camera.lookAt(0, 1.2, -8);
  settle(HUNTING_SPEED, new THREE.Vector3(0, 1.2, -8));
  renderFrame(3);
  log(`Rendu 'chasse dans le noir' (vitesse ${HUNTING_SPEED.toFixed(2)} m/s, lampe éteinte) affiché.`);
  await stages.enter("HUNTING");

  // --- Gros plan sur la jonction cou / tête-caméra (face, trois-quarts, profil) ---
  flashlight.intensity = FLASHLIGHT_INTENSITY;
  rig.root.position.set(0, 0, -1.2);
  rig.root.rotation.y = 0;
  settle(0, new THREE.Vector3(0, 1.8, 0), 45);
  const stemObj = rig.root.getObjectByName("cadreurNeck");
  if (stemObj) log(`cou: ${JSON.stringify(new THREE.Box3().setFromObject(stemObj))} scale ${JSON.stringify(stemObj.getWorldScale(new THREE.Vector3()))}`);
  const neckTarget = new THREE.Vector3(0, 1.8, -1.2);
  const shots: Array<[string, THREE.Vector3]> = [
    ["NECK_FRONT", new THREE.Vector3(0, 1.85, -0.35)],
    ["NECK_34", new THREE.Vector3(0.6, 1.9, -0.65)],
    ["NECK_SIDE", new THREE.Vector3(0.8, 1.85, -1.2)],
    ["NECK_BACK", new THREE.Vector3(0.1, 1.9, -2.2)],
  ];
  let shotTime = 4;
  for (const [name, position] of shots) {
    camera.position.copy(position);
    camera.lookAt(neckTarget);
    renderFrame(shotTime++);
    await stages.enter(name);
  }
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
