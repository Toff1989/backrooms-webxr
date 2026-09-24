import * as THREE from "three";
import type { NoiseFunction2D } from "simplex-noise";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { generateChunkLayout, type ChunkLayout, type WallSegment } from "../shared/chunkLayout";
import { CHUNK_SIZE, STREAM_RADIUS_CHUNKS, WALL_HEIGHT } from "../shared/constants";
import type { LevelProfile } from "../shared/levelProfile";
import { createSeededNoise2D } from "../shared/noise";
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
/** Corruption ajoutée quand un chunk hors champ se régénère (masque discrètement le changement). */
const REGEN_CORRUPTION_PULSE = 0.1;
/** Les objets de collection apparaissent posés, légèrement au-dessus du sol (la physique les fait retomber). */
const COLLECTIBLE_SPAWN_HEIGHT = 0.05;

interface LoadedChunk {
  group: THREE.Group;
  /** Corps fixe portant les colliders des murs et piliers du chunk. */
  staticBody: RAPIER.RigidBody;
  layout: ChunkLayout;
  glitchTraps: GlitchTrap[];
  wallTraps: WallTrap[];
  epoch: number;
  bounds: THREE.Box3;
}

export interface ChunkStreamerUpdateResult {
  corruptionDelta: number;
  glitchTrapJustTriggered: boolean;
  wallTrapJustWarned: boolean;
  wallTrapJustPopped: boolean;
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
    this.grabbables.removeAllNotHeld();
    this.profile = profile;
    this.noise2D = createSeededNoise2D(profile.seed);
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
  }

  /** À appeler au démarrage de la session XR (autoplay des pièges déjà chargés). */
  onSessionStart(): void {
    this.sessionStarted = true;
    for (const chunk of this.loaded.values()) {
      for (const trap of chunk.glitchTraps) trap.play();
    }
  }

  update(playerPosition: THREE.Vector3, camera: THREE.Camera, elapsedSeconds: number, deltaSeconds: number): ChunkStreamerUpdateResult {
    const chunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
    if (chunkX !== this.currentChunkX || chunkZ !== this.currentChunkZ) {
      this.currentChunkX = chunkX;
      this.currentChunkZ = chunkZ;
      this.streamAround(chunkX, chunkZ);
    }

    let corruptionDelta = 0;
    let glitchTrapJustTriggered = false;
    let wallTrapJustWarned = false;
    let wallTrapJustPopped = false;

    for (const chunk of this.loaded.values()) {
      for (const trap of chunk.glitchTraps) {
        const result = trap.update(playerPosition, elapsedSeconds, deltaSeconds);
        corruptionDelta += result.corruptionDelta;
        glitchTrapJustTriggered = glitchTrapJustTriggered || result.justTriggered;
      }
      for (const trap of chunk.wallTraps) {
        const result = trap.update(playerPosition, deltaSeconds);
        corruptionDelta += result.corruptionDelta;
        wallTrapJustWarned = wallTrapJustWarned || result.justWarned;
        wallTrapJustPopped = wallTrapJustPopped || result.justPopped;
      }
    }

    corruptionDelta += this.updateDynamicMaze(camera, deltaSeconds);

    return { corruptionDelta, glitchTrapJustTriggered, wallTrapJustWarned, wallTrapJustPopped };
  }

  private streamAround(chunkX: number, chunkZ: number): void {
    const desired = new Set<string>();
    for (let dx = -STREAM_RADIUS_CHUNKS; dx <= STREAM_RADIUS_CHUNKS; dx++) {
      for (let dz = -STREAM_RADIUS_CHUNKS; dz <= STREAM_RADIUS_CHUNKS; dz++) {
        desired.add(chunkKey(chunkX + dx, chunkZ + dz));
      }
    }

    for (const key of this.loaded.keys()) {
      if (!desired.has(key)) this.unloadChunk(key);
    }
    for (const key of desired) {
      if (!this.loaded.has(key)) this.loadChunk(key);
    }
  }

  /** Régénère périodiquement un chunk chargé mais hors champ de vision (labyrinthe dynamique). */
  private updateDynamicMaze(camera: THREE.Camera, deltaSeconds: number): number {
    this.regenTimer -= deltaSeconds;
    if (this.regenTimer > 0) return 0;

    // En session XR, les matrices caméra ne sont resynchronisées que dans renderer.render() —
    // si elles ne sont pas encore prêtes (première frame), on retente plus tard.
    if (!camera.projectionMatrix || !camera.matrixWorldInverse) return 0;

    this.regenTimer = randomRegenInterval();

    this.frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);

    const candidates: string[] = [];
    for (const [key, chunk] of this.loaded) {
      const dx = chunk.layout.chunkX - this.currentChunkX;
      const dz = chunk.layout.chunkZ - this.currentChunkZ;
      const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
      if (chebyshev < REGEN_MIN_DISTANCE_CHUNKS) continue;
      if (this.frustum.intersectsBox(chunk.bounds)) continue;
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
    this.unloadChunk(key);
    this.loadChunk(key, nextEpoch);
  }

  private loadChunk(key: string, epoch = 0): void {
    const [chunkX, chunkZ] = parseChunkKey(key);
    const layout = generateChunkLayout(this.profile, this.noise2D, chunkX, chunkZ, epoch);
    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;
    const group = buildChunkGroup(layout, originX, originZ, CHUNK_SIZE);
    this.scene.add(group);

    const staticBody = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const segment of layout.wallSegments) this.addBoxCollider(staticBody, segment);
    for (const segment of layout.pillarObstacles) this.addBoxCollider(staticBody, segment);

    const glitchTraps = layout.glitchTrapPositions.map((position) => {
      const trap = new GlitchTrap(position.x, position.z, this.audioListener, layout.wallSegments);
      this.scene.add(trap.group);
      if (this.sessionStarted) trap.play();
      return trap;
    });

    const wallTraps = layout.wallTrapCandidates.map((segment) => {
      const trap = new WallTrap(segment, this.audioListener, this.physics);
      this.scene.add(trap.group);
      return trap;
    });

    const bounds = new THREE.Box3(new THREE.Vector3(originX, 0, originZ), new THREE.Vector3(originX + CHUNK_SIZE, WALL_HEIGHT, originZ + CHUNK_SIZE));

    const loadedChunk: LoadedChunk = { group, staticBody, layout, glitchTraps, wallTraps, epoch, bounds };
    this.loaded.set(key, loadedChunk);

    for (const placement of layout.propPlacements) {
      spawnProp(placement.kind)
        .then(({ model, template }) => {
          // Le chunk a pu être déchargé/régénéré pendant le chargement asynchrone du modèle.
          if (this.loaded.get(key) !== loadedChunk) return;
          this.grabbables.createProp(placement.kind, model, template, placement.x, placement.z, placement.rotationY);
        })
        .catch(() => {});
    }

    const depth = this.depth;
    for (const placement of layout.collectiblePlacements) {
      if (this.isItemStored(placement.id) || this.grabbables.isItemAlive(placement.id)) continue;
      spawnCollectibleModel(placement.kind)
        .then(({ model, template }) => {
          if (this.loaded.get(key) !== loadedChunk) return;
          if (this.isItemStored(placement.id) || this.grabbables.isItemAlive(placement.id)) return;
          this.grabbables.createCollectible(
            toCollectionEntry(placement, depth),
            model,
            template,
            new THREE.Vector3(placement.x, COLLECTIBLE_SPAWN_HEIGHT, placement.z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotationY),
          );
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

function parseChunkKey(key: string): [number, number] {
  const parts = key.split(",");
  return [Number(parts[0]), Number(parts[1])];
}

/** Libère les géométries du chunk. Les matériaux sont des singletons partagés : jamais disposés ici. */
function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
      object.geometry.dispose();
    }
  });
}
