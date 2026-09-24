import * as THREE from "three";
import ceilingAoUrl from "../assets/textures/ceiling/ao.webp";
import ceilingBaseColorUrl from "../assets/textures/ceiling/basecolor.webp";
import ceilingDisplacementUrl from "../assets/textures/ceiling/displacement.webp";
import ceilingEmissionUrl from "../assets/textures/ceiling/emission.webp";
import ceilingNormalUrl from "../assets/textures/ceiling/normal.webp";
import ceilingRoughnessUrl from "../assets/textures/ceiling/roughness.webp";
import floorAoUrl from "../assets/textures/floor/ao.webp";
import floorBaseColorUrl from "../assets/textures/floor/basecolor.webp";
import floorDisplacementUrl from "../assets/textures/floor/displacement.webp";
import floorNormalUrl from "../assets/textures/floor/normal.webp";
import floorRoughnessUrl from "../assets/textures/floor/roughness.webp";
import pillarAoUrl from "../assets/textures/pillar/ao.webp";
import pillarBaseColorUrl from "../assets/textures/pillar/basecolor.webp";
import pillarDisplacementUrl from "../assets/textures/pillar/displacement.webp";
import pillarNormalUrl from "../assets/textures/pillar/normal.webp";
import pillarRoughnessUrl from "../assets/textures/pillar/roughness.webp";
import wallAoUrl from "../assets/textures/wall/ao.webp";
import wallBaseColorUrl from "../assets/textures/wall/basecolor.webp";
import wallDisplacementUrl from "../assets/textures/wall/displacement.webp";
import wallNormalUrl from "../assets/textures/wall/normal.webp";
import wallRoughnessUrl from "../assets/textures/wall/roughness.webp";
import { CHUNK_CELLS } from "../shared/constants";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Textures Poliigon (catégorie Backrooms, gratuites sur le site — fiche projet) :
 * basecolor/normal/roughness/ao/displacement (+ emission pour le plafond),
 * redimensionnées 1K et converties en WebP. Commitées normalement dans le dépôt.
 *
 * Les matériaux sont des singletons partagés par tous les chunks (streaming) : un
 * seul jeu de textures pour tout le monde généré, pas de rechargement par chunk.
 */

const textureLoader = new THREE.TextureLoader();

interface SurfaceTextureUrls {
  baseColor: string;
  normal: string;
  roughness: string;
  ao: string;
  displacement: string;
}

interface SurfaceTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap: THREE.Texture;
  displacementMap: THREE.Texture;
}

function loadTexture(url: string, colorSpace: THREE.ColorSpace, repeat: number): THREE.Texture {
  const texture = textureLoader.load(url);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 4;
  return texture;
}

function loadSurfaceTextures(urls: SurfaceTextureUrls, repeat: number): SurfaceTextures {
  return {
    map: loadTexture(urls.baseColor, THREE.SRGBColorSpace, repeat),
    normalMap: loadTexture(urls.normal, THREE.NoColorSpace, repeat),
    roughnessMap: loadTexture(urls.roughness, THREE.NoColorSpace, repeat),
    // channel 0 par défaut : réutilise le même jeu d'UV que map/normalMap, pas besoin d'un uv2.
    aoMap: loadTexture(urls.ao, THREE.NoColorSpace, repeat),
    displacementMap: loadTexture(urls.displacement, THREE.NoColorSpace, repeat),
  };
}

/**
 * Le displacement déplace les sommets le long de leur normale : sur nos géométries
 * (voir `chunkMesh.ts`, quads/box subdivisés), on garde une échelle faible et un biais
 * négatif pour rester un simple relief de surface (pas de pics qui traversent les
 * boîtes de collision AABB, qui elles restent plates).
 */
interface DisplacementSettings {
  displacementScale: number;
  displacementBias: number;
}

const WALL_DISPLACEMENT: DisplacementSettings = { displacementScale: 0.035, displacementBias: -0.02 };
const FLOOR_DISPLACEMENT: DisplacementSettings = { displacementScale: 0.025, displacementBias: -0.02 };
const CEILING_DISPLACEMENT: DisplacementSettings = { displacementScale: 0.02, displacementBias: -0.01 };
const PILLAR_DISPLACEMENT: DisplacementSettings = { displacementScale: 0.03, displacementBias: -0.018 };

let wallMaterial: THREE.MeshStandardMaterial | null = null;
export function getWallMaterial(): THREE.MeshStandardMaterial {
  if (!wallMaterial) {
    // Un mur = une cellule (2,5 m) : chaque quad de mur fusionné porte déjà son propre UV 0..1.
    const textures = loadSurfaceTextures(
      { baseColor: wallBaseColorUrl, normal: wallNormalUrl, roughness: wallRoughnessUrl, ao: wallAoUrl, displacement: wallDisplacementUrl },
      1,
    );
    wallMaterial = new THREE.MeshStandardMaterial({ ...textures, ...WALL_DISPLACEMENT });
    applyVhsEffect(wallMaterial);
  }
  return wallMaterial;
}

let floorMaterial: THREE.MeshStandardMaterial | null = null;
export function getFloorMaterial(): THREE.MeshStandardMaterial {
  if (!floorMaterial) {
    // Une dalle de sol par chunk : repeat = nombre de cellules par côté de chunk.
    const textures = loadSurfaceTextures(
      { baseColor: floorBaseColorUrl, normal: floorNormalUrl, roughness: floorRoughnessUrl, ao: floorAoUrl, displacement: floorDisplacementUrl },
      CHUNK_CELLS,
    );
    floorMaterial = new THREE.MeshStandardMaterial({ ...textures, ...FLOOR_DISPLACEMENT });
    applyVhsEffect(floorMaterial);
  }
  return floorMaterial;
}

let ceilingMaterial: THREE.MeshStandardMaterial | null = null;
export function getCeilingMaterial(): THREE.MeshStandardMaterial {
  if (!ceilingMaterial) {
    const textures = loadSurfaceTextures(
      { baseColor: ceilingBaseColorUrl, normal: ceilingNormalUrl, roughness: ceilingRoughnessUrl, ao: ceilingAoUrl, displacement: ceilingDisplacementUrl },
      CHUNK_CELLS,
    );
    // Vraie carte d'émission Poliigon (dalles lumineuses déjà présentes dans la photo du
    // plafond) : pas d'objet 3D séparé, et alignée pixel pour pixel avec le carrelage.
    const emissiveMap = loadTexture(ceilingEmissionUrl, THREE.SRGBColorSpace, CHUNK_CELLS);
    ceilingMaterial = new THREE.MeshStandardMaterial({
      ...textures,
      ...CEILING_DISPLACEMENT,
      emissive: new THREE.Color(0xffffff),
      emissiveMap,
      emissiveIntensity: 2.2,
    });
    applyVhsEffect(ceilingMaterial, { ceilingLights: true });
  }
  return ceilingMaterial;
}

let pillarMaterial: THREE.MeshStandardMaterial | null = null;
export function getPillarMaterial(): THREE.MeshStandardMaterial {
  if (!pillarMaterial) {
    const textures = loadSurfaceTextures(
      { baseColor: pillarBaseColorUrl, normal: pillarNormalUrl, roughness: pillarRoughnessUrl, ao: pillarAoUrl, displacement: pillarDisplacementUrl },
      1,
    );
    pillarMaterial = new THREE.MeshStandardMaterial({ ...textures, ...PILLAR_DISPLACEMENT });
    applyVhsEffect(pillarMaterial);
  }
  return pillarMaterial;
}
