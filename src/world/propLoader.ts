import * as THREE from "three";
import cabinetUrl from "../assets/models/cabinet.glb";
import chairUrl from "../assets/models/chair.glb";
import officeDeskUrl from "../assets/models/officedesk.glb";
import armChairUrl from "../assets/models/props/armChair.glb";
import bookshelfUrl from "../assets/models/props/bookshelf.glb";
import cardboardBoxUrl from "../assets/models/props/cardboardBox.glb";
import chalkboardUrl from "../assets/models/props/chalkboard.glb";
import coffeeTableUrl from "../assets/models/props/coffeeTable.glb";
import metalShelvesUrl from "../assets/models/props/metalShelves.glb";
import metalStoolUrl from "../assets/models/props/metalStool.glb";
import monoblocChairUrl from "../assets/models/props/monoblocChair.glb";
import plasticCrateUrl from "../assets/models/props/plasticCrate.glb";
import pottedPlantUrl from "../assets/models/props/pottedPlant.glb";
import sofaUrl from "../assets/models/props/sofa.glb";
import storageCartUrl from "../assets/models/props/storageCart.glb";
import televisionUrl from "../assets/models/props/television.glb";
import wetFloorSignUrl from "../assets/models/props/wetFloorSign.glb";
import schoolDeskUrl from "../assets/models/schooldesk.glb";
import type { PropKind } from "../shared/props";
import { loadTemplateModel } from "./gltfLoader";

/**
 * Mobilier décoratif : modèles CC0 (Poly Haven), décimés + compressés Draco + textures WebP
 * 512 px via glTF-Transform. Un seul chargement par type de meuble (`loadTemplate`), toutes
 * les instances suivantes clonent la hiérarchie en partageant géométrie/matériaux (pas de
 * recopie GPU par meuble placé).
 */
const PROP_URLS: Record<PropKind, string> = {
  chair: chairUrl,
  schoolDesk: schoolDeskUrl,
  officeDesk: officeDeskUrl,
  cabinet: cabinetUrl,
  monoblocChair: monoblocChairUrl,
  armChair: armChairUrl,
  sofa: sofaUrl,
  coffeeTable: coffeeTableUrl,
  metalStool: metalStoolUrl,
  metalShelves: metalShelvesUrl,
  bookshelf: bookshelfUrl,
  storageCart: storageCartUrl,
  chalkboard: chalkboardUrl,
  cardboardBox: cardboardBoxUrl,
  plasticCrate: plasticCrateUrl,
  wetFloorSign: wetFloorSignUrl,
  television: televisionUrl,
  pottedPlant: pottedPlantUrl,
};

const templateCache = new Map<PropKind, Promise<THREE.Object3D>>();

function loadTemplate(kind: PropKind): Promise<THREE.Object3D> {
  let cached = templateCache.get(kind);
  if (cached) return cached;
  cached = loadTemplateModel(PROP_URLS[kind]);
  templateCache.set(kind, cached);
  return cached;
}

/** Instancie un meuble ; géométrie et matériaux restent partagés avec le template (retourné pour la forme physique). */
export async function spawnProp(kind: PropKind): Promise<{ model: THREE.Object3D; template: THREE.Object3D }> {
  const template = await loadTemplate(kind);
  return { model: template.clone(true), template };
}
