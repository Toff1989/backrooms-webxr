import * as THREE from "three";
import type { NoiseFunction2D } from "simplex-noise";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { generateChunkLayout, type ChunkLayout, type WallSegment } from "../shared/chunkLayout";
import { CHUNK_SIZE, STREAM_RADIUS_CHUNKS, WALL_HEIGHT } from "../shared/constants";
import type { LevelProfile } from "../shared/levelProfile";
import { createSeededNoise2D } from "../shared/noise";
import { log } from "../debug/debugLog";
import { perf } from "../player/perfStats";
import { BatteryPickup } from "./batteryPickup";
import { buildChunkGroup } from "./chunkMesh";
import { spawnCollectibleModel } from "./collectibleLoader";
import { toCollectionEntry } from "./collection";
import type { GrabbableRegistry } from "./grabbable";
import { createLorePageModel, LORE_PAGE_MASS, LORE_PAGE_REST_HEIGHT } from "./lorePage";
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
  wallTraps: WallTrap[];
  batteries: BatteryPickup[];
  epoch: number;
  bounds: THREE.Box3;
}

export interface ChunkStreamerUpdateResult {
  corruptionDelta: number;
  wallTrapJustWarned: boolean;
  wallTrapJustPopped: boolean;
  /** Nombre de piles ramassées cette frame. */
  batteriesPicked: number;
}

/**
 * Charge/décharge les chunks autour du joueur (rayon de 2 chunks, fiche projet étape 2),
 * anime les murs-pièges et régénère périodiquement un chunk hors champ de vision pour
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
    /** Bande perdue portée par la page de ce level (null : récit complet, pas de page). */
    private readonly lorePageFragment: () => number | null,
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

  /**
   * Charge immédiatement les chunks autour d'une position, tous en un seul appel : réservé au
   * tout premier level, avant que la boucle de rendu ne tourne (rien n'est encore affiché, un
   * temps de chargement ne se voit pas comme un à-coup). Un changement de level EN JEU doit
   * passer par `enterArea` : ici, ~25 chunks avec leurs colliders d'un coup, c'était un blocage
   * de 100 à 450 ms à chaque descente (mesuré : tâches longues du fil principal).
   */
  primeArea(playerPosition: THREE.Vector3): void {
    this.enterArea(playerPosition);
    this.processStreaming(Infinity);
  }

  /**
   * Prépare la zone sans tout charger d'un coup : le flux habituel (`update`, appelé chaque
   * frame) prend le relais à son rythme normal (voir `LOADS_PER_FRAME`) — ~25 chunks à 1 par
   * frame tiennent largement dans l'écran bleu de transition (1,4 à 2,6 s), sans à-coup.
   */
  enterArea(playerPosition: THREE.Vector3): void {
    const chunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
    this.currentChunkX = chunkX;
    this.currentChunkZ = chunkZ;
    this.streamAround(chunkX, chunkZ);
    this.physics.recenter((chunkX + 0.5) * CHUNK_SIZE, (chunkZ + 0.5) * CHUNK_SIZE);
  }

  update(
    playerPosition: THREE.Vector3,
    hands: readonly THREE.Vector3[],
    camera: THREE.Camera,
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
    let wallTrapJustWarned = false;
    let wallTrapJustPopped = false;
    let batteriesPicked = 0;

    for (const chunk of this.loaded.values()) {
      chunk.group.visible = distanceToBox(playerPosition, chunk.bounds) < CHUNK_RENDER_DISTANCE;
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

    return { corruptionDelta, wallTrapJustWarned, wallTrapJustPopped, batteriesPicked };
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
    const startedAt = performance.now();
    const [chunkX, chunkZ] = parseChunkKey(key);
    const layout = generateChunkLayout(this.profile, this.noise2D, chunkX, chunkZ, epoch);
    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;
    const group = buildChunkGroup(layout);
    this.scene.add(group);

    const staticBody = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const segment of layout.wallSegments) this.addBoxCollider(staticBody, segment);
    for (const segment of layout.pillarObstacles) this.addBoxCollider(staticBody, segment);

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

    const loadedChunk: LoadedChunk = { group, staticBody, layout, wallTraps, batteries, epoch, bounds };
    this.loaded.set(key, loadedChunk);
    log("chunk", { action: "load", key, epoch, ms: Math.round((performance.now() - startedAt) * 10) / 10, walls: layout.wallSegments.length, props: layout.propPlacements.length });

    for (const placement of layout.propPlacements) {
      spawnProp(placement.kind)
        .then(({ model, template }) => {
          this.spawnQueue.push(() => {
            // Le chunk a pu être déchargé/régénéré pendant le chargement asynchrone du modèle.
            if (this.loaded.get(key) !== loadedChunk) return;
            this.grabbables.createProp(placement.kind, model, template, placement.x, placement.z, placement.rotationY, placement.y, placement.tipped);
          });
        })
        .catch(() => {});
    }

    if (layout.lorePage) this.spawnLorePage(key, loadedChunk, layout.lorePage);

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

  /** Page de bande perdue du level (une seule dans le monde, même si son chunk se recharge). */
  private spawnLorePage(key: string, chunk: LoadedChunk, location: NonNullable<ChunkLayout["lorePage"]>): void {
    const id = `${this.profile.seed}:lore`;
    this.spawnQueue.push(() => {
      const fragment = this.lorePageFragment();
      if (fragment === null || this.loaded.get(key) !== chunk || this.grabbables.isItemAlive(id)) return;
      const { model, template, dispose } = createLorePageModel(fragment);
      this.grabbables.create({
        model,
        template,
        scale: 1,
        position: new THREE.Vector3(location.x, LORE_PAGE_REST_HEIGHT, location.z),
        quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), location.rotationY),
        mass: LORE_PAGE_MASS,
        item: null,
        lorePage: { id, fragment },
        onDispose: dispose,
      });
    });
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

function parseChunkKey(key: string): [number, number] {
  const parts = key.split(",");
  return [Number(parts[0]), Number(parts[1])];
}

/** Libère les géométries du chunk. Les matériaux (et la géométrie des piles) sont partagés : jamais disposés ici. */
function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object.parent?.name === "battery") return;
    // Géométrie des piliers : partagée par tous les chunks (voir `chunkMesh.ts`), jamais à eux seuls.
    if (object.name === "pillars") return;
    if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
      object.geometry.dispose();
    }
  });
}
