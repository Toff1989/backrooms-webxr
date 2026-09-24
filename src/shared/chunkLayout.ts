import type { NoiseFunction2D } from "simplex-noise";
import {
  COLLECTIBLE_SCALE_MAX,
  COLLECTIBLE_SCALE_MIN,
  generateCollectibleLore,
  getCollectibleRarity,
  pickCollectibleKind,
  type CollectibleKind,
  type CollectibleRarity,
} from "./collectibles.js";
import { CELL_SIZE, CHUNK_CELLS, EXIT_CLEARANCE_CELLS, PILLAR_SIZE, SPAWN_CLEARANCE_CELLS, WALL_THICKNESS } from "./constants.js";
import { getExitLocation, type ExitLocation } from "./exit.js";
import type { LevelProfile } from "./levelProfile.js";
import { PROP_FOOTPRINT_RADIUS, pickPropKind, type PropKind } from "./props.js";
import { coordinateHash01, stringSeedToInt } from "./rng.js";

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
  /** Bords actuellement ouverts choisis comme mur-piège (fiche : "mur qui surgit"). Pas de
   * collision tant qu'il n'a pas surgi — voir WallTrap, qui gère l'apparition temporaire. */
  wallTrapCandidates: WallSegment[];
  /** Amas de mobilier décoratif (chaises, bureaux, meubles), inspiré des images de référence. */
  propPlacements: PropPlacement[];
  /** Une boîte de collision par amas (approximative, pas par meuble individuel). */
  propObstacles: WallSegment[];
  /** Objets de collection (fiche projet étape 6) : pas de collision, ramassage au grip. */
  collectiblePlacements: CollectiblePlacement[];
  /** Piles pour la lampe torche : ramassées au passage (id stable pour ne pas réapparaître). */
  batteryPlacements: Array<{ id: string; x: number; z: number; rotationY: number }>;
}

export interface PropPlacement {
  kind: PropKind;
  x: number;
  z: number;
  rotationY: number;
}

export interface CollectiblePlacement {
  /** Identifiant stable (seed + coordonnées + epoch) : sert de clé de persistance IndexedDB. */
  id: string;
  kind: CollectibleKind;
  rarity: CollectibleRarity;
  x: number;
  z: number;
  rotationY: number;
  scale: number;
  nameFr: string;
  nameEn: string;
  descriptionFr: string;
  descriptionEn: string;
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
  const wallTrapCandidates: WallSegment[] = [];
  const propPlacements: PropPlacement[] = [];
  const propObstacles: WallSegment[] = [];
  const collectiblePlacements: CollectiblePlacement[] = [];
  const batteryPlacements: ChunkLayout["batteryPlacements"] = [];
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
      } else if (!inClearance && coordinateHash01(seedInt, cellX, cellZ, 89) < profile.propClusterProbability) {
        generatePropCluster(seedInt, cellX, cellZ, originX, originZ, propPlacements, propObstacles);
      } else if (!inClearance && coordinateHash01(seedInt, cellX, cellZ, 201) < profile.collectibleProbability) {
        generateCollectiblePlacement(profile, seedInt, chunkX, chunkZ, epoch, cellX, cellZ, originX, originZ, collectiblePlacements);
      } else if (!inClearance && coordinateHash01(seedInt, cellX, cellZ, 223) < profile.batteryProbability) {
        // Posée près d'un coin de la cellule, pas au centre : il faut la chercher du regard.
        batteryPlacements.push({
          // Sans l'epoch : une cellule régénérée ne rend pas une pile déjà ramassée.
          id: `${profile.seed}:bat:${cellX}:${cellZ}`,
          x: originX + 0.4 + coordinateHash01(seedInt, cellX, cellZ, 224) * (CELL_SIZE - 0.8),
          z: originZ + 0.4 + coordinateHash01(seedInt, cellX, cellZ, 225) * (CELL_SIZE - 0.8),
          rotationY: coordinateHash01(seedInt, cellX, cellZ, 226) * Math.PI * 2,
        });
      }
    }
  }

  return {
    chunkX,
    chunkZ,
    wallSegments,
    pillarPositions,
    pillarObstacles,
    wallTrapCandidates,
    propPlacements,
    propObstacles,
    collectiblePlacements,
    batteryPlacements,
  };
}

const PROP_CLUSTER_MAX_RADIUS = 0.7;
const PROP_CLUSTER_OBSTACLE_MARGIN = 0.4;

/**
 * Amas de mobilier autour du centre d'une cellule : une chaise isolée le plus souvent,
 * parfois un petit groupe, rarement un empilement dense — comme sur les images de
 * référence (pièces majoritairement vides, un coin encombré). Une seule boîte de
 * collision approximative couvre tout l'amas (pas de précision par meuble).
 */
