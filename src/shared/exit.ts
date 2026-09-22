import { CELL_SIZE } from "./constants";
import type { LevelProfile } from "./levelProfile";
import { coordinateHash01, stringSeedToInt } from "./rng";

export interface ExitLocation {
  cellX: number;
  cellZ: number;
}

/** Amplitude aléatoire (en cellules) ajoutée à `exitMinDistanceCells` pour éviter une distance fixe. */
const EXIT_DISTANCE_JITTER_CELLS = 6;

/**
 * Position de la sortie du level (en coordonnées de cellule globales), dérivée uniquement
 * de la seed du profil — fonction pure, régénérable à l'identique côté serveur.
 */
export function getExitLocation(profile: LevelProfile): ExitLocation {
  const seedInt = stringSeedToInt(profile.seed);
  const angle = coordinateHash01(seedInt, 0, 0, 901) * Math.PI * 2;
  const jitterCells = Math.floor(coordinateHash01(seedInt, 0, 0, 902) * EXIT_DISTANCE_JITTER_CELLS);
  const distanceCells = profile.exitMinDistanceCells + jitterCells;

  return {
    cellX: Math.round(Math.cos(angle) * distanceCells),
    cellZ: Math.round(Math.sin(angle) * distanceCells),
  };
}

/** Position monde (centre de cellule) de la sortie. */
export function getExitWorldPosition(profile: LevelProfile): { x: number; z: number } {
  const location = getExitLocation(profile);
  return {
    x: location.cellX * CELL_SIZE + CELL_SIZE / 2,
    z: location.cellZ * CELL_SIZE + CELL_SIZE / 2,
  };
}
