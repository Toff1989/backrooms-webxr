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
 * Le papier peint à motif chevron (référence fournie) n'existe pas tel quel en CC0 :
 * généré par canvas (`createWallBaseColorTexture`), en réutilisant le relief/la
 * rugosité de la vraie photo PaintedPlaster004 pour garder un grain de surface réaliste.
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
  };
}

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Contexte 2D indisponible pour la génération de texture");
  return { canvas, ctx };
}

/** PRNG déterministe (mulberry32) pour des textures reproductibles. */
function createRandom(seed: number): () => number {
  let state = seed;
  return function random(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Papier peint à motif chevron (référence fournie par l'utilisateur) : bandes
 * verticales fines + chevrons empilés répétés, jaune olive délavé. Dessiné en canvas
 * plutôt que photographié — ce motif précis n'existe pas en texture CC0 libre.
 */
function createWallBaseColorTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = createCanvas(size);
  const random = createRandom(1337);

  ctx.fillStyle = "#c3b656";
  ctx.fillRect(0, 0, size, size);

  // Bandes verticales fines (pinstripes).
  const columnSpacing = 64;
  ctx.globalAlpha = 0.22;
  for (let x = 0; x < size; x += columnSpacing) {
    ctx.fillStyle = "#a89642";
    ctx.fillRect(x, 0, 4, size);
  }
  ctx.globalAlpha = 1;

  // Chevrons empilés dans chaque bande, avec un petit trait sous chacun.
  const rowSpacing = 64;
  ctx.strokeStyle = "rgba(110, 96, 36, 0.55)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let cx = columnSpacing / 2; cx < size; cx += columnSpacing) {
    for (let cy = 0; cy < size; cy += rowSpacing) {
      ctx.beginPath();
      ctx.moveTo(cx - 14, cy + 26);
      ctx.lineTo(cx, cy + 8);
      ctx.lineTo(cx + 14, cy + 26);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - 8, cy + 38);
      ctx.lineTo(cx + 8, cy + 38);
      ctx.stroke();
    }
  }

  // Grain léger pour casser la répétition parfaite du motif.
  for (let i = 0; i < 2500; i++) {
    const shade = 40 + random() * 60;
    ctx.fillStyle = `rgba(${shade | 0}, ${(shade * 0.9) | 0}, ${(shade * 0.35) | 0}, ${0.03 + random() * 0.05})`;
    ctx.fillRect(random() * size, random() * size, 1, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const CEILING_LIGHT_BLOCK_CELLS = 2;
const CEILING_LIGHT_COLOR = "#fff2b0";

/**
 * Dalles lumineuses tissées dans la texture du plafond (pas des objets 3D séparés) :
 * un panneau émissif par bloc de `CEILING_LIGHT_BLOCK_CELLS` cellules, utilisé comme
 * `emissiveMap` avec son propre `repeat`, indépendant du `map`/`normalMap` de la photo.
 */
function createCeilingEmissiveTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = createCanvas(size);

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);

  const panelWidth = size * 0.42;
  const panelHeight = size * 0.12;
  const x = (size - panelWidth) / 2;
  const y = (size - panelHeight) / 2;

  // Bord doux (diffuseur) : dégradé plutôt qu'un rectangle net.
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, panelWidth * 0.75);
  gradient.addColorStop(0, CEILING_LIGHT_COLOR);
  gradient.addColorStop(0.7, CEILING_LIGHT_COLOR);
  gradient.addColorStop(1, "rgba(255, 242, 176, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(x - 20, y - 20, panelWidth + 40, panelHeight + 40);

  ctx.fillStyle = CEILING_LIGHT_COLOR;
  ctx.fillRect(x, y, panelWidth, panelHeight);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const repeat = CHUNK_CELLS / CEILING_LIGHT_BLOCK_CELLS;
  texture.repeat.set(repeat, repeat);
  return texture;
}

let wallMaterial: THREE.MeshStandardMaterial | null = null;
export function getWallMaterial(): THREE.MeshStandardMaterial {
  if (!wallMaterial) {
    // Un mur = une cellule (2,5 m) : chaque quad de mur fusionné porte déjà son propre UV 0..1.
    wallMaterial = new THREE.MeshStandardMaterial({
      map: createWallBaseColorTexture(),
      normalMap: loadTexture(wallNormalUrl, THREE.NoColorSpace, 1),
      roughnessMap: loadTexture(wallRoughnessUrl, THREE.NoColorSpace, 1),
    });
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
    ceilingMaterial = new THREE.MeshStandardMaterial({
      ...textures,
      emissive: new THREE.Color(CEILING_LIGHT_COLOR),
      emissiveMap: createCeilingEmissiveTexture(),
      emissiveIntensity: 1.6,
    });
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
