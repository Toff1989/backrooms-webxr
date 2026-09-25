import * as THREE from "three";
import alarmClockUrl from "../assets/models/collectibles/alarmClock.glb";
import binocularsUrl from "../assets/models/collectibles/binoculars.glb";
import bleachUrl from "../assets/models/collectibles/bleach.glb";
import brassPotUrl from "../assets/models/collectibles/brassPot.glb";
import canUrl from "../assets/models/collectibles/can.glb";
import cigaretteCaseUrl from "../assets/models/collectibles/cigaretteCase.glb";
import cigarettePackUrl from "../assets/models/collectibles/cigarettePack.glb";
import circuitBoardUrl from "../assets/models/collectibles/circuitBoard.glb";
import cleanerUrl from "../assets/models/collectibles/cleaner.glb";
import cleanerTinUrl from "../assets/models/collectibles/cleanerTin.glb";
import combWrenchUrl from "../assets/models/collectibles/combWrench.glb";
import compassUrl from "../assets/models/collectibles/compass.glb";
import digitalWatchUrl from "../assets/models/collectibles/digitalWatch.glb";
import drainCleanerUrl from "../assets/models/collectibles/drainCleaner.glb";
import dustpanUrl from "../assets/models/collectibles/dustpan.glb";
import footballUrl from "../assets/models/collectibles/football.glb";
import gamepadUrl from "../assets/models/collectibles/gamepad.glb";
import hammerUrl from "../assets/models/collectibles/hammer.glb";
import kettleUrl from "../assets/models/collectibles/kettle.glb";
import lightbulbUrl from "../assets/models/collectibles/lightbulb.glb";
import lighterUrl from "../assets/models/collectibles/lighter.glb";
import lubricantUrl from "../assets/models/collectibles/lubricant.glb";
import magnifyingGlassUrl from "../assets/models/collectibles/magnifyingGlass.glb";
import medicalTapeUrl from "../assets/models/collectibles/medicalTape.glb";
import multimeterUrl from "../assets/models/collectibles/multimeter.glb";
import photoUrl from "../assets/models/collectibles/photo.glb";
import pliersUrl from "../assets/models/collectibles/pliers.glb";
import plungerUrl from "../assets/models/collectibles/plunger.glb";
import screwdriverUrl from "../assets/models/collectibles/screwdriver.glb";
import screwdriverFlatUrl from "../assets/models/collectibles/screwdriverFlat.glb";
import securityCameraUrl from "../assets/models/collectibles/securityCamera.glb";
import spacecraftInstrumentUrl from "../assets/models/collectibles/spacecraftInstrument.glb";
import tapeUrl from "../assets/models/collectibles/tape.glb";
import toolboxUrl from "../assets/models/collectibles/toolbox.glb";
import toyUrl from "../assets/models/collectibles/toy.glb";
import vaseUrl from "../assets/models/collectibles/vase.glb";
import videoCameraUrl from "../assets/models/collectibles/videoCamera.glb";
import wallClockUrl from "../assets/models/collectibles/wallClock.glb";
import watchUrl from "../assets/models/collectibles/watch.glb";
import woodenSpoonUrl from "../assets/models/collectibles/woodenSpoon.glb";
import wrenchUrl from "../assets/models/collectibles/wrench.glb";
import type { CollectibleKind } from "../shared/collectibles";
import { loadTemplateModel } from "./gltfLoader";

/**
 * Objets de collection (fiche projet étape 6) : vrais modèles CC0 distincts (Poly
 * Haven), décimés + compressés Draco + textures WebP via gltf-transform — même pipeline
 * que `propLoader.ts`. Un seul chargement par type, les instances suivantes clonent la
 * hiérarchie en partageant géométrie/matériaux.
 */
const COLLECTIBLE_URLS: Record<CollectibleKind, string> = {
  photo: photoUrl,
  can: canUrl,
  toy: toyUrl,
  wrench: wrenchUrl,
  alarmClock: alarmClockUrl,
  cleaner: cleanerUrl,
  bleach: bleachUrl,
  cigaretteCase: cigaretteCaseUrl,
  cigarettePack: cigarettePackUrl,
  circuitBoard: circuitBoardUrl,
  cleanerTin: cleanerTinUrl,
  combWrench: combWrenchUrl,
  hammer: hammerUrl,
  digitalWatch: digitalWatchUrl,
  football: footballUrl,
  drainCleaner: drainCleanerUrl,
  dustpan: dustpanUrl,
  screwdriverFlat: screwdriverFlatUrl,
  gamepad: gamepadUrl,
  lightbulb: lightbulbUrl,
  lubricant: lubricantUrl,
  medicalTape: medicalTapeUrl,
  pliers: pliersUrl,
  plunger: plungerUrl,
  screwdriver: screwdriverUrl,
  woodenSpoon: woodenSpoonUrl,
  watch: watchUrl,
  binoculars: binocularsUrl,
  brassPot: brassPotUrl,
  magnifyingGlass: magnifyingGlassUrl,
  toolbox: toolboxUrl,
  multimeter: multimeterUrl,
  securityCamera: securityCameraUrl,
  kettle: kettleUrl,
  lighter: lighterUrl,
  wallClock: wallClockUrl,
  vase: vaseUrl,
  spacecraftInstrument: spacecraftInstrumentUrl,
  compass: compassUrl,
};

/**
 * Modèles réutilisés hors du pool de collection normal (retirés de `CollectibleKind`, voir
 * `shared/collectibles.ts`) : la cassette pour la bande perdue "audio" (`world/lorePage.ts`),
 * et la caméra vidéo pour la tête du Cadreur (`world/cadreurModel.ts`) — seuls appelants restants.
 */
export type SpecialModelKind = "cassette" | "cadreurHead";
const SPECIAL_MODEL_URLS: Record<SpecialModelKind, string> = {
  cassette: tapeUrl,
  cadreurHead: videoCameraUrl,
};

const templateCache = new Map<CollectibleKind | SpecialModelKind, Promise<THREE.Object3D>>();

function loadTemplate(kind: CollectibleKind | SpecialModelKind): Promise<THREE.Object3D> {
  let cached = templateCache.get(kind);
  if (cached) return cached;
  cached = loadTemplateModel(kind in SPECIAL_MODEL_URLS ? SPECIAL_MODEL_URLS[kind as SpecialModelKind] : COLLECTIBLE_URLS[kind as CollectibleKind]);
  templateCache.set(kind, cached);
  return cached;
}

/** Instancie un objet de collection ; géométrie et matériaux restent partagés avec le template (retourné pour la forme physique). */
export async function spawnCollectibleModel(kind: CollectibleKind | SpecialModelKind): Promise<{ model: THREE.Object3D; template: THREE.Object3D }> {
  const template = await loadTemplate(kind);
  return { model: template.clone(true), template };
}
