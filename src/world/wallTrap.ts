import * as THREE from "three";
import { bandpass, brownNoise, createSamples, fadeEdges, lowpass, normalize, reverb, toBuffer } from "../assets/audio/synth";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { WALL_HEIGHT, WALL_THICKNESS } from "../shared/constants";
import type { WallSegment } from "../shared/chunkLayout";
import { getWallMaterial } from "./materials";
import { worldSound } from "./worldSound";

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
  private readonly soundPosition: THREE.Vector3;
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

    // Buffers partagés : les recalculer (réverbe en JS) à chaque chargement de chunk saccadait le streaming.
    warningBuffer ??= createWarningBuffer(listener.context);
    impactBuffer ??= createImpactBuffer(listener.context);
    this.warningBuffer = warningBuffer;
    this.impactBuffer = impactBuffer;
    // Son joué par le groupe de voix partagées (voir worldSound.ts), pas une voix par mur.
    this.soundPosition = new THREE.Vector3(this.centerX, WALL_HEIGHT / 2, this.centerZ);

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
    this.mesh.geometry.dispose();
    this.physics.world.removeRigidBody(this.body);
  }

  private setRiseFraction(t: number): void {
    this.mesh.scale.y = Math.max(0.001, t);
    this.mesh.position.y = (WALL_HEIGHT / 2) * t;
  }

  private playOneShot(buffer: AudioBuffer, volume: number): void {
    worldSound.playAt(buffer, this.soundPosition, volume);
  }
}

let warningBuffer: AudioBuffer | null = null;
let impactBuffer: AudioBuffer | null = null;

/**
 * Avertissement : rien de tonal. Un grondement grave qui enfle (on le sent plus qu'on ne
 * l'entend), des craquements secs de plâtre sous tension et un filet de poussière qui tombe.
 */
function createWarningBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const duration = 0.5;
  const rumble = lowpass(brownNoise(createSamples(sampleRate, duration)), sampleRate, 140);
  const dust = createSamples(sampleRate, duration);
  for (let i = 0; i < dust.length; i++) dust[i] = Math.random() < 0.02 ? (Math.random() * 2 - 1) : 0;
  bandpass(dust, sampleRate, 4500, 0.8);
  const data = createSamples(sampleRate, duration);
  for (let i = 0; i < data.length; i++) {
    const progress = i / data.length;
    data[i] = rumble[i]! * 3 * Math.pow(progress, 1.3) + dust[i]! * 0.5 * progress;
  }
  // Craquements : 3 à 5 claquements secs et courts, de plus en plus rapprochés.
  const cracks = 3 + Math.floor(Math.random() * 3);
  for (let k = 0; k < cracks; k++) {
    const start = Math.floor(sampleRate * duration * (0.25 + 0.7 * Math.pow(k / cracks, 0.7)));
    const crack = createSamples(sampleRate, 0.03);
    for (let i = 0; i < crack.length; i++) crack[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleRate * 0.004));
    bandpass(crack, sampleRate, 1800 + Math.random() * 1500, 1.5);
    for (let i = 0; i < crack.length && start + i < data.length; i++) data[start + i] = data[start + i]! + crack[i]! * 1.4;
  }
  return toBuffer(context, fadeEdges(normalize(data, 0.8), sampleRate, 0.01));
}

/**
 * Impact : un claquement sourd de béton (bruit filtré, pas de sinus qui "rebondit"), le
 * souffle d'air déplacé, puis quelques débris qui retombent, dans la réverbération de la pièce.
 */
function createImpactBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const seconds = 2;
  const data = createSamples(sampleRate, seconds);
  // Corps du choc : bruit rose/brun très grave, attaque instantanée, extinction rapide.
  const slam = lowpass(brownNoise(createSamples(sampleRate, 0.4)), sampleRate, 220);
  const body = bandpass(brownNoise(createSamples(sampleRate, 0.4)), sampleRate, 85, 2.5);
  for (let i = 0; i < slam.length; i++) {
    const t = i / sampleRate;
    data[i] = (slam[i]! * 4 + body[i]! * 6) * Math.exp(-t * 14);
  }
  // Claquement initial : transitoire courte, médium.
  const snap = bandpass(createSamples(sampleRate, 0.02).map(() => Math.random() * 2 - 1), sampleRate, 900, 0.8);
  for (let i = 0; i < snap.length; i++) data[i] = data[i]! + snap[i]! * Math.exp(-i / (sampleRate * 0.003)) * 1.5;
  // Débris : petits impacts épars après le choc.
  for (let k = 0; k < 7; k++) {
    const start = Math.floor(sampleRate * (0.08 + Math.random() * 0.6));
    const size = Math.random();
    const debris = bandpass(createSamples(sampleRate, 0.05).map(() => Math.random() * 2 - 1), sampleRate, 1200 + size * 2500, 1.2);
    for (let i = 0; i < debris.length && start + i < data.length; i++) {
      data[start + i] = data[start + i]! + debris[i]! * Math.exp(-i / (sampleRate * 0.008)) * (0.2 + size * 0.3);
    }
  }
  reverb(data, sampleRate, 0.4, 1.9);
  return toBuffer(context, fadeEdges(normalize(data, 0.9), sampleRate, 0.005));
}
