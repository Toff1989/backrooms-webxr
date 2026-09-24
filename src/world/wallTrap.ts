import * as THREE from "three";
import { brownNoise, createSamples, fadeEdges, lowpass, normalize, reverb, toBuffer } from "../assets/audio/synth";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { WALL_HEIGHT, WALL_THICKNESS } from "../shared/constants";
import type { WallSegment } from "../shared/chunkLayout";
import { getWallMaterial } from "./materials";

/** Marge autour du mur : il ne surgit jamais tant que le joueur se tient dans son emprise. */
const PLAYER_CLEARANCE = 0.35;

type Phase = "idle" | "warning" | "rising" | "hold" | "receding" | "cooldown";

const TRIGGER_RADIUS = 3.2;
const WARNING_DURATION = 0.4;
const RISE_DURATION = 0.18;
const HOLD_DURATION = 2.5;
const RECEDE_DURATION = 0.3;
const COOLDOWN_DURATION = 18;
const IMPACT_CORRUPTION = 0.3;

const WARNING_VOLUME = 0.4;
const IMPACT_VOLUME = 0.55;
const REF_DISTANCE = 2;
const MAX_DISTANCE = 12;

export interface WallTrapUpdateResult {
  corruptionDelta: number;
  /** Vrai la frame où le décompte d'avertissement démarre (signal haptique léger). */
  justWarned: boolean;
  /** Vrai la frame où le mur surgit pleinement (signal haptique fort). */
  justPopped: boolean;
}

/**
 * Piège glitch (fiche projet, étape 5, type "mur qui surgit") : un bord normalement
 * ouvert peut, au passage du joueur, se refermer brusquement — bref avertissement
 * (grésillement montant + vibration légère), puis le mur surgit et bloque réellement
 * le passage (vraie collision) quelques secondes avant de se rétracter. Pas de mort :
 * juste une surprise physique temporaire, comme les autres glitchs de la fiche.
 */
export class WallTrap {
  readonly group: THREE.Group;

  private readonly mesh: THREE.Mesh;
  private readonly sound: THREE.PositionalAudio;
  private readonly segment: WallSegment;
  private readonly centerX: number;
  private readonly centerZ: number;
  private readonly warningBuffer: AudioBuffer;
  private readonly impactBuffer: AudioBuffer;

  private phase: Phase = "idle";
  private phaseElapsed = 0;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;

  constructor(
    segment: WallSegment,
    listener: THREE.AudioListener,
    private readonly physics: PhysicsWorld,
  ) {
    this.segment = segment;
    this.centerX = (segment.minX + segment.maxX) / 2;
    this.centerZ = (segment.minZ + segment.maxZ) / 2;

    const width = segment.maxX - segment.minX;
    const depth = segment.maxZ - segment.minZ;
    const alongX = width >= depth;
    const length = alongX ? width : depth;

    this.group = new THREE.Group();
    this.group.name = "wall-trap";

    const geometry = new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS);
    geometry.scale(length, 1, 1);
    if (!alongX) geometry.rotateY(Math.PI / 2);

    this.mesh = new THREE.Mesh(geometry, getWallMaterial());
    this.mesh.position.set(this.centerX, 0, this.centerZ);
    this.mesh.visible = false;
    this.group.add(this.mesh);

    this.warningBuffer = createWarningBuffer(listener.context);
    this.impactBuffer = createImpactBuffer(listener.context);
    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setRefDistance(REF_DISTANCE);
    this.sound.setMaxDistance(MAX_DISTANCE);
    this.sound.position.set(this.centerX, WALL_HEIGHT / 2, this.centerZ);
    this.group.add(this.sound);

