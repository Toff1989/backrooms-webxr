import * as THREE from "three";
import { CELL_SIZE } from "../shared/constants";
import { getExitWorldPosition } from "../shared/exit";
import { createLevelProfile, type LevelProfile } from "../shared/levelProfile";
import type { WallSegment } from "../shared/chunkLayout";
import { ChunkStreamer } from "./chunkStreamer";
import { ExitBeacon } from "./exitBeacon";

/** Distance (m) sous laquelle le joueur est considéré comme ayant atteint la sortie. */
const EXIT_REACHED_DISTANCE = 1.1;

/** Chaque level repart d'une grille locale : le spawn est toujours au centre de la cellule (0,0). */
export const SPAWN_LOCAL_POSITION = new THREE.Vector3(CELL_SIZE / 2, 0, CELL_SIZE / 2);

export interface LevelUpdateResult {
  /** Corruption VHS à ajouter cette frame (pièges glitch + régénération de labyrinthe hors champ). */
  corruptionDelta: number;
  /** Vrai la frame où le joueur entre dans un piège glitch (signal haptique). */
  trapJustTriggered: boolean;
}

/**
 * Orchestre la progression par level (fiche projet, étape 4) : profil de difficulté
 * dérivé de la profondeur, sortie signalée (son + lumière), passage au level suivant.
 */
export class LevelManager {
  depth = 0;

  private profile: LevelProfile;
  private readonly chunkStreamer: ChunkStreamer;
  private exitBeacon: ExitBeacon;
  private exitWorldX: number;
  private exitWorldZ: number;
  private sessionStarted = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly audioListener: THREE.AudioListener,
  ) {
    this.profile = createLevelProfile(this.depth);
    this.chunkStreamer = new ChunkStreamer(scene, audioListener, this.profile);
    this.chunkStreamer.primeArea(SPAWN_LOCAL_POSITION);

    const exitPosition = getExitWorldPosition(this.profile);
    this.exitWorldX = exitPosition.x;
    this.exitWorldZ = exitPosition.z;
    this.exitBeacon = new ExitBeacon(this.exitWorldX, this.exitWorldZ, audioListener);
    this.scene.add(this.exitBeacon.group);
  }

  /** À appeler au démarrage de la session XR (politique d'autoplay des navigateurs). */
  onSessionStart(): void {
    this.sessionStarted = true;
    this.exitBeacon.play();
    this.chunkStreamer.onSessionStart();
  }

  update(playerPosition: THREE.Vector3, camera: THREE.Camera, elapsedSeconds: number, deltaSeconds: number): LevelUpdateResult {
    const streamerResult = this.chunkStreamer.update(playerPosition, camera, elapsedSeconds, deltaSeconds);
    this.exitBeacon.update(elapsedSeconds);
    return streamerResult;
  }

  collectNearbyWallSegments(playerPosition: THREE.Vector3, target: WallSegment[]): void {
    this.chunkStreamer.collectNearbyWallSegments(playerPosition, target);
  }

  hasReachedExit(playerPosition: THREE.Vector3): boolean {
    const dx = playerPosition.x - this.exitWorldX;
    const dz = playerPosition.z - this.exitWorldZ;
    return Math.hypot(dx, dz) < EXIT_REACHED_DISTANCE;
  }

  /** Passage au level suivant : nouveau profil (seed dérivée, difficulté accrue), monde reconstruit. */
  descend(): THREE.Vector3 {
    this.depth += 1;
    this.profile = createLevelProfile(this.depth);
    this.chunkStreamer.setProfile(this.profile);
    this.chunkStreamer.primeArea(SPAWN_LOCAL_POSITION);
    if (this.sessionStarted) this.chunkStreamer.onSessionStart();

    this.exitBeacon.dispose();
    this.scene.remove(this.exitBeacon.group);
    const exitPosition = getExitWorldPosition(this.profile);
    this.exitWorldX = exitPosition.x;
    this.exitWorldZ = exitPosition.z;
    this.exitBeacon = new ExitBeacon(this.exitWorldX, this.exitWorldZ, this.audioListener);
    this.scene.add(this.exitBeacon.group);
    if (this.sessionStarted) this.exitBeacon.play();

    return SPAWN_LOCAL_POSITION.clone();
  }
}
