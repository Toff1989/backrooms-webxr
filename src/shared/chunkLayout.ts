import type { NoiseFunction2D } from "simplex-noise";
import { CELL_SIZE, CHUNK_CELLS, EXIT_CLEARANCE_CELLS, PILLAR_SIZE, SPAWN_CLEARANCE_CELLS, WALL_THICKNESS } from "./constants";
import { getExitLocation, type ExitLocation } from "./exit";
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
  /** Murs (rendu + collision). */
  wallSegments: WallSegment[];
  pillarPositions: Array<{ x: number; z: number }>;
  /** Boîtes de collision des piliers, séparées de `wallSegments` : un pilier se rend en cube
   * (InstancedMesh), pas en plan de mur — seule la collision partage le même type de boîte. */
  pillarObstacles: WallSegment[];
  /** Emplacements des pièges glitch (pas de collision, juste un déclenchement par proximité). */
  glitchTrapPositions: Array<{ x: number; z: number }>;
  /** Bords actuellement ouverts choisis comme mur-piège (fiche : "mur qui surgit"). Pas de
   * collision tant qu'il n'a pas surgi — voir WallTrap, qui gère l'apparition temporaire. */
  wallTrapCandidates: WallSegment[];
}

/**
 * Génère la disposition d'un chunk (murs + piliers + pièges) à partir de la seed du
 * profil. Fonction pure : chaque bord de cellule est identifié uniquement par ses
 * coordonnées globales, donc deux chunks voisins générés indépendamment restent
 * cohérents entre eux (pas de couture visible ni de trou de collision à la frontière).
 * Un couloir est garanti dégagé entre le spawn et la sortie du level (voir
 * `computeGuaranteedPathEdges`), quel que soit `epoch`.
 *
 * `epoch` permet de régénérer un chunk avec un agencement différent (labyrinthe
 * dynamique, étape 5) sans changer sa seed de base : seuls les tirages aléatoires par
 * cellule changent, la densité générale (bruit) et la sortie restent stables.
 */
export function generateChunkLayout(
  profile: LevelProfile,
  noise2D: NoiseFunction2D,
  chunkX: number,
  chunkZ: number,
  epoch = 0,
): ChunkLayout {
  const baseSeedInt = stringSeedToInt(profile.seed);
  const seedInt = epoch === 0 ? baseSeedInt : (baseSeedInt + epoch * 0x9e3779b1) | 0;
  const exitLocation = getExitLocation(profile);
  const guaranteedPathEdges = computeGuaranteedPathEdges(exitLocation);

  const wallSegments: WallSegment[] = [];
  const pillarPositions: Array<{ x: number; z: number }> = [];
  const pillarObstacles: WallSegment[] = [];
  const glitchTrapPositions: Array<{ x: number; z: number }> = [];
  const wallTrapCandidates: WallSegment[] = [];
  const baseCellX = chunkX * CHUNK_CELLS;
  const baseCellZ = chunkZ * CHUNK_CELLS;
  const halfThickness = WALL_THICKNESS / 2;

  for (let localX = 0; localX < CHUNK_CELLS; localX++) {
    for (let localZ = 0; localZ < CHUNK_CELLS; localZ++) {
      const cellX = baseCellX + localX;
      const cellZ = baseCellZ + localZ;
      const originX = cellX * CELL_SIZE;
      const originZ = cellZ * CELL_SIZE;

      processEdge(
        profile,
        noise2D,
        seedInt,
        exitLocation,
        guaranteedPathEdges,
        cellX,
        cellZ,
        "north",
        { minX: originX - halfThickness, maxX: originX + CELL_SIZE + halfThickness, minZ: originZ - halfThickness, maxZ: originZ + halfThickness },
        wallSegments,
        wallTrapCandidates,
      );

      processEdge(
        profile,
        noise2D,
        seedInt,
        exitLocation,
        guaranteedPathEdges,
        cellX,
        cellZ,
        "west",
        { minX: originX - halfThickness, maxX: originX + halfThickness, minZ: originZ - halfThickness, maxZ: originZ + CELL_SIZE + halfThickness },
        wallSegments,
        wallTrapCandidates,
      );

      const inClearance = isInsideSpawnClearance(cellX, cellZ) || isInsideExitClearance(cellX, cellZ, exitLocation);
      const hasPillar = !inClearance && coordinateHash01(seedInt, cellX, cellZ, 47) < profile.pillarProbability;
      if (hasPillar) {
        const pillarCenterX = originX + CELL_SIZE / 2;
        const pillarCenterZ = originZ + CELL_SIZE / 2;
        pillarPositions.push({ x: pillarCenterX, z: pillarCenterZ });
        pillarObstacles.push({
          minX: pillarCenterX - PILLAR_SIZE / 2,
          maxX: pillarCenterX + PILLAR_SIZE / 2,
          minZ: pillarCenterZ - PILLAR_SIZE / 2,
          maxZ: pillarCenterZ + PILLAR_SIZE / 2,
        });
      } else if (!inClearance && coordinateHash01(seedInt, cellX, cellZ, 71) < profile.glitchProbability) {
        glitchTrapPositions.push({ x: originX + CELL_SIZE / 2, z: originZ + CELL_SIZE / 2 });
      }
    }
  }

  return { chunkX, chunkZ, wallSegments, pillarPositions, pillarObstacles, glitchTrapPositions, wallTrapCandidates };
}

