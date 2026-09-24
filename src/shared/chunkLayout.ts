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
import { getLorePageLocation, type LorePageLocation } from "./lore.js";
import { composePropCluster, PROP_HALF_EXTENTS, type PropKind } from "./props.js";
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
  /** Page de bande perdue du level, si elle repose dans ce chunk (une par level, voir `lore.ts`). */
  lorePage: LorePageLocation | null;
}

export interface PropPlacement {
  kind: PropKind;
  x: number;
  z: number;
  rotationY: number;
  /** Hauteur de pose (m) : caisse empilée, objet posé sur un bureau. 0 = au sol. */
  y: number;
  /** Renversé sur le flanc : naît éveillé et retombe (la physique décide de sa pose). */
  tipped: boolean;
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
  // Cellule de la page de bande perdue : ses quatre bords restent ouverts (jamais emmurée).
  const lorePageLocation = getLorePageLocation(profile);
  const { cellX: loreCellX, cellZ: loreCellZ } = lorePageLocation;
  guaranteedPathEdges.add(edgeKey(loreCellX, loreCellZ, "north"));
  guaranteedPathEdges.add(edgeKey(loreCellX, loreCellZ, "west"));
  guaranteedPathEdges.add(edgeKey(loreCellX, loreCellZ + 1, "north"));
  guaranteedPathEdges.add(edgeKey(loreCellX + 1, loreCellZ, "west"));

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

      const isLoreCell = cellX === loreCellX && cellZ === loreCellZ;
      const inClearance = isLoreCell || isInsideSpawnClearance(cellX, cellZ) || isInsideExitClearance(cellX, cellZ, exitLocation);
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
    lorePage:
      loreCellX >= baseCellX && loreCellX < baseCellX + CHUNK_CELLS && loreCellZ >= baseCellZ && loreCellZ < baseCellZ + CHUNK_CELLS ? lorePageLocation : null,
  };
}

/** Demi-côté (m) de la boîte d'encombrement d'un amas (toute la cellule, murs exclus). */
const PROP_CLUSTER_OBSTACLE_HALF = 1.1;
/** Marge (m) entre un meuble et le bord de la cellule (demi-épaisseur de mur en plus). */
const PROP_WALL_MARGIN = WALL_THICKNESS / 2 + 0.05;

/** Meubles sur lesquels on pose un petit objet, et caisses qui s'empilent. */
const SUPPORT_PROPS = new Set<PropKind>(["officeDesk", "coffeeTable"]);
const STACKABLE_PROPS = new Set<PropKind>(["cardboardBox", "plasticCrate"]);

interface PlacedFootprint {
  kind: PropKind;
  x: number;
  z: number;
  hx: number;
  hz: number;
  angle: number;
  /** Décalage appliqué pour rester dans la cellule : un objet posé dessus suit son support. */
  shiftX: number;
  shiftZ: number;
  /** Position avant ce décalage (repère de l'amas), pour retrouver le support d'un objet posé. */
  rawX: number;
  rawZ: number;
}

/** Le point (repère de l'amas, avant décalage) est-il sur le plateau du meuble ? */
function isOnTop(support: PlacedFootprint, x: number, z: number): boolean {
  const dx = x - support.rawX;
  const dz = z - support.rawZ;
  const localX = dx * Math.cos(support.angle) - dz * Math.sin(support.angle);
  const localZ = dx * Math.sin(support.angle) + dz * Math.cos(support.angle);
  return Math.abs(localX) < support.hx - 0.08 && Math.abs(localZ) < support.hz - 0.08;
}

