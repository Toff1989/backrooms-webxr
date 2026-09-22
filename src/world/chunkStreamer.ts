import * as THREE from "three";
import type { NoiseFunction2D } from "simplex-noise";
import { generateChunkLayout, type ChunkLayout, type WallSegment } from "../shared/chunkLayout";
import { CHUNK_SIZE, STREAM_RADIUS_CHUNKS } from "../shared/constants";
import type { LevelProfile } from "../shared/levelProfile";
import { createSeededNoise2D } from "../shared/noise";
import { buildChunkGroup } from "./chunkMesh";

interface LoadedChunk {
  group: THREE.Group;
  layout: ChunkLayout;
}

/**
 * Charge/décharge les chunks autour du joueur (rayon de 2 chunks, fiche projet étape 2).
 * La disposition (murs/piliers) est régénérée à la volée depuis la seed à chaque
 * chargement : rien n'est persisté, le monde est reproductible à l'identique.
 */
export class ChunkStreamer {
  private readonly loaded = new Map<string, LoadedChunk>();
  private noise2D: NoiseFunction2D;
  private profile: LevelProfile;
  private currentChunkX = Number.NaN;
  private currentChunkZ = Number.NaN;

  constructor(
    private readonly scene: THREE.Scene,
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
  }

  update(playerPosition: THREE.Vector3): void {
    const chunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
    if (chunkX === this.currentChunkX && chunkZ === this.currentChunkZ) return;

    this.currentChunkX = chunkX;
    this.currentChunkZ = chunkZ;

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

  private loadChunk(key: string): void {
    const [chunkX, chunkZ] = parseChunkKey(key);
    const layout = generateChunkLayout(this.profile, this.noise2D, chunkX, chunkZ);
    const group = buildChunkGroup(layout, chunkX * CHUNK_SIZE, chunkZ * CHUNK_SIZE, CHUNK_SIZE);
    this.scene.add(group);
    this.loaded.set(key, { group, layout });
  }

  private unloadChunk(key: string): void {
    const chunk = this.loaded.get(key);
    if (!chunk) return;
    this.scene.remove(chunk.group);
    disposeGroup(chunk.group);
    this.loaded.delete(key);
  }
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
