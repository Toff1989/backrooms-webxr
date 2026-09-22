import * as THREE from "three";

/**
 * Textures procédurales de substitution (placeholders) en attendant l'intégration
 * des textures Poliigon (catégorie Backrooms) prévues dans la fiche projet.
 */

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

function finalizeTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function createWallTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = createCanvas(size);
  const random = createRandom(1337);

  ctx.fillStyle = "#b9a14a";
  ctx.fillRect(0, 0, size, size);

  ctx.globalAlpha = 0.15;
  for (let x = 0; x < size; x += 6) {
    ctx.fillStyle = random() > 0.5 ? "#a68f3d" : "#c4ae57";
    ctx.fillRect(x, 0, 3, size);
  }
  ctx.globalAlpha = 1;

  for (let i = 0; i < 2200; i++) {
    const shade = 20 + random() * 40;
    ctx.fillStyle = `rgba(${shade | 0}, ${(shade * 0.85) | 0}, 10, ${0.05 + random() * 0.08})`;
    ctx.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
  }

  return finalizeTexture(canvas);
}

export function createFloorTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = createCanvas(size);
  const random = createRandom(4242);

  ctx.fillStyle = "#7a6a35";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 6000; i++) {
    const shade = 55 + random() * 40;
    ctx.fillStyle = `rgba(${shade | 0}, ${(shade * 0.9) | 0}, ${(shade * 0.4) | 0}, ${0.08 + random() * 0.1})`;
    const w = 1 + random() * 2;
    ctx.fillRect(random() * size, random() * size, w, w);
  }

  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = "#3a3116";
  for (let x = 0; x < size; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  return finalizeTexture(canvas);
}

export function createCeilingTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = createCanvas(size);
  const tile = 64;

  ctx.fillStyle = "#d8d2bd";
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = "rgba(60, 55, 35, 0.35)";
  ctx.lineWidth = 2;
  for (let x = 0; x <= size; x += tile) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  for (let y = 0; y <= size; y += tile) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  return finalizeTexture(canvas);
}
