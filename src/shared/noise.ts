import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { createSeededRandom } from "./rng.js";

/**
 * Bruit simplex 2D déterministe : la table de permutation est initialisée depuis la
 * seed, puis noise2D(x, z) redevient une fonction pure des coordonnées — régénérable
 * à l'identique côté serveur.
 */
export function createSeededNoise2D(seed: string): NoiseFunction2D {
  return createNoise2D(createSeededRandom(seed));
}
