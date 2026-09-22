import * as THREE from "three";
import { WALL_HEIGHT } from "../shared/constants";
import { applyVhsEffect } from "./vhsMaterial";

const BEACON_COLOR = 0x36e8ff;
const RING_RADIUS = 0.5;
const RING_TUBE = 0.06;
const BASE_EMISSIVE_INTENSITY = 1.4;
const PULSE_AMPLITUDE = 0.6;
const PULSE_SPEED = 2.4;

const BEACON_TONE_HZ = 880;
const BEACON_OVERTONE_HZ = 1320;
const BEACON_PULSE_DURATION_SECONDS = 2.2;
const BEACON_VOLUME = 0.5;
const BEACON_REF_DISTANCE = 2;
const BEACON_MAX_DISTANCE = 20;

/**
 * Marqueur de sortie du level : anneau émissif d'une couleur nettement différente des
 * néons (signal visuel), pulsé dans le temps, + balise sonore positionnelle (signal
 * audio) — "sortie... signalée par des indices (son, lumière différente)" (fiche projet).
 */
export class ExitBeacon {
  readonly group: THREE.Group;

  private readonly material: THREE.MeshStandardMaterial;
  private readonly sound: THREE.PositionalAudio;
  private playRequested = false;

  constructor(worldX: number, worldZ: number, listener: THREE.AudioListener) {
    this.group = new THREE.Group();
    this.group.name = "exit-beacon";
    this.group.position.set(worldX, 0, worldZ);

    this.material = new THREE.MeshStandardMaterial({
      color: BEACON_COLOR,
      emissive: BEACON_COLOR,
      emissiveIntensity: BASE_EMISSIVE_INTENSITY,
      roughness: 0.4,
    });
    applyVhsEffect(this.material);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 12, 28), this.material);
    ring.position.y = WALL_HEIGHT / 2;
    this.group.add(ring);

    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setBuffer(createBeaconBuffer(listener.context));
    this.sound.setLoop(true);
    this.sound.setRefDistance(BEACON_REF_DISTANCE);
    this.sound.setMaxDistance(BEACON_MAX_DISTANCE);
    this.sound.setVolume(BEACON_VOLUME);
    this.sound.position.y = WALL_HEIGHT / 2;
    this.group.add(this.sound);
  }

  /** À appeler une fois la session XR démarrée (politique d'autoplay des navigateurs). */
  play(): void {
    if (this.playRequested) return;
    this.playRequested = true;
    if (this.sound.context.state === "running") this.sound.play();
  }

  update(elapsedSeconds: number): void {
    this.material.emissiveIntensity = BASE_EMISSIVE_INTENSITY + Math.sin(elapsedSeconds * PULSE_SPEED) * PULSE_AMPLITUDE;
    if (this.playRequested && !this.sound.isPlaying && this.sound.context.state === "running") {
      this.sound.play();
    }
  }

  dispose(): void {
    this.sound.stop();
    this.material.dispose();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

function createBeaconBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * BEACON_PULSE_DURATION_SECONDS);
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const envelope = Math.max(0, Math.sin((t / BEACON_PULSE_DURATION_SECONDS) * Math.PI));
    const tone = Math.sin(2 * Math.PI * BEACON_TONE_HZ * t) * 0.5 + Math.sin(2 * Math.PI * BEACON_OVERTONE_HZ * t) * 0.2;
    data[i] = tone * Math.pow(envelope, 3) * 0.6;
  }

  return buffer;
}
