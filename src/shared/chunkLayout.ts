import type { NoiseFunction2D } from "simplex-noise";
import { CELL_SIZE, CHUNK_CELLS, SPAWN_CLEARANCE_CELLS, WALL_THICKNESS } from "./constants";
import type { LevelProfile } from "./levelProfile";
import { coordinateHash01, stringSeedToInt } from "./rng";

export type WallEdge = "north" | "west";

/** Boîte englobante XZ d'un segment de mur (utilisée pour le rendu et la collision). */
export interface WallSegment {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ChunkLayout {
  chunkX: number;
  chunkZ: number;
  wallSegments: WallSegment[];
  pillarPositions: Array<{ x: number; z: number }>;
}

/**
 * Génère la disposition d'un chunk (murs + piliers) à partir de la seed du profil.
 * Fonction pure : chaque bord de cellule est identifié uniquement par ses coordonnées
 * globales, donc deux chunks voisins générés indépendamment restent cohérents entre
 * eux (pas de couture visible ni de trou de collision à la frontière).
 */
export function generateChunkLayout(
  profile: LevelProfile,
  noise2D: NoiseFunction2D,
  chunkX: number,
  chunkZ: number,
): ChunkLayout {
  const seedInt = stringSeedToInt(profile.seed);
  const wallSegments: WallSegment[] = [];
  const pillarPositions: Array<{ x: number; z: number }> = [];
  const baseCellX = chunkX * CHUNK_CELLS;
  const baseCellZ = chunkZ * CHUNK_CELLS;
  const halfThickness = WALL_THICKNESS / 2;

  for (let localX = 0; localX < CHUNK_CELLS; localX++) {
    for (let localZ = 0; localZ < CHUNK_CELLS; localZ++) {
      const cellX = baseCellX + localX;
      const cellZ = baseCellZ + localZ;
      const originX = cellX * CELL_SIZE;
      const originZ = cellZ * CELL_SIZE;

      if (hasWallEdge(profile, noise2D, seedInt, cellX, cellZ, "north")) {
        wallSegments.push({
          minX: originX - halfThickness,
          maxX: originX + CELL_SIZE + halfThickness,
          minZ: originZ - halfThickness,
          maxZ: originZ + halfThickness,
        });
      }

      if (hasWallEdge(profile, noise2D, seedInt, cellX, cellZ, "west")) {
        wallSegments.push({
          minX: originX - halfThickness,
          maxX: originX + halfThickness,
          minZ: originZ - halfThickness,
          maxZ: originZ + CELL_SIZE + halfThickness,
        });
      }

      if (!isInsideSpawnClearance(cellX, cellZ) && coordinateHash01(seedInt, cellX, cellZ, 47) < profile.pillarProbability) {
        pillarPositions.push({ x: originX + CELL_SIZE / 2, z: originZ + CELL_SIZE / 2 });
      }
    }
  }

  return { chunkX, chunkZ, wallSegments, pillarPositions };
}

function isInsideSpawnClearance(cellX: number, cellZ: number): boolean {
  return Math.abs(cellX) <= SPAWN_CLEARANCE_CELLS && Math.abs(cellZ) <= SPAWN_CLEARANCE_CELLS;
}

function edgeTouchesSpawnClearance(cellX: number, cellZ: number, edge: WallEdge): boolean {
  const neighborX = edge === "west" ? cellX - 1 : cellX;
  const neighborZ = edge === "north" ? cellZ - 1 : cellZ;
  return isInsideSpawnClearance(cellX, cellZ) || isInsideSpawnClearance(neighborX, neighborZ);
}

function wallDensityAt(profile: LevelProfile, noise2D: NoiseFunction2D, cellX: number, cellZ: number): number {
  const noiseValue = noise2D(cellX * profile.noiseFrequency, cellZ * profile.noiseFrequency); // [-1, 1]
  const density = profile.wallDensityBase + noiseValue * profile.wallDensityNoiseInfluence;
  return Math.min(0.9, Math.max(0, density));
}

function hasWallEdge(
  profile: LevelProfile,
  noise2D: NoiseFunction2D,
  seedInt: number,
  cellX: number,
  cellZ: number,
  edge: WallEdge,
): boolean {
  if (edgeTouchesSpawnClearance(cellX, cellZ, edge)) return false;

  const density = wallDensityAt(profile, noise2D, cellX, cellZ);
  const salt = edge === "north" ? 11 : 23;
  const roll = coordinateHash01(seedInt, cellX, cellZ, salt);
  return roll < density;
}