function isInsideSpawnClearance(cellX: number, cellZ: number): boolean {
  return Math.abs(cellX) <= SPAWN_CLEARANCE_CELLS && Math.abs(cellZ) <= SPAWN_CLEARANCE_CELLS;
}

function isInsideExitClearance(cellX: number, cellZ: number, exit: ExitLocation): boolean {
  return Math.abs(cellX - exit.cellX) <= EXIT_CLEARANCE_CELLS && Math.abs(cellZ - exit.cellZ) <= EXIT_CLEARANCE_CELLS;
}

function edgeTouchesClearance(cellX: number, cellZ: number, edge: WallEdge, exit: ExitLocation): boolean {
  const neighborX = edge === "west" ? cellX - 1 : cellX;
  const neighborZ = edge === "north" ? cellZ - 1 : cellZ;
  return (
    isInsideSpawnClearance(cellX, cellZ) ||
    isInsideSpawnClearance(neighborX, neighborZ) ||
    isInsideExitClearance(cellX, cellZ, exit) ||
    isInsideExitClearance(neighborX, neighborZ, exit)
  );
}

function wallDensityAt(profile: LevelProfile, noise2D: NoiseFunction2D, cellX: number, cellZ: number): number {
  const noiseValue = noise2D(cellX * profile.noiseFrequency, cellZ * profile.noiseFrequency); // [-1, 1]
  const density = profile.wallDensityBase + noiseValue * profile.wallDensityNoiseInfluence;
  return Math.min(0.9, Math.max(0, density));
}

function edgeKey(cellX: number, cellZ: number, edge: WallEdge): string {
  return `${cellX},${cellZ},${edge}`;
}

/**
 * Bord partagé entre deux cellules adjacentes (orthogonalement), sous la convention
 * "chaque bord appartient à sa cellule nord/ouest" utilisée par `hasWallEdge`.
 */
function sharedEdgeKey(ax: number, az: number, bx: number, bz: number): string {
  if (bx === ax + 1 && bz === az) return edgeKey(bx, bz, "west");
  if (bx === ax - 1 && bz === az) return edgeKey(ax, az, "west");
  if (bz === az + 1 && bx === ax) return edgeKey(bx, bz, "north");
  if (bz === az - 1 && bx === ax) return edgeKey(ax, az, "north");
  throw new Error(`cellules non adjacentes: (${ax},${az}) / (${bx},${bz})`);
}

/**
 * Couloir garanti dégagé entre le spawn (0,0) et la sortie : un chemin en équerre
 * (axe X puis axe Z), dont chaque bord traversé est forcé sans mur. Garantit que la
 * sortie est toujours atteignable, indépendamment de la densité de murs du profil.
 */
function computeGuaranteedPathEdges(exit: ExitLocation): Set<string> {
  const cells: Array<{ x: number; z: number }> = [{ x: 0, z: 0 }];
  let x = 0;
  let z = 0;
  const stepX = Math.sign(exit.cellX);
  while (x !== exit.cellX) {
    x += stepX;
    cells.push({ x, z });
  }
  const stepZ = Math.sign(exit.cellZ);
  while (z !== exit.cellZ) {
    z += stepZ;
    cells.push({ x, z });
  }

  const edges = new Set<string>();
  for (let i = 0; i < cells.length - 1; i++) {
    const a = cells[i]!;
    const b = cells[i + 1]!;
    edges.add(sharedEdgeKey(a.x, a.z, b.x, b.z));
  }
  return edges;
}

/**
 * Décide si le bord porte un mur, et sinon (bord ouvert, hors dégagement/couloir
 * garanti) s'il cache un mur-piège — pousse le segment dans le tableau approprié.
 */
function processEdge(
  profile: LevelProfile,
  noise2D: NoiseFunction2D,
  seedInt: number,
  exit: ExitLocation,
  guaranteedPathEdges: Set<string>,
  cellX: number,
  cellZ: number,
  edge: WallEdge,
  segment: WallSegment,
  wallSegments: WallSegment[],
  wallTrapCandidates: WallSegment[],
): void {
  const protectedEdge = edgeTouchesClearance(cellX, cellZ, edge, exit) || guaranteedPathEdges.has(edgeKey(cellX, cellZ, edge));
  const salt = edge === "north" ? 11 : 23;

  if (!protectedEdge) {
    const density = wallDensityAt(profile, noise2D, cellX, cellZ);
    const roll = coordinateHash01(seedInt, cellX, cellZ, salt);
    if (roll < density) {
      wallSegments.push(segment);
      return;
    }
  }

  // Bord ouvert (ou protégé) : jamais un mur-piège sur le couloir garanti/le dégagement,
  // pour ne jamais bloquer la route vers la sortie.
  if (!protectedEdge) {
    const wallTrapSalt = edge === "north" ? 111 : 123;
    const wallTrapRoll = coordinateHash01(seedInt, cellX, cellZ, wallTrapSalt);
    if (wallTrapRoll < profile.wallTrapProbability) {
      wallTrapCandidates.push(segment);
    }
  }
}
