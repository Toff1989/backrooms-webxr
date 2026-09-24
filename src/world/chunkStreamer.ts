import * as THREE from "three";
import type { NoiseFunction2D } from "simplex-noise";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { generateChunkLayout, type ChunkLayout, type WallSegment } from "../shared/chunkLayout";
import { CELL_SIZE, CHUNK_CELLS, CHUNK_SIZE, STREAM_RADIUS_CHUNKS, WALL_HEIGHT } from "../shared/constants";
import type { LevelProfile } from "../shared/levelProfile";
import { createSeededNoise2D } from "../shared/noise";
import { coordinateHash01, stringSeedToInt } from "../shared/rng";
import { perf } from "../player/perfStats";
import { BatteryPickup } from "./batteryPickup";
import { buildChunkGroup } from "./chunkMesh";
import { spawnCollectibleModel } from "./collectibleLoader";
import { toCollectionEntry } from "./collection";
import { GlitchTrap } from "./glitchTrap";
import type { GrabbableRegistry } from "./grabbable";
import { spawnProp } from "./propLoader";
import { WallTrap } from "./wallTrap";

const REGEN_MIN_INTERVAL_SECONDS = 6;
const REGEN_MAX_INTERVAL_SECONDS = 12;
/** Distance minimale (en chunks) entre le chunk régénéré et le chunk du joueur : jamais sous ses pieds. */
const REGEN_MIN_DISTANCE_CHUNKS = 2;
/**
 * Parfois, le chunk régénéré est un voisin direct, juste derrière le joueur (hors champ) :
 * en se retournant, il voit que le couloir d'où il vient n'est plus le même.
 */
const REGEN_BEHIND_CHANCE = 0.35;
/**
 * Au-delà (m, jusqu'au bord du chunk), un chunk chargé n'est plus dessiné : le brouillard
 * en masque déjà plus des trois quarts. Économise les draw calls des coins de la zone chargée.
 */
const CHUNK_RENDER_DISTANCE = 34;
/** Distance minimale (m) entre le joueur et les limites d'un chunk voisin régénéré. */
const REGEN_BEHIND_MIN_DISTANCE = 4;
/** Corruption ajoutée quand un chunk hors champ se régénère (masque discrètement le changement). */
const REGEN_CORRUPTION_PULSE = 0.1;
/** Part des pièges glitch qui sont des téléporteurs (croît avec la profondeur). */
const BASE_TELEPORTER_SHARE = 0.25;
const TELEPORTER_SHARE_PER_DEPTH = 0.03;
const MAX_TELEPORTER_SHARE = 0.45;
/** Part des pièges glitch qui sont des boucles spatiales (en plus des téléporteurs). */
const BASE_LOOP_SHARE = 0.15;
const LOOP_SHARE_PER_DEPTH = 0.02;
const MAX_LOOP_SHARE = 0.3;
/** Destination d'un téléporteur : à au moins cette distance (m) du point de départ. */
const TELEPORT_MIN_JUMP = 12;
/** Marge (m) autour des obstacles pour la destination (le joueur n'apparaît jamais dans un meuble). */
const TELEPORT_CLEARANCE = 0.6;
/** Travail de streaming par frame : chargement/déchargement étalés pour éviter les à-coups. */
const LOADS_PER_FRAME = 1;
const UNLOADS_PER_FRAME = 2;
/** Meubles/objets créés par frame (corps physiques à enveloppe convexe). */
const SPAWNS_PER_FRAME = 3;
/** Les objets de collection apparaissent posés, légèrement au-dessus du sol (la physique les fait retomber). */
const COLLECTIBLE_SPAWN_HEIGHT = 0.05;

interface LoadedChunk {
  group: THREE.Group;
  /** Corps fixe portant les colliders des murs et piliers du chunk. */
  staticBody: RAPIER.RigidBody;
  layout: ChunkLayout;
  glitchTraps: GlitchTrap[];
  wallTraps: WallTrap[];
  batteries: BatteryPickup[];
  epoch: number;
  bounds: THREE.Box3;
}