function generatePropCluster(
  seedInt: number,
  cellX: number,
  cellZ: number,
  originX: number,
  originZ: number,
  propPlacements: PropPlacement[],
  propObstacles: WallSegment[],
): void {
  const centerX = originX + CELL_SIZE / 2;
  const centerZ = originZ + CELL_SIZE / 2;

  const sizeRoll = coordinateHash01(seedInt, cellX, cellZ, 90);
  const clusterSize = sizeRoll < 0.55 ? 1 : sizeRoll < 0.85 ? 2 + Math.floor(coordinateHash01(seedInt, cellX, cellZ, 91) * 2) : 4 + Math.floor(coordinateHash01(seedInt, cellX, cellZ, 92) * 2);

  const placed: Array<{ x: number; z: number; radius: number }> = [];
  for (let i = 0; i < clusterSize; i++) {
    const kind = pickPropKind(coordinateHash01(seedInt, cellX, cellZ, 100 + i));
    const footprint = PROP_FOOTPRINT_RADIUS[kind];
    const angle = coordinateHash01(seedInt, cellX, cellZ, 120 + i) * Math.PI * 2;
    const radius = coordinateHash01(seedInt, cellX, cellZ, 140 + i) * PROP_CLUSTER_MAX_RADIUS;
    const rotationY = coordinateHash01(seedInt, cellX, cellZ, 160 + i) * Math.PI * 2;
    // Reste dans la cellule, à distance des murs de bord (demi-épaisseur + marge).
    const limit = CELL_SIZE / 2 - WALL_THICKNESS / 2 - 0.05 - footprint;
    if (limit <= 0) continue;
    const x = centerX + Math.max(-limit, Math.min(limit, Math.cos(angle) * radius));
    const z = centerZ + Math.max(-limit, Math.min(limit, Math.sin(angle) * radius));
    // Pas de chevauchement avec les meubles déjà posés de l'amas : sinon, on renonce à celui-ci.
    if (placed.some((other) => Math.hypot(other.x - x, other.z - z) < other.radius + footprint)) continue;
    placed.push({ x, z, radius: footprint });
    propPlacements.push({ kind, x, z, rotationY });
  }

  const half = PROP_CLUSTER_MAX_RADIUS + PROP_CLUSTER_OBSTACLE_MARGIN;
  propObstacles.push({
    minX: centerX - half,
    maxX: centerX + half,
    minZ: centerZ - half,
    maxZ: centerZ + half,
  });
}

const COLLECTIBLE_JITTER_RATIO = 0.4;
/** Distance minimale entre deux objets de collection du même chunk : ils doivent rester
 * difficiles à trouver, jamais groupés (fiche : "ne pas être les uns à côté des autres"). */
const COLLECTIBLE_MIN_SPACING = CELL_SIZE * 3;

/**
 * Place un objet de collection au centre d'une cellule (léger jitter) : kind (dont la
 * rareté découle directement, voir `collectibles.ts`)/échelle/lore FR+EN tous dérivés
 * de la seed, de l'epoch et des coordonnées de cellule — déterministe, donc
 * reproductible tant que le chunk n'est pas régénéré (labyrinthe dynamique) sous un
 * epoch différent. `id` sert de clé de persistance. Rejette le tirage si un autre objet
 * du même chunk est trop proche, pour garder les objets dispersés/difficiles à trouver.
 */
function generateCollectiblePlacement(
  profile: LevelProfile,
  seedInt: number,
  chunkX: number,
  chunkZ: number,
  epoch: number,
  cellX: number,
  cellZ: number,
  originX: number,
  originZ: number,
  collectiblePlacements: CollectiblePlacement[],
): void {
  const centerX = originX + CELL_SIZE / 2;
  const centerZ = originZ + CELL_SIZE / 2;

  for (const existing of collectiblePlacements) {
    const dx = existing.x - centerX;
    const dz = existing.z - centerZ;
    if (Math.hypot(dx, dz) < COLLECTIBLE_MIN_SPACING) return;
  }

  const jitterX = (coordinateHash01(seedInt, cellX, cellZ, 207) - 0.5) * CELL_SIZE * COLLECTIBLE_JITTER_RATIO;
  const jitterZ = (coordinateHash01(seedInt, cellX, cellZ, 208) - 0.5) * CELL_SIZE * COLLECTIBLE_JITTER_RATIO;

  const kind = pickCollectibleKind(coordinateHash01(seedInt, cellX, cellZ, 202));
  const rarity = getCollectibleRarity(kind);
  const scale = COLLECTIBLE_SCALE_MIN + coordinateHash01(seedInt, cellX, cellZ, 205) * (COLLECTIBLE_SCALE_MAX - COLLECTIBLE_SCALE_MIN);
  const rotationY = coordinateHash01(seedInt, cellX, cellZ, 206) * Math.PI * 2;
  const lore = generateCollectibleLore(kind, coordinateHash01(seedInt, cellX, cellZ, 210), coordinateHash01(seedInt, cellX, cellZ, 211));

  collectiblePlacements.push({
    id: `${profile.seed}#${chunkX},${chunkZ}#${cellX},${cellZ}#e${epoch}`,
    kind,
    rarity,
    x: centerX + jitterX,
    z: centerZ + jitterZ,
    rotationY,
    scale,
    ...lore,
  });
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