    // Collider plein mur, désactivé tant que le mur n'est pas dressé (voir `setSolid`).
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, WALL_HEIGHT / 2, depth / 2)
        .setTranslation(this.centerX, WALL_HEIGHT / 2, this.centerZ)
        .setCollisionGroups(CollisionGroups.static)
        .setEnabled(false),
      this.body,
    );
  }

  private setSolid(solid: boolean): void {
    this.collider.setEnabled(solid);
  }

  private overlapsPlayer(playerPosition: THREE.Vector3): boolean {
    return (
      playerPosition.x > this.segment.minX - PLAYER_CLEARANCE &&
      playerPosition.x < this.segment.maxX + PLAYER_CLEARANCE &&
      playerPosition.z > this.segment.minZ - PLAYER_CLEARANCE &&
      playerPosition.z < this.segment.maxZ + PLAYER_CLEARANCE
    );
  }

  update(playerPosition: THREE.Vector3, deltaSeconds: number): WallTrapUpdateResult {
    this.phaseElapsed += deltaSeconds;
    let corruptionDelta = 0;
    let justWarned = false;
    let justPopped = false;

    const dx = playerPosition.x - this.centerX;
    const dz = playerPosition.z - this.centerZ;
    const distance = Math.hypot(dx, dz);

    switch (this.phase) {
      case "idle":
        if (distance < TRIGGER_RADIUS) {
          this.phase = "warning";
          this.phaseElapsed = 0;
          justWarned = true;
          this.playOneShot(this.warningBuffer, WARNING_VOLUME);
        }
        break;

      case "warning":
        // Jamais surgir sur le joueur : on attend qu'il sorte de l'emprise du mur.
        if (this.phaseElapsed >= WARNING_DURATION && !this.overlapsPlayer(playerPosition)) {
          this.phase = "rising";
          this.phaseElapsed = 0;
          this.mesh.visible = true;
          this.setSolid(true);
          this.playOneShot(this.impactBuffer, IMPACT_VOLUME);
          corruptionDelta = IMPACT_CORRUPTION;
          justPopped = true;
        }
        break;

      case "rising": {
        const t = Math.min(1, this.phaseElapsed / RISE_DURATION);
        this.setRiseFraction(t);
        if (t >= 1) {
          this.phase = "hold";
          this.phaseElapsed = 0;
        }
        break;
      }

      case "hold":
        if (this.phaseElapsed >= HOLD_DURATION) {
          this.phase = "receding";
          this.phaseElapsed = 0;
        }
        break;

      case "receding": {
        const t = Math.max(0, 1 - this.phaseElapsed / RECEDE_DURATION);
        this.setRiseFraction(t);
        if (this.phaseElapsed >= RECEDE_DURATION) {
          this.phase = "cooldown";
          this.phaseElapsed = 0;
          this.mesh.visible = false;
          this.setSolid(false);
        }
        break;
      }

      case "cooldown":
        if (this.phaseElapsed >= COOLDOWN_DURATION) {
          this.phase = "idle";
          this.phaseElapsed = 0;
        }
        break;
    }

    return { corruptionDelta, justWarned, justPopped };
  }

  dispose(): void {
    this.sound.stop();
    this.mesh.geometry.dispose();
    this.physics.world.removeRigidBody(this.body);
  }

  private setRiseFraction(t: number): void {
    this.mesh.scale.y = Math.max(0.001, t);
    this.mesh.position.y = (WALL_HEIGHT / 2) * t;
  }

  private playOneShot(buffer: AudioBuffer, volume: number): void {
    if (this.sound.context.state !== "running") return;
    if (this.sound.isPlaying) this.sound.stop();
    this.sound.setBuffer(buffer);
    this.sound.setVolume(volume);
    this.sound.setLoop(false);
    this.sound.play();
  }
}

/** Avertissement : grondement de béton qui se met à racler, montant, avec des craquements. */
function createWarningBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const duration = 0.45;
  const data = brownNoise(createSamples(sampleRate, duration));
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const progress = t / duration;
    const grind = Math.sin(2 * Math.PI * (38 + progress * 30) * t) * 0.5;
    const crack = Math.random() < 0.004 ? (Math.random() * 2 - 1) * 3 : 0;
    data[i] = (data[i]! * 1.5 + grind + crack) * Math.pow(progress, 1.5);
  }
  lowpass(data, sampleRate, 900);
  return toBuffer(context, fadeEdges(normalize(data, 0.8), sampleRate, 0.005));
}

/** Impact : choc sourd et massif, queue de réverbération dans les couloirs. */
function createImpactBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, 1.8);
  const rubble = brownNoise(createSamples(sampleRate, 1.8));
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const thump = Math.sin(2 * Math.PI * 48 * t * (1 - t * 0.4)) * Math.exp(-t * 7);
    const crack = (Math.random() * 2 - 1) * Math.exp(-t * 40) * 0.8;
    data[i] = thump + crack + rubble[i]! * Math.exp(-t * 5) * 0.8;
  }
  lowpass(data, sampleRate, 700);
  reverb(data, sampleRate, 0.45, 1.8);
  return toBuffer(context, fadeEdges(normalize(data, 0.9), sampleRate, 0.005));
}