/** Deux rectangles orientés au sol se chevauchent-ils ? (axes séparateurs, 4 axes en 2D) */
function footprintsOverlap(a: PlacedFootprint, b: PlacedFootprint): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const angle of [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2]) {
    const ax = Math.cos(angle);
    const az = -Math.sin(angle);
    const projection = (f: PlacedFootprint): number =>
      f.hx * Math.abs(Math.cos(f.angle) * ax - Math.sin(f.angle) * az) + f.hz * Math.abs(Math.sin(f.angle) * ax + Math.cos(f.angle) * az);
    if (Math.abs(dx * ax + dz * az) > projection(a) + projection(b) - 0.02) return false;
  }
  return true;
}

/**
 * Amas de mobilier mis en scène (coin bureau, réserve, salle de classe... voir `props.ts`) au
 * centre d'une cellule, tourné d'un quart de tour aléatoire. Chaque meuble reste dans la
 * cellule (jamais dans un mur) et ne chevauche aucun autre posé au sol (sinon il est retiré) ;
 * un objet posé en hauteur (caisse empilée, plante sur un bureau) suit son support, et
 * disparaît avec lui. Une seule boîte de collision approximative couvre tout l'amas.
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
  const { slots, rotationY } = composePropCluster((salt) => coordinateHash01(seedInt, cellX, cellZ, 1000 + salt));
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  const placed: PlacedFootprint[] = [];
  const limit = CELL_SIZE / 2 - PROP_WALL_MARGIN;

  let previousAccepted = false;
  for (const slot of slots) previousAccepted = placeSlot(slot);

  function placeSlot(slot: (typeof slots)[number]): boolean {
    // Rotation d'un vecteur (dx, dz) autour de Y, même convention que three.js.
    const rawX = slot.dx * cos + slot.dz * sin;
    const rawZ = -slot.dx * sin + slot.dz * cos;
    const angle = rotationY + slot.rotationY;
    const { x: hx, z: hz } = PROP_HALF_EXTENTS[slot.kind];
    const y = slot.y ?? 0;
    let shiftX = 0;
    let shiftZ = 0;

    if (y > 0) {
      // Caisse empilée : seulement si l'étage du dessous est posé. Plante/télé : sur un plateau.
      const support = STACKABLE_PROPS.has(slot.kind)
        ? previousAccepted
          ? placed[placed.length - 1]
          : undefined
        : placed.find((other) => SUPPORT_PROPS.has(other.kind) && isOnTop(other, rawX, rawZ));
      if (!support) return false;
      shiftX = support.shiftX;
      shiftZ = support.shiftZ;
    } else {
      const extentX = Math.abs(Math.cos(angle)) * hx + Math.abs(Math.sin(angle)) * hz;
      const extentZ = Math.abs(Math.sin(angle)) * hx + Math.abs(Math.cos(angle)) * hz;
      const maxX = Math.max(0, limit - extentX);
      const maxZ = Math.max(0, limit - extentZ);
      shiftX = Math.max(-maxX, Math.min(maxX, rawX)) - rawX;
      shiftZ = Math.max(-maxZ, Math.min(maxZ, rawZ)) - rawZ;
    }

    const footprint: PlacedFootprint = { kind: slot.kind, x: rawX + shiftX, z: rawZ + shiftZ, hx, hz, angle, shiftX, shiftZ, rawX, rawZ };
    if (y === 0 && placed.some((other) => footprintsOverlap(other, footprint))) return false;
    // Une caisse empilée sert de support à la suivante (dernier élément de `placed`).
    if (y === 0 || STACKABLE_PROPS.has(slot.kind)) placed.push(footprint);
    propPlacements.push({ kind: slot.kind, x: centerX + footprint.x, z: centerZ + footprint.z, rotationY: angle, y, tipped: slot.tipped ?? false });
    return true;
  }

  propObstacles.push({
    minX: centerX - PROP_CLUSTER_OBSTACLE_HALF,
    maxX: centerX + PROP_CLUSTER_OBSTACLE_HALF,
    minZ: centerZ - PROP_CLUSTER_OBSTACLE_HALF,
    maxZ: centerZ + PROP_CLUSTER_OBSTACLE_HALF,
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
