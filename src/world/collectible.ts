import * as THREE from "three";
import type { CollectiblePlacement, WallSegment } from "../shared/chunkLayout";
import { spawnCollectibleModel } from "./collectibleLoader";
import { PhysicsBody } from "./physics";

const COLLECT_DURATION = 0.28;
const COLLECT_RISE_SPEED = 1.2;

const PICKUP_VOLUME = 0.5;
const REF_DISTANCE = 1.5;
const MAX_DISTANCE = 8;

export const COLLECTIBLE_PHYSICS_RADIUS = 0.16;
const NUDGE_RADIUS = 0.55;
const NUDGE_STRENGTH = 1.6;

type Phase = "idle" | "held" | "collecting" | "done";

let cachedPickupBuffer: AudioBuffer | null = null;
function getPickupBuffer(context: AudioContext): AudioBuffer {
  if (!cachedPickupBuffer) cachedPickupBuffer = createPickupBuffer(context);
  return cachedPickupBuffer;
}

/**
 * Instance d'un objet de collection posé dans le monde (fiche projet étape 6) : vrai
 * modèle CC0 (voir `collectibleLoader.ts`), posé au sol comme le mobilier — pas
 * d'animation de flottaison, juste une rotation aléatoire pour varier la pose. Peut être
 * bousculé par le joueur (physique légère, voir `physics.ts`) et joue une courte
 * animation de disparition + un carillon positionnel au ramassage.
 */
export class CollectibleInstance {
  readonly group: THREE.Group;
  readonly placement: CollectiblePlacement;

  private readonly model: THREE.Object3D;
  private readonly sound: THREE.PositionalAudio;
  private readonly physics: PhysicsBody;
  private phase: Phase = "idle";
  private phaseElapsed = 0;

  constructor(placement: CollectiblePlacement, listener: THREE.AudioListener, template: THREE.Object3D) {
    this.placement = placement;

    this.group = new THREE.Group();
    this.group.name = `collectible-${placement.kind}`;
    this.group.position.set(placement.x, 0, placement.z);

    this.model = template;
    this.model.rotation.y = placement.rotationY;
    this.model.scale.setScalar(placement.scale);
    this.group.add(this.model);

    this.physics = new PhysicsBody(0, COLLECTIBLE_PHYSICS_RADIUS);

    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setRefDistance(REF_DISTANCE);
    this.sound.setMaxDistance(MAX_DISTANCE);
    this.sound.setVolume(PICKUP_VOLUME);
    this.sound.position.set(0, 0.3, 0);
    this.group.add(this.sound);
  }

  isGrabbable(): boolean {
    return this.phase === "idle";
  }

  /**
   * Saisie en main (fiche : manipuler l'objet avant de décider de le garder) : reparente
   * le groupe au contrôleur XR — `Object3D.attach` préserve la transformation monde, donc
   * l'objet ne saute pas au moment de la saisie, et suit ensuite naturellement la main
   * (three.js recalcule sa matrice locale à partir du parent à chaque frame).
   */
  beginHold(controller: THREE.Object3D): void {
    if (this.phase !== "idle") return;
    this.phase = "held";
    controller.attach(this.group);
  }

  /** Relâche la prise : reparente au monde et retourne la position atteinte, pour que l'appelant décide ramassage vs. dépose (voir `main.ts`). */
  endHold(scene: THREE.Object3D): THREE.Vector3 {
    scene.attach(this.group);
    this.phase = "idle";
    return this.group.position.clone();
  }

  /** Repose l'objet là où il a été lâché : la physique légère prend le relais (chute, glisse, se stabilise). */
  dropWithPhysics(): void {
    this.physics.arm();
  }

  /** Démarre l'animation de ramassage (appelé une fois la portée/le grip validés ailleurs). */
  beginCollect(): void {
    if (this.phase !== "idle") return;
    this.phase = "collecting";
    this.phaseElapsed = 0;

    if (this.sound.context.state === "running") {
      this.sound.setBuffer(getPickupBuffer(this.sound.context));
      if (this.sound.isPlaying) this.sound.stop();
      this.sound.play();
    }
  }

  update(deltaSeconds: number, playerPosition: THREE.Vector3, wallSegments: WallSegment[]): void {
    if (this.phase === "done" || this.phase === "held") return;

    if (this.phase === "idle") {
      if (this.physics.isSettled) {
        const dx = this.group.position.x - playerPosition.x;
        const dz = this.group.position.z - playerPosition.z;
        if (Math.hypot(dx, dz) < NUDGE_RADIUS) this.physics.nudgeFrom(this.group, playerPosition, NUDGE_STRENGTH);
      }
      this.physics.update(this.group, deltaSeconds, wallSegments);
      return;
    }

    this.phaseElapsed += deltaSeconds;
    const t = Math.min(1, this.phaseElapsed / COLLECT_DURATION);
    this.model.scale.setScalar(Math.max(0.0001, this.placement.scale * (1 - t)));
    this.group.position.y += deltaSeconds * COLLECT_RISE_SPEED;
    if (t >= 1) {
      this.phase = "done";
      this.group.visible = false;
    }
  }

  dispose(): void {
    this.sound.stop();
    // Géométrie/matériaux viennent du template partagé (`collectibleLoader.ts`) : jamais disposés ici.
  }
}

/** Charge le modèle puis construit l'instance : le chargement glTF est asynchrone, voir `chunkStreamer.ts`. */
export async function spawnCollectible(placement: CollectiblePlacement, listener: THREE.AudioListener): Promise<CollectibleInstance> {
  const model = await spawnCollectibleModel(placement.kind);
  return new CollectibleInstance(placement, listener, model);
}

function createPickupBuffer(context: AudioContext): AudioBuffer {
  const duration = 0.35;
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const progress = t / duration;
    const chime = Math.sin(2 * Math.PI * 1046.5 * t) * 0.4 + Math.sin(2 * Math.PI * 1568 * t) * 0.25;
    const envelope = Math.pow(1 - progress, 2);
    data[i] = chime * envelope;
  }

  return buffer;
}
