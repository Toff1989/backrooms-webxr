import * as THREE from "three";
import ceilingBaseColorUrl from "../assets/textures/ceiling/basecolor.webp";
import ceilingNormalUrl from "../assets/textures/ceiling/normal.webp";
import ceilingRoughnessUrl from "../assets/textures/ceiling/roughness.webp";
import floorBaseColorUrl from "../assets/textures/floor/basecolor.webp";
import floorNormalUrl from "../assets/textures/floor/normal.webp";
import floorRoughnessUrl from "../assets/textures/floor/roughness.webp";
import pillarBaseColorUrl from "../assets/textures/pillar/basecolor.webp";
import pillarNormalUrl from "../assets/textures/pillar/normal.webp";
import pillarRoughnessUrl from "../assets/textures/pillar/roughness.webp";
import wallBaseColorUrl from "../assets/textures/wall/basecolor.webp";
import wallNormalUrl from "../assets/textures/wall/normal.webp";
import wallRoughnessUrl from "../assets/textures/wall/roughness.webp";
import { CHUNK_CELLS } from "../shared/constants";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Textures PBR CC0 (ambientCG.com — Carpet011, PaintedPlaster004, OfficeCeiling001,
 * Concrete034 — Creative Commons CC0 1.0, redistribution libre), en substitution aux
 * textures Poliigon (catégorie Backrooms) prévues dans la fiche projet : la licence
 * Poliigon interdit de redistribuer les fichiers sources dans un dépôt public. Déjà
 * en 1K, conforme au budget de la fiche.
 *
 * Les matériaux sont des singletons partagés par tous les chunks (streaming) : un
 * seul jeu de textures pour tout le monde généré, pas de rechargement par chunk.
 */

const textureLoader = new THREE.TextureLoader();

interface SurfaceTextureUrls {
  baseColor: string;
  normal: string;
  roughness: string;
}

interface SurfaceTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function loadSurfaceTextures(urls: SurfaceTextureUrls, repeat: number): SurfaceTextures {
  const map = textureLoader.load(urls.baseColor);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = textureLoader.load(urls.normal);
  const roughnessMap = textureLoader.load(urls.roughness);

  for (const texture of [map, normalMap, roughnessMap]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat, repeat);
    texture.anisotropy = 4;
  }

  return { map, normalMap, roughnessMap };
}

let wallMaterial: THREE.MeshStandardMaterial | null = null;
export function getWallMaterial(): THREE.MeshStandardMaterial {
  if (!wallMaterial) {
    // Un mur = une cellule (2,5 m) : chaque quad de mur fusionné porte déjà son propre UV 0..1.
    const textures = loadSurfaceTextures({ baseColor: wallBaseColorUrl, normal: wallNormalUrl, roughness: wallRoughnessUrl }, 1);
    wallMaterial = new THREE.MeshStandardMaterial(textures);
    applyVhsEffect(wallMaterial);
  }
  return wallMaterial;
}

let floorMaterial: THREE.MeshStandardMaterial | null = null;
export function getFloorMaterial(): THREE.MeshStandardMaterial {
  if (!floorMaterial) {
    // Une dalle de sol par chunk : repeat = nombre de cellules par côté de chunk.
    const textures = loadSurfaceTextures({ baseColor: floorBaseColorUrl, normal: floorNormalUrl, roughness: floorRoughnessUrl }, CHUNK_CELLS);
    floorMaterial = new THREE.MeshStandardMaterial(textures);
    applyVhsEffect(floorMaterial);
  }
  return floorMaterial;
}

let ceilingMaterial: THREE.MeshStandardMaterial | null = null;
export function getCeilingMaterial(): THREE.MeshStandardMaterial {
  if (!ceilingMaterial) {
    const textures = loadSurfaceTextures({ baseColor: ceilingBaseColorUrl, normal: ceilingNormalUrl, roughness: ceilingRoughnessUrl }, CHUNK_CELLS);
    ceilingMaterial = new THREE.MeshStandardMaterial(textures);
    applyVhsEffect(ceilingMaterial);
  }
  return ceilingMaterial;
}

let pillarMaterial: THREE.MeshStandardMaterial | null = null;
export function getPillarMaterial(): THREE.MeshStandardMaterial {
  if (!pillarMaterial) {
    const textures = loadSurfaceTextures({ baseColor: pillarBaseColorUrl, normal: pillarNormalUrl, roughness: pillarRoughnessUrl }, 1);
    pillarMaterial = new THREE.MeshStandardMaterial(textures);
    applyVhsEffect(pillarMaterial);
  }
  return pillarMaterial;
}

let neonMaterial: THREE.MeshStandardMaterial | null = null;
export function getNeonMaterial(): THREE.MeshStandardMaterial {
  if (!neonMaterial) {
    neonMaterial = new THREE.MeshStandardMaterial({
      color: 0xfff7d6,
      emissive: 0xfff2b0,
      emissiveIntensity: 1.4,
    });
    applyVhsEffect(neonMaterial);
  }
  return neonMaterial;
}
