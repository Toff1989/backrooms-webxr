import * as THREE from "three";
import type { NoiseFunction2D } from "simplex-noise";
import { generateChunkLayout, type ChunkLayout, type WallSegment } from "../shared/chunkLayout";
import { CHUNK_SIZE, STREAM_RADIUS_CHUNKS, WALL_HEIGHT } from "../shared/constants";
import type { LevelProfile } from "../shared/levelProfile";
import { createSeededNoise2D } from "../shared/noise";
import { buildChunkGroup } from "./chunkMesh";
import { GlitchTrap } from "./glitchTrap";

const REGEN_MIN_INTERVAL_SECONDS = 6;
const REGEN_MAX_INTERVAL_SECONDS = 12;
/** Distance minimale (en chunks) entre le chunk régénéré et le chunk du joueur : jamais sous ses pieds. */
const REGEN_MIN_DISTANCE_CHUNKS = 2;
/** Corruption ajoutée quand un chunk hors champ se régénère (masque discrètement le changement). */
const REGEN_CORRUPTION_PULSE = 0.1;

interface LoadedChunk {
  group: THREE.Group;
  layout: ChunkLayout;
  traps: GlitchTrap[];
  epoch: number;
  bounds: THREE.Box3;
}

export interface ChunkStreamerUpdateResult {
  corruptionDelta: number;
  trapJustTriggered: boolean;
}

/**
 * Charge/décharge les chunks autour du joueur (rayon de 2 chunks, fiche projet étape 2),
 * anime les pièges glitch et régénère périodiquement un chunk hors champ de vision pour
 * un labyrinthe dynamique (étape 5 : "régénération à intervalle aléatoire des chunks
 * hors du champ de vision"). La disposition (murs/piliers/pièges) est régénérée à la
 * volée depuis la seed à chaque chargement : rien n'est persisté.
 */
export class ChunkStreamer {
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
    profile: LevelProfile,
  ) {
    this.profile = profile;
    this.noise2D = createSeededNoise2D(profile.seed);
  }

  /** Change de level : décharge tout le monde courant, repart à vide sur le nouveau profil/seed. */
  setProfile(profile: LevelProfile): void {
    for (const key of [...this.loaded.keys()]) this.unloadChunk(key);
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
      for (const trap of chunk.traps) trap.play();
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
    let trapJustTriggered = false;
    for (const chunk of this.loaded.values()) {
      for (const trap of chunk.traps) {
        const result = trap.update(playerPosition, elapsedSeconds, deltaSeconds);
        corruptionDelta += result.corruptionDelta;
        trapJustTriggered = trapJustTriggered || result.justTriggered;
      }
    }

    corruptionDelta += this.updateDynamicMaze(camera, deltaSeconds);

    return { corruptionDelta, trapJustTriggered };
  }

  /** Remplit `target` avec les obstacles (murs + piliers) des chunks voisins, pour la collision. */
  collectNearbyWallSegments(playerPosition: THREE.Vector3, target: WallSegment[]): void {
    target.length = 0;
    const chunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const chunk = this.loaded.get(chunkKey(chunkX + dx, chunkZ + dz));
        if (!chunk) continue;
        for (const segment of chunk.layout.wallSegments) target.push(segment);
        for (const segment of chunk.layout.pillarObstacles) target.push(segment);
      }
    }
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
    // appelé après cette mise à jour. Si elles ne sont pas encore prêtes (première frame),
    // on retente au prochain intervalle plutôt que de planter la boucle de rendu.
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

    const traps = layout.glitchTrapPositions.map((position) => {
      const trap = new GlitchTrap(position.x, position.z, this.audioListener);
      this.scene.add(trap.group);
      if (this.sessionStarted) trap.play();
      return trap;
    });

    const bounds = new THREE.Box3(
      new THREE.Vector3(originX, 0, originZ),
      new THREE.Vector3(originX + CHUNK_SIZE, WALL_HEIGHT, originZ + CHUNK_SIZE),
    );

    this.loaded.set(key, { group, layout, traps, epoch, bounds });
  }

  private unloadChunk(key: string): void {
    const chunk = this.loaded.get(key);
    if (!chunk) return;
    this.scene.remove(chunk.group);
    disposeGroup(chunk.group);
    for (const trap of chunk.traps) {
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