export interface ChunkStreamerUpdateResult {
  corruptionDelta: number;
  glitchTrapJustTriggered: boolean;
  wallTrapJustWarned: boolean;
  wallTrapJustPopped: boolean;
  /** La frame où un téléporteur ("random") ou une boucle ("loop") happe le joueur. */
  teleportRequested: "random" | "loop" | null;
  /** Nombre de piles ramassées cette frame. */
  batteriesPicked: number;
}

/**
 * Charge/décharge les chunks autour du joueur (rayon de 2 chunks, fiche projet étape 2),
 * anime les pièges glitch et régénère périodiquement un chunk hors champ de vision pour
 * un labyrinthe dynamique (étape 5). Chaque chunk ajoute ses murs/piliers au monde
 * physique Rapier et fait apparaître son mobilier et ses objets de collection comme des
 * corps dynamiques (voir `GrabbableRegistry`).
 */
export class ChunkStreamer {
  /** Profondeur courante, pour horodater les objets de collection trouvés. */
  depth = 0;

  private readonly loaded = new Map<string, LoadedChunk>();
  /** Chunks à charger (clé -> epoch), traités quelques-uns par frame, les plus proches d'abord. */
  private readonly pendingLoads = new Map<string, number>();
  private readonly pendingUnloads = new Set<string>();
  private readonly spawnQueue: Array<() => void> = [];
  /** Piles déjà ramassées dans ce level (ne réapparaissent pas au rechargement du chunk). */
  private readonly pickedBatteries = new Set<string>();
  private noise2D: NoiseFunction2D;
  private profile: LevelProfile;
  private currentChunkX = Number.NaN;
  private currentChunkZ = Number.NaN;
  private sessionStarted = false;
  private regenTimer = randomRegenInterval();
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly audioListener: THREE.AudioListener,
    private readonly physics: PhysicsWorld,
    private readonly grabbables: GrabbableRegistry,
    /** Vrai si l'objet est déjà rangé dans l'inventaire (ne pas le refaire apparaître). */
    private readonly isItemStored: (id: string) => boolean,
    profile: LevelProfile,
  ) {
    this.profile = profile;
    this.noise2D = createSeededNoise2D(profile.seed);
  }

  /** Change de level : décharge tout le monde courant, repart à vide sur le nouveau profil/seed. */
  setProfile(profile: LevelProfile): void {
    for (const key of [...this.loaded.keys()]) this.unloadChunk(key);
    this.pendingLoads.clear();
    this.pendingUnloads.clear();
    this.spawnQueue.length = 0;
    this.grabbables.removeAllNotHeld();
    this.profile = profile;
    this.noise2D = createSeededNoise2D(profile.seed);
    this.pickedBatteries.clear();
    this.currentChunkX = Number.NaN;
    this.currentChunkZ = Number.NaN;
    this.regenTimer = randomRegenInterval();
  }

  /** Charge immédiatement les chunks autour d'une position (chargement initial, hors boucle de rendu). */
  primeArea(playerPosition: THREE.Vector3): void {
    const chunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
    this.currentChunkX = chunkX;
    this.currentChunkZ = chunkZ;
    this.streamAround(chunkX, chunkZ);
    this.physics.recenter((chunkX + 0.5) * CHUNK_SIZE, (chunkZ + 0.5) * CHUNK_SIZE);
    this.processStreaming(Infinity);
  }

  /** À appeler au démarrage de la session XR (autoplay des pièges déjà chargés). */
  onSessionStart(): void {
    this.sessionStarted = true;
    for (const chunk of this.loaded.values()) {
      for (const trap of chunk.glitchTraps) trap.play();
    }
  }

  update(
    playerPosition: THREE.Vector3,
    hands: readonly THREE.Vector3[],
    camera: THREE.Camera,
    elapsedSeconds: number,
    deltaSeconds: number,
  ): ChunkStreamerUpdateResult {
    const chunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
    if (chunkX !== this.currentChunkX || chunkZ !== this.currentChunkZ) {
      this.currentChunkX = chunkX;
      this.currentChunkZ = chunkZ;
      this.streamAround(chunkX, chunkZ);
      this.physics.recenter((chunkX + 0.5) * CHUNK_SIZE, (chunkZ + 0.5) * CHUNK_SIZE);
    }
    this.processStreaming(LOADS_PER_FRAME);

    let corruptionDelta = 0;
    let glitchTrapJustTriggered = false;
    let wallTrapJustWarned = false;
    let wallTrapJustPopped = false;
    let teleportRequested: "random" | "loop" | null = null;
    let batteriesPicked = 0;

    for (const chunk of this.loaded.values()) {
      chunk.group.visible = distanceToBox(playerPosition, chunk.bounds) < CHUNK_RENDER_DISTANCE;
      for (const trap of chunk.glitchTraps) {
        const result = trap.update(playerPosition, elapsedSeconds, deltaSeconds);
        corruptionDelta += result.corruptionDelta;
        glitchTrapJustTriggered = glitchTrapJustTriggered || result.justTriggered;
        teleportRequested ??= result.teleport;
      }
      for (let i = chunk.batteries.length - 1; i >= 0; i--) {
        const battery = chunk.batteries[i]!;
        if (!battery.isPickedBy(playerPosition, hands)) continue;
        this.pickedBatteries.add(battery.id);
        chunk.group.remove(battery.object);
        chunk.batteries.splice(i, 1);
        batteriesPicked++;
      }
      for (const trap of chunk.wallTraps) {
        const result = trap.update(playerPosition, deltaSeconds);
        corruptionDelta += result.corruptionDelta;
        wallTrapJustWarned = wallTrapJustWarned || result.justWarned;
        wallTrapJustPopped = wallTrapJustPopped || result.justPopped;
      }
    }

    corruptionDelta += this.updateDynamicMaze(camera, playerPosition, deltaSeconds);

    return { corruptionDelta, glitchTrapJustTriggered, wallTrapJustWarned, wallTrapJustPopped, teleportRequested, batteriesPicked };
  }

  /**
   * Destination d'un téléporteur : un centre de cellule libre dans les chunks chargés, loin
   * du point de départ, et jamais plus près de la sortie (le téléporteur désoriente, il ne
   * sert pas de raccourci — et la validation anti-triche du temps de run reste juste).
   */
  findTeleportDestination(from: THREE.Vector3, exitX: number, exitZ: number): THREE.Vector3 | null {
    const currentExitDistance = Math.hypot(from.x - exitX, from.z - exitZ);
    const blockedEdges = new Set<string>();
    const obstacles: WallSegment[] = [];
    const trapCells = new Set<string>();
    for (const { layout } of this.loaded.values()) {
      for (const wall of layout.wallSegments) blockedEdges.add(edgeKey((wall.minX + wall.maxX) / 2, (wall.minZ + wall.maxZ) / 2));
      obstacles.push(...layout.pillarObstacles, ...layout.propObstacles);
      for (const trap of layout.glitchTrapPositions) trapCells.add(chunkKey(Math.floor(trap.x / CELL_SIZE), Math.floor(trap.z / CELL_SIZE)));
    }

    // Parcours en largeur depuis la cellule du joueur : la destination doit être atteignable
    // à pied (jamais enfermé dans une poche de murs), limité aux chunks chargés.
    const minCell = (this.currentChunkX - STREAM_RADIUS_CHUNKS) * CHUNK_CELLS;
    const maxCellX = (this.currentChunkX + STREAM_RADIUS_CHUNKS + 1) * CHUNK_CELLS - 1;
    const minCellZ = (this.currentChunkZ - STREAM_RADIUS_CHUNKS) * CHUNK_CELLS;
    const maxCellZ = (this.currentChunkZ + STREAM_RADIUS_CHUNKS + 1) * CHUNK_CELLS - 1;
    const start: [number, number] = [Math.floor(from.x / CELL_SIZE), Math.floor(from.z / CELL_SIZE)];
    const visited = new Set<string>([chunkKey(start[0], start[1])]);
    const queue: Array<[number, number]> = [start];
    const candidates: THREE.Vector3[] = [];
    const steps: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let head = 0; head < queue.length; head++) {
      const [cellX, cellZ] = queue[head]!;
      const x = (cellX + 0.5) * CELL_SIZE;
      const z = (cellZ + 0.5) * CELL_SIZE;
      if (
        Math.hypot(x - from.x, z - from.z) >= TELEPORT_MIN_JUMP &&
        Math.hypot(x - exitX, z - exitZ) >= currentExitDistance &&
        !trapCells.has(chunkKey(cellX, cellZ)) &&
        !obstacles.some(
          (box) => x > box.minX - TELEPORT_CLEARANCE && x < box.maxX + TELEPORT_CLEARANCE && z > box.minZ - TELEPORT_CLEARANCE && z < box.maxZ + TELEPORT_CLEARANCE,
        )
      ) {
        candidates.push(new THREE.Vector3(x, 0, z));
      }

      for (const [stepX, stepZ] of steps) {
        const nextX = cellX + stepX;
        const nextZ = cellZ + stepZ;
        if (nextX < minCell || nextX > maxCellX || nextZ < minCellZ || nextZ > maxCellZ) continue;
        const key = chunkKey(nextX, nextZ);
        if (visited.has(key)) continue;
        // Milieu du bord traversé = milieu du segment de mur qui le fermerait.
        const edgeX = stepX === 0 ? x : (Math.max(cellX, nextX)) * CELL_SIZE;
        const edgeZ = stepZ === 0 ? z : (Math.max(cellZ, nextZ)) * CELL_SIZE;
        if (blockedEdges.has(edgeKey(edgeX, edgeZ))) continue;
        visited.add(key);
        queue.push([nextX, nextZ]);
      }
    }

    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)]!;
  }

  /** Vrai si aucune boîte de collision (mur, pilier, meuble) n'est à moins de `clearance` du point. */
  isPositionFree(x: number, z: number, clearance: number): boolean {
    for (const { layout } of this.loaded.values()) {
      for (const box of [...layout.wallSegments, ...layout.pillarObstacles, ...layout.propObstacles]) {
        if (x > box.minX - clearance && x < box.maxX + clearance && z > box.minZ - clearance && z < box.maxZ + clearance) return false;
      }
    }
    return true;
  }

  private streamAround(chunkX: number, chunkZ: number): void {
    const desired = new Set<string>();
    for (let dx = -STREAM_RADIUS_CHUNKS; dx <= STREAM_RADIUS_CHUNKS; dx++) {
      for (let dz = -STREAM_RADIUS_CHUNKS; dz <= STREAM_RADIUS_CHUNKS; dz++) {
        desired.add(chunkKey(chunkX + dx, chunkZ + dz));
      }
    }

    for (const key of this.loaded.keys()) {
      if (!desired.has(key)) this.pendingUnloads.add(key);
    }
    for (const key of this.pendingLoads.keys()) {
      if (!desired.has(key)) this.pendingLoads.delete(key);
    }
    for (const key of desired) {
      this.pendingUnloads.delete(key);
      if (!this.loaded.has(key) && !this.pendingLoads.has(key)) this.pendingLoads.set(key, 0);
    }
  }

  /**
   * Streaming étalé : quelques chargements/déchargements par frame (les plus proches d'abord)
   * au lieu de 5 + 5 d'un coup à chaque changement de chunk, plus la création des meubles.
   */
  private processStreaming(maxLoads: number): void {
    let unloads = 0;
    for (const key of this.pendingUnloads) {
      if (unloads >= (Number.isFinite(maxLoads) ? UNLOADS_PER_FRAME : Infinity)) break;
      this.pendingUnloads.delete(key);
      this.unloadChunk(key);
      unloads++;
    }

    let loads = 0;
    while (loads < maxLoads && this.pendingLoads.size > 0) {
      let nearest: string | null = null;
      let nearestDistance = Infinity;
      for (const key of this.pendingLoads.keys()) {
        const [x, z] = parseChunkKey(key);
        const distance = Math.max(Math.abs(x - this.currentChunkX), Math.abs(z - this.currentChunkZ));
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = key;
        }
      }
      const epoch = this.pendingLoads.get(nearest!)!;
      this.pendingLoads.delete(nearest!);
      this.loadChunk(nearest!, epoch);
      loads++;
    }

    const spawns = Number.isFinite(maxLoads) ? SPAWNS_PER_FRAME : Infinity;
    for (let i = 0; i < spawns && this.spawnQueue.length > 0; i++) this.spawnQueue.shift()!();
  }

  /** Régénère périodiquement un chunk chargé mais hors champ de vision (labyrinthe dynamique). */
  private updateDynamicMaze(camera: THREE.Camera, playerPosition: THREE.Vector3, deltaSeconds: number): number {
    this.regenTimer -= deltaSeconds;
    if (this.regenTimer > 0) return 0;

    // En session XR, les matrices caméra ne sont resynchronisées que dans renderer.render() —
    // si elles ne sont pas encore prêtes (première frame), on retente plus tard.
    if (!camera.projectionMatrix || !camera.matrixWorldInverse) return 0;

    this.regenTimer = randomRegenInterval();

    this.frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);

    const behind = Math.random() < REGEN_BEHIND_CHANCE;
    const candidates: string[] = [];
    for (const [key, chunk] of this.loaded) {
      const dx = chunk.layout.chunkX - this.currentChunkX;
      const dz = chunk.layout.chunkZ - this.currentChunkZ;
      const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
      if (this.frustum.intersectsBox(chunk.bounds)) continue;
      if (behind) {
        if (chebyshev !== 1 || distanceToBox(playerPosition, chunk.bounds) < REGEN_BEHIND_MIN_DISTANCE) continue;
      } else if (chebyshev < REGEN_MIN_DISTANCE_CHUNKS) continue;
      candidates.push(key);
    }
    if (candidates.length === 0) return 0;

    const key = candidates[Math.floor(Math.random() * candidates.length)]!;
    this.regenerateChunk(key);
    return REGEN_CORRUPTION_PULSE;
  }

  private regenerateChunk(key: string): void {
    const existing = this.loaded.get(key);
    if (!existing) return;
    const nextEpoch = existing.epoch + 1;
    // Déchargé tout de suite (hors champ), rechargé à la frame suivante par la file.
    this.unloadChunk(key);
    this.pendingLoads.set(key, nextEpoch);
  }

  private loadChunk(key: string, epoch = 0): void {
    perf?.event(`charge ${key}`);
    const [chunkX, chunkZ] = parseChunkKey(key);
    const layout = generateChunkLayout(this.profile, this.noise2D, chunkX, chunkZ, epoch);
    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;
    const group = buildChunkGroup(layout);
    this.scene.add(group);

    const staticBody = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const segment of layout.wallSegments) this.addBoxCollider(staticBody, segment);
    for (const segment of layout.pillarObstacles) this.addBoxCollider(staticBody, segment);

    const seedInt = stringSeedToInt(this.profile.seed);
    const teleporterShare = Math.min(MAX_TELEPORTER_SHARE, BASE_TELEPORTER_SHARE + this.profile.depth * TELEPORTER_SHARE_PER_DEPTH);
    const loopShare = Math.min(MAX_LOOP_SHARE, BASE_LOOP_SHARE + this.profile.depth * LOOP_SHARE_PER_DEPTH);
    const glitchTraps = layout.glitchTrapPositions.map((position) => {
      const cellX = Math.floor(position.x / CELL_SIZE);
      const cellZ = Math.floor(position.z / CELL_SIZE);
      const roll = coordinateHash01(seedInt, cellX, cellZ, 313);
      const kind = roll < teleporterShare ? "teleporter" : roll < teleporterShare + loopShare ? "loop" : "corruption";
      const trap = new GlitchTrap(position.x, position.z, this.audioListener, kind);
      this.scene.add(trap.group);
      if (this.sessionStarted) trap.play();
      return trap;
    });

    const wallTraps = layout.wallTrapCandidates.map((segment) => {
      const trap = new WallTrap(segment, this.audioListener, this.physics);
      this.scene.add(trap.group);
      return trap;
    });

    const batteries = layout.batteryPlacements
      .filter((placement) => !this.pickedBatteries.has(placement.id))
      .map((placement) => {
        const battery = new BatteryPickup(placement.id, placement.x, placement.z, placement.rotationY);
        group.add(battery.object);
        return battery;
      });

    const bounds = new THREE.Box3(new THREE.Vector3(originX, 0, originZ), new THREE.Vector3(originX + CHUNK_SIZE, WALL_HEIGHT, originZ + CHUNK_SIZE));

    const loadedChunk: LoadedChunk = { group, staticBody, layout, glitchTraps, wallTraps, batteries, epoch, bounds };
    this.loaded.set(key, loadedChunk);

    for (const placement of layout.propPlacements) {
      spawnProp(placement.kind)
        .then(({ model, template }) => {
          this.spawnQueue.push(() => {
            // Le chunk a pu être déchargé/régénéré pendant le chargement asynchrone du modèle.
            if (this.loaded.get(key) !== loadedChunk) return;
            this.grabbables.createProp(placement.kind, model, template, placement.x, placement.z, placement.rotationY);
          });
        })
        .catch(() => {});
    }

    const depth = this.depth;
    for (const placement of layout.collectiblePlacements) {
      if (this.isItemStored(placement.id) || this.grabbables.isItemAlive(placement.id)) continue;
      spawnCollectibleModel(placement.kind)
        .then(({ model, template }) => {
          this.spawnQueue.push(() => {
            if (this.loaded.get(key) !== loadedChunk) return;
            if (this.isItemStored(placement.id) || this.grabbables.isItemAlive(placement.id)) return;
            this.grabbables.createCollectible(
              toCollectionEntry(placement, depth),
              model,
              template,
              new THREE.Vector3(placement.x, COLLECTIBLE_SPAWN_HEIGHT, placement.z),
              new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotationY),
            );
          });
        })
        .catch(() => {});
    }
  }

  private addBoxCollider(body: RAPIER.RigidBody, segment: WallSegment): void {
    const halfX = (segment.maxX - segment.minX) / 2;
    const halfZ = (segment.maxZ - segment.minZ) / 2;
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfX, WALL_HEIGHT / 2, halfZ)
        .setTranslation(segment.minX + halfX, WALL_HEIGHT / 2, segment.minZ + halfZ)
        .setFriction(0.6)
        .setCollisionGroups(CollisionGroups.static),
      body,
    );
  }

  private unloadChunk(key: string): void {
    perf?.event(`décharge ${key}`);
    const chunk = this.loaded.get(key);
    if (!chunk) return;
    this.scene.remove(chunk.group);
    disposeGroup(chunk.group);
    // Les objets suivent leur position réelle, pas leur chunk d'origine : un meuble
    // transporté ailleurs survit au déchargement de son chunk de départ.
    const { min, max } = chunk.bounds;
    this.grabbables.removeInArea(min.x, max.x, min.z, max.z);
    this.physics.world.removeRigidBody(chunk.staticBody);
    for (const trap of chunk.glitchTraps) {
      this.scene.remove(trap.group);
      trap.dispose();
    }
    for (const trap of chunk.wallTraps) {
      this.scene.remove(trap.group);
      trap.dispose();
    }
    this.loaded.delete(key);
  }
}

function randomRegenInterval(): number {
  return REGEN_MIN_INTERVAL_SECONDS + Math.random() * (REGEN_MAX_INTERVAL_SECONDS - REGEN_MIN_INTERVAL_SECONDS);
}

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

function distanceToBox(point: THREE.Vector3, box: THREE.Box3): number {
  const dx = Math.max(box.min.x - point.x, 0, point.x - box.max.x);
  const dz = Math.max(box.min.z - point.z, 0, point.z - box.max.z);
  return Math.hypot(dx, dz);
}

function edgeKey(x: number, z: number): string {
  return `${Math.round(x * 4)},${Math.round(z * 4)}`;
}

function parseChunkKey(key: string): [number, number] {
  const parts = key.split(",");
  return [Number(parts[0]), Number(parts[1])];
}

/** Libère les géométries du chunk. Les matériaux (et la géométrie des piles) sont partagés : jamais disposés ici. */
function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object.parent?.name === "battery") return;
    if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
      object.geometry.dispose();
    }
  });
}
