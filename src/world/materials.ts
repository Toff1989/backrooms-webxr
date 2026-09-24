import * as THREE from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import ceilingBaseColorUrl from "../assets/textures/ceiling/basecolor.ktx2";
import ceilingEmissionUrl from "../assets/textures/ceiling/emission.ktx2";
import ceilingNormalUrl from "../assets/textures/ceiling/normal.ktx2";
import ceilingOrmUrl from "../assets/textures/ceiling/orm.ktx2";
import floorBaseColorUrl from "../assets/textures/floor/basecolor.ktx2";
import floorNormalUrl from "../assets/textures/floor/normal.ktx2";
import floorOrmUrl from "../assets/textures/floor/orm.ktx2";
import pillarBaseColorUrl from "../assets/textures/pillar/basecolor.ktx2";
import pillarDisplacementUrl from "../assets/textures/pillar/displacement.ktx2";
import pillarNormalUrl from "../assets/textures/pillar/normal.ktx2";
import pillarOrmUrl from "../assets/textures/pillar/orm.ktx2";
import wallBaseColorUrl from "../assets/textures/wall/basecolor.ktx2";
import wallDisplacementUrl from "../assets/textures/wall/displacement.ktx2";
import wallNormalUrl from "../assets/textures/wall/normal.ktx2";
import wallOrmUrl from "../assets/textures/wall/orm.ktx2";
import { CHUNK_CELLS, STREAM_RADIUS_CHUNKS } from "../shared/constants";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Textures Poliigon (catégorie Backrooms, CC0) compressées en KTX2/Basis (fiche projet :
 * "textures 1K max en KTX2") : transcodées au chargement vers le format GPU natif (ASTC sur
 * Quest), ~4 à 8× moins de mémoire vidéo que des PNG/WebP décompressés. Sources et pipeline :
 * `assets-src/textures/` et `scripts/convert-textures.py`.
 *
 * AO (canal R) et roughness (canal G) sont empaquetées dans une seule texture "ORM". Sol et
 * plafond n'ont ni AO ni displacement : relief invisible à cette échelle.
 *
 * Les matériaux sont des singletons partagés par tous les chunks : un seul jeu de textures
 * pour tout le monde généré. `initMaterials` doit être attendu avant de construire le monde.
 */

/** Côté (en chunks) du plan unique de sol/plafond (voir `floorCeiling.ts`) : la zone de streaming. */
export const SURFACE_CHUNKS = STREAM_RADIUS_CHUNKS * 2 + 1;
/** Côté (en cellules) : `repeat` des textures sol/plafond (une tuile par cellule). */
export const SURFACE_CELLS = SURFACE_CHUNKS * CHUNK_CELLS;

interface SurfaceTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap?: THREE.Texture;
  displacementMap?: THREE.Texture;
}

let ktx2Loader: KTX2Loader | null = null;
const loaded = new Map<string, THREE.Texture>();

async function loadTexture(url: string, colorSpace: THREE.ColorSpace): Promise<void> {
  const texture = await ktx2Loader!.loadAsync(url);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  loaded.set(url, texture);
}

/** Précharge toutes les textures (à attendre avant la construction du premier level). */
export async function initMaterials(renderer: THREE.WebGLRenderer): Promise<void> {
  ktx2Loader = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);
  const srgb = [wallBaseColorUrl, floorBaseColorUrl, ceilingBaseColorUrl, pillarBaseColorUrl, ceilingEmissionUrl];
  const linear = [
    wallNormalUrl, wallOrmUrl, wallDisplacementUrl,
    floorNormalUrl, floorOrmUrl,
    ceilingNormalUrl, ceilingOrmUrl,
    pillarNormalUrl, pillarOrmUrl, pillarDisplacementUrl,
  ];
  await Promise.all([
    ...srgb.map((url) => loadTexture(url, THREE.SRGBColorSpace)),
    ...linear.map((url) => loadTexture(url, THREE.NoColorSpace)),
  ]);
  ktx2Loader.dispose();
}

