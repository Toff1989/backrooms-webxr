import * as THREE from "three";
import { applyVhsEffect } from "./vhsMaterial";

const TRAP_COLOR = 0xaa1155;
const MARKER_RADIUS = 0.45;
const FLICKER_SPEED = 14;
const TRIGGER_RADIUS = 1.6;
const CORRUPTION_RATE_PER_SECOND = 0.35;

const CRACKLE_DURATION_SECONDS = 1.6;
const CRACKLE_VOLUME = 0.35;
const CRACKLE_REF_DISTANCE = 1.5;
const CRACKLE_MAX_DISTANCE = 8;

export interface GlitchTrapUpdateResult {
  /** Corruption à ajouter cette frame (0 si le joueur est hors de portée de déclenchement). */
  corruptionDelta: number;
  /** Vrai la frame où le joueur entre dans le rayon de déclenchement (pour le signal haptique). */
  justTriggered: boolean;
}

/**
 * Piège glitch (fiche projet, étape 5, type "zone de corruption") : marqueur au sol
 * scintillant + grésillement audio positionnel comme signaux avant-coureurs. Aucune
 * collision — au contact, seule la corruption visuelle cumulable augmente (pas de mort,
 * pas de distorsion de la position/rotation caméra).
 */
export class GlitchTrap {
  readonly group: THREE.Group;

  private readonly material: THREE.MeshStandardMaterial;
  private readonly sound: THREE.PositionalAudio;
  private readonly worldX: number;
  private readonly worldZ: number;
  private playRequested = false;
  private playerWasInside = false;

  constructor(worldX: number, worldZ: number, listener: THREE.AudioListener) {
    this.worldX = worldX;
    this.worldZ = worldZ;

    this.group = new THREE.Group();
    this.group.name = "glitch-trap";
    this.group.position.set(worldX, 0.02, worldZ);

    this.material = new THREE.MeshStandardMaterial({
      color: TRAP_COLOR,
      emissive: TRAP_COLOR,
      emissiveIntensity: 1,
      roughness: 0.6,
      transparent: true,
      opacity: 0.85,
    });
    applyVhsEffect(this.material);

    const marker = new THREE.Mesh(new THREE.CircleGeometry(MARKER_RADIUS, 16), this.material);
    marker.rotation.x = -Math.PI / 2;
    this.group.add(marker);

    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setBuffer(createCrackleBuffer(listener.context));
    this.sound.setLoop(true);
    this.sound.setRefDistance(CRACKLE_REF_DISTANCE);
    this.sound.setMaxDistance(CRACKLE_MAX_DISTANCE);
    this.sound.setVolume(CRACKLE_VOLUME);
    this.group.add(this.sound);
  }

  /** À appeler une fois la session XR démarrée (politique d'autoplay des navigateurs). */
  play(): void {
    if (this.playRequested) return;
    this.playRequested = true;
    if (this.sound.context.state === "running") this.sound.play();
  }

  update(playerPosition: THREE.Vector3, elapsedSeconds: number, deltaSeconds: number): GlitchTrapUpdateResult {
    const flicker = 0.5 + 0.5 * Math.sin(elapsedSeconds * FLICKER_SPEED + this.worldX * 13.1) * Math.sin(elapsedSeconds * FLICKER_SPEED * 0.37);
    this.material.emissiveIntensity = 0.4 + flicker * 1.4;

    if (this.playRequested && !this.sound.isPlaying && this.sound.context.state === "running") {
      this.sound.play();
    }

    const dx = playerPosition.x - this.worldX;
    const dz = playerPosition.z - this.worldZ;
    const distance = Math.hypot(dx, dz);
    const playerIsInside = distance < TRIGGER_RADIUS;
    const justTriggered = playerIsInside && !this.playerWasInside;
    this.playerWasInside = playerIsInside;

    if (!playerIsInside) return { corruptionDelta: 0, justTriggered: false };

    const proximity = 1 - distance / TRIGGER_RADIUS; // 0..1, plus fort au centre
    return { corruptionDelta: CORRUPTION_RATE_PER_SECOND * proximity * deltaSeconds, justTriggered };
  }

  dispose(): void {
    this.sound.stop();
    this.material.dispose();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

function createCrackleBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * CRACKLE_DURATION_SECONDS);
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    // Grésillement : bruit blanc en bouffées aléatoires, pas un ton continu.
    const burst = Math.random() < 0.12 ? 1 : 0.15;
    data[i] = (Math.random() * 2 - 1) * burst * 0.5;
  }

  return buffer;
}
