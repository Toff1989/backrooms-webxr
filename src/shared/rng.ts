import seedrandom from "seedrandom";

/**
 * Hash entier déterministe (inspiré de Squirrel3) : dépend uniquement de la seed et
 * des coordonnées passées, jamais d'un ordre d'appel. Nécessaire pour la génération
 * par chunk indépendante (un chunk régénéré isolément doit produire les mêmes bords
 * de mur que ses voisins).
 */
export function coordinateHash01(seed: number, x: number, y: number, salt = 0): number {
  let n = (x * 0x1b873593 + y * 0x85ebca6b + salt * 0xc2b2ae35 + seed) | 0;
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  n = (n ^ (n >>> 15)) >>> 0;
  return n / 4294967296;
}

/** Convertit une seed textuelle en entier stable pour coordinateHash01. */
export function stringSeedToInt(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) | 0;
  }
  return hash;
}

/** PRNG seedé (flux séquentiel) — utilisé pour initialiser des générateurs comme simplex-noise. */
export function createSeededRandom(seed: string): () => number {
  return seedrandom(seed);
}