function texture(url: string, repeat: number): THREE.Texture {
  const source = loaded.get(url);
  if (!source) throw new Error(`Texture non préchargée : ${url} (initMaterials doit être attendu)`);
  const result = repeat === 1 ? source : source.clone();
  result.repeat.set(repeat, repeat);
  return result;
}

function surface(baseColor: string, normal: string, orm: string, repeat: number, withAo: boolean): SurfaceTextures {
  const ormTexture = texture(orm, repeat);
  return {
    map: texture(baseColor, repeat),
    normalMap: texture(normal, repeat),
    roughnessMap: ormTexture,
    ...(withAo ? { aoMap: ormTexture } : {}),
  };
}

/**
 * Le displacement déplace les sommets le long de leur normale : on garde une échelle faible
 * et un biais négatif pour rester un simple relief de surface (pas de pics qui traversent les
 * boîtes de collision, qui elles restent plates). Murs et piliers seulement.
 */
const WALL_DISPLACEMENT = { displacementScale: 0.035, displacementBias: -0.02 };
const PILLAR_DISPLACEMENT = { displacementScale: 0.03, displacementBias: -0.018 };

let wallMaterial: THREE.MeshStandardMaterial | null = null;
export function getWallMaterial(): THREE.MeshStandardMaterial {
  if (!wallMaterial) {
    // Une tuile de papier peint = une cellule (2,5 m) de large, toute la hauteur : UV projetés
    // depuis la position monde (voir `boxProjection`), identiques sur les murs, les murs-pièges
    // et le bloc de la sortie, quelle que soit la longueur du mur.
    wallMaterial = new THREE.MeshStandardMaterial({
      ...surface(wallBaseColorUrl, wallNormalUrl, wallOrmUrl, 1, true),
      displacementMap: texture(wallDisplacementUrl, 1),
      ...WALL_DISPLACEMENT,
    });
    applyVhsEffect(wallMaterial, { boxProjection: true });
  }
  return wallMaterial;
}

let floorMaterial: THREE.MeshStandardMaterial | null = null;
export function getFloorMaterial(): THREE.MeshStandardMaterial {
  if (!floorMaterial) {
    // Un seul plan de sol pour toute la zone chargée : repeat = nombre de cellules par côté.
    floorMaterial = new THREE.MeshStandardMaterial(surface(floorBaseColorUrl, floorNormalUrl, floorOrmUrl, SURFACE_CELLS, false));
    applyVhsEffect(floorMaterial, { zoneLightPerPixel: true });
  }
  return floorMaterial;
}

let ceilingMaterial: THREE.MeshStandardMaterial | null = null;
export function getCeilingMaterial(): THREE.MeshStandardMaterial {
  if (!ceilingMaterial) {
    // Vraie carte d'émission Poliigon (dalles lumineuses déjà présentes dans la photo du
    // plafond) : pas d'objet 3D séparé, et alignée pixel pour pixel avec le carrelage.
    ceilingMaterial = new THREE.MeshStandardMaterial({
      ...surface(ceilingBaseColorUrl, ceilingNormalUrl, ceilingOrmUrl, SURFACE_CELLS, false),
      emissiveMap: texture(ceilingEmissionUrl, SURFACE_CELLS),
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 2.2,
    });
    applyVhsEffect(ceilingMaterial, { ceilingLights: true, zoneLightPerPixel: true });
  }
  return ceilingMaterial;
}

let pillarMaterial: THREE.MeshStandardMaterial | null = null;
export function getPillarMaterial(): THREE.MeshStandardMaterial {
  if (!pillarMaterial) {
    pillarMaterial = new THREE.MeshStandardMaterial({
      ...surface(pillarBaseColorUrl, pillarNormalUrl, pillarOrmUrl, 1, true),
      displacementMap: texture(pillarDisplacementUrl, 1),
      ...PILLAR_DISPLACEMENT,
    });
    applyVhsEffect(pillarMaterial, { boxProjection: true });
  }
  return pillarMaterial;
}
