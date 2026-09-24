import * as THREE from "three";
import type { PhysicsWorld } from "../physics/physicsWorld";
import { CELL_SIZE } from "../shared/constants";
import { getExitLocation, getExitWorldPosition } from "../shared/exit";
import { createLevelProfile, type LevelProfile } from "../shared/levelProfile";
import { ChunkStreamer } from "./chunkStreamer";
import { ExitBeacon } from "./exitBeacon";
import { FloorCeiling } from "./floorCeiling";
import type { GrabbableRegistry } from "./grabbable";
import { createLightFieldParams, sampleZoneLight, type LightFieldParams } from "./lightField";
import { setDepthLook, setLightField } from "./vhsMaterial";
import { worldSound } from "./worldSound";

/** Distance (m) sous laquelle le joueur est considéré comme ayant atteint la sortie. */
const EXIT_REACHED_DISTANCE = 0.55;

/** Chaque level repart d'une grille locale : le spawn est toujours au centre de la cellule (0,0). */
export const SPAWN_LOCAL_POSITION = new THREE.Vector3(CELL_SIZE / 2, 0, CELL_SIZE / 2);

export interface LevelUpdateResult {
  /** Corruption VHS à ajouter cette frame (murs-pièges + labyrinthe dynamique). */
  corruptionDelta: number;
  /** Vrai la frame où un mur-piège commence son avertissement (signal haptique léger). */
  wallTrapJustWarned: boolean;
  /** Vrai la frame où un mur-piège surgit pleinement (signal haptique fort). */
  wallTrapJustPopped: boolean;
  /** Nombre de piles ramassées cette frame. */
  batteriesPicked: number;
  /** Obscurité à la position du joueur (0 = zone éclairée, 1 = néons éteints). */
  darkness: number;
  /** Distance (m) à la sortie, pour l'indicateur de signal du HUD. */
  exitDistance: number;
}

/**
 * Orchestre la progression par level (fiche projet, étape 4) : profil de difficulté
 * dérivé de la profondeur, sortie signalée (son + lumière), passage au level suivant.
 * `runSeed` (étape 7) vient du serveur (`POST /run/start`) — `restartRun` permet de la
 * remplacer une fois la réponse reçue (le monde démarre avec une seed locale temporaire
 * le temps de l'aller-retour réseau, pour ne jamais bloquer le premier rendu) ou de
 * repartir sur une run neuve après un "STOP REC".
 */
export class LevelManager {
  depth = 0;

  private profile: LevelProfile;
  private readonly chunkStreamer: ChunkStreamer;
  private exitBeacon: ExitBeacon;
  private exitWorldX: number;
  private exitWorldZ: number;
  private sessionStarted = false;
  private runSeed: string;
  /** Part du brouillage de la balise annulée (bonus boussole). */
  beaconSteadiness = 0;
  private lightField: LightFieldParams;
  private readonly floorCeiling: FloorCeiling;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly audioListener: THREE.AudioListener,
    private readonly physics: PhysicsWorld,
    grabbables: GrabbableRegistry,
    isItemStored: (id: string) => boolean,
    initialRunSeed: string,
  ) {
    this.runSeed = initialRunSeed;
    worldSound.init(scene, audioListener);
    this.profile = createLevelProfile(this.depth, this.runSeed);
    this.lightField = createLightFieldParams(this.profile.seed, this.depth, getExitLocation(this.profile).cellX, getExitLocation(this.profile).cellZ);
    setLightField(this.lightField);
    setDepthLook(this.depth);
    this.floorCeiling = new FloorCeiling(scene);
    this.floorCeiling.update(SPAWN_LOCAL_POSITION);
    this.chunkStreamer = new ChunkStreamer(scene, audioListener, physics, grabbables, isItemStored, this.profile);
    this.chunkStreamer.primeArea(SPAWN_LOCAL_POSITION);

    const exitPosition = getExitWorldPosition(this.profile);
    this.exitWorldX = exitPosition.x;
    this.exitWorldZ = exitPosition.z;
    this.exitBeacon = this.createExitBeacon();
    this.scene.add(this.exitBeacon.group);
  }

  /** À appeler au démarrage de la session XR (politique d'autoplay des navigateurs). */
  onSessionStart(): void {
    this.sessionStarted = true;
    this.exitBeacon.play();
  }

  /** `playerPosition` : position XZ de la tête du joueur (pas l'origine du rig). */
  update(
    playerPosition: THREE.Vector3,
    hands: readonly THREE.Vector3[],
    camera: THREE.Camera,
    elapsedSeconds: number,
    deltaSeconds: number,
    corruption: number,
  ): LevelUpdateResult {
    const streamerResult = this.chunkStreamer.update(playerPosition, hands, camera, deltaSeconds);
    this.exitBeacon.update(elapsedSeconds, deltaSeconds, corruption * (1 - this.beaconSteadiness), playerPosition, this.scene);
    this.floorCeiling.update(playerPosition);

    const darkness = 1 - sampleZoneLight(this.lightField, playerPosition.x, playerPosition.z);

    const exitDistance = Math.hypot(playerPosition.x - this.exitWorldX, playerPosition.z - this.exitWorldZ);
    return { ...streamerResult, darkness, exitDistance };
  }

  /** Éclairage ambiant des néons [0..1] à une position (0 = zone éteinte). */
  zoneLightAt(x: number, z: number): number {
    return sampleZoneLight(this.lightField, x, z);
  }

  hasReachedExit(playerPosition: THREE.Vector3): boolean {
    const trigger = this.exitBeacon.triggerPosition;
    return Math.hypot(playerPosition.x - trigger.x, playerPosition.z - trigger.z) < EXIT_REACHED_DISTANCE;
  }

  /** Passage au level suivant : nouveau profil (même seed de run, difficulté accrue), monde reconstruit. */
  descend(): THREE.Vector3 {
    this.depth += 1;
    this.rebuild();
    return SPAWN_LOCAL_POSITION.clone();
  }

  /**
   * Repart sur une nouvelle run à la profondeur 0 : soit la seed serveur authentique
   * vient d'arriver (remplace la seed locale temporaire du tout premier rendu), soit le
   * joueur a fait "STOP REC" et enchaîne une nouvelle run (étape 7).
   */
  restartRun(runSeed: string): THREE.Vector3 {
    this.runSeed = runSeed;
    this.depth = 0;
    this.rebuild();
    return SPAWN_LOCAL_POSITION.clone();
  }

  /** Porte de sortie, façade tournée vers le spawn (d'où arrive le couloir garanti). */
  private createExitBeacon(): ExitBeacon {
    const facing = Math.atan2(SPAWN_LOCAL_POSITION.x - this.exitWorldX, SPAWN_LOCAL_POSITION.z - this.exitWorldZ);
    return new ExitBeacon(this.exitWorldX, this.exitWorldZ, this.audioListener, this.physics, facing);
  }

  private rebuild(): void {
    this.profile = createLevelProfile(this.depth, this.runSeed);
    this.lightField = createLightFieldParams(this.profile.seed, this.depth, getExitLocation(this.profile).cellX, getExitLocation(this.profile).cellZ);
    setLightField(this.lightField);
    setDepthLook(this.depth);
    this.chunkStreamer.depth = this.depth;
    this.chunkStreamer.setProfile(this.profile);
    this.chunkStreamer.primeArea(SPAWN_LOCAL_POSITION);

    this.exitBeacon.dispose();
    this.scene.remove(this.exitBeacon.group);
    const exitPosition = getExitWorldPosition(this.profile);
    this.exitWorldX = exitPosition.x;
    this.exitWorldZ = exitPosition.z;
    this.exitBeacon = this.createExitBeacon();
    this.scene.add(this.exitBeacon.group);
    if (this.sessionStarted) this.exitBeacon.play();
  }
}
