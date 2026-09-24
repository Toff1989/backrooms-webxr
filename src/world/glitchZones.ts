import * as THREE from "three";
import { bandpass, createSamples, fadeEdges, highpass, normalize, reverb, toBuffer } from "../assets/audio/synth";
import { MAX_GLITCH_ZONES, setGlitchZones, type ShaderGlitchZone } from "./vhsMaterial";

export const GlitchKind = {
  corruption: 0,
  teleporter: 1,
  phantom: 2,
} as const;

/**
 * Zone de glitch lue par le shader VHS de toutes les surfaces (voir `vhsMaterial.ts`) :
 * pas d'objet par-dessus le décor, c'est le sol, les murs, le plafond et les meubles
 * eux-mêmes qui se déchirent autour du centre. Mutable : le propriétaire anime l'intensité.
 */
export interface GlitchZone extends ShaderGlitchZone {}

const zones = new Set<GlitchZone>();
/** Au-delà (m), une zone n'est pas envoyée au shader : invisible dans le brouillard de toute façon. */
const MAX_SHADER_DISTANCE = 16;
const sorted: GlitchZone[] = [];

export function addGlitchZone(zone: GlitchZone): GlitchZone {
  zones.add(zone);
  return zone;
}

export function removeGlitchZone(zone: GlitchZone): void {
  zones.delete(zone);
}

/** Envoie au shader les zones actives les plus proches du joueur (budget fixe d'uniformes). */
export function flushGlitchZones(playerPosition: THREE.Vector3): void {
  sorted.length = 0;
  const distance = (zone: GlitchZone): number => Math.hypot(zone.x - playerPosition.x, zone.z - playerPosition.z);
  for (const zone of zones) if (zone.intensity > 0.001 && distance(zone) - zone.radius < MAX_SHADER_DISTANCE) sorted.push(zone);
  if (sorted.length > MAX_GLITCH_ZONES) sorted.sort((a, b) => distance(a) - distance(b));
  setGlitchZones(sorted);
}

interface Phantom {
  zone: GlitchZone;
  age: number;
  life: number;
  peak: number;
}

const PHANTOM_MIN_DISTANCE = 3;
const PHANTOM_MAX_DISTANCE = 11;

/**
 * Glitchs fantômes : sans piège ni conséquence, un pan de mur ou de sol se déchire
 * brièvement quelque part autour du joueur (plus souvent en profondeur, dans le noir, et
 * quand la corruption est haute), avec un craquement positionnel. Entretient l'idée que
 * la réalité ne tient qu'à un fil — et qu'on ne sait jamais si c'est un piège.
 */
export class PhantomGlitches {
  private readonly phantoms: Phantom[] = [];
  private readonly sound: THREE.PositionalAudio;
  private readonly buffers: AudioBuffer[] = [];
  private timer = 6;

  constructor(scene: THREE.Scene, listener: THREE.AudioListener) {
    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setRefDistance(2);
    this.sound.setMaxDistance(18);
    this.sound.setRolloffFactor(1.4);
    scene.add(this.sound);
    for (let i = 0; i < 3; i++) this.buffers.push(createPhantomBuffer(listener.context));
  }

  /** Force un glitch fantôme à une position donnée (arrivée d'un téléporteur, etc.). */
  spawnAt(x: number, y: number, z: number, radius: number, peak: number, life: number): void {
    const zone = addGlitchZone({ x, y, z, radius, intensity: 0, seed: Math.random(), kind: GlitchKind.phantom });
    this.phantoms.push({ zone, age: 0, life, peak });
  }

  update(deltaSeconds: number, playerPosition: THREE.Vector3, depth: number, darkness: number, corruption: number): void {
    const rate = 1 + depth * 0.15 + darkness * 1.5 + corruption * 2;
    this.timer -= deltaSeconds * rate;
    if (this.timer <= 0) {
      this.timer = 9 + Math.random() * 16;
      const angle = Math.random() * Math.PI * 2;
      const distance = PHANTOM_MIN_DISTANCE + Math.random() * (PHANTOM_MAX_DISTANCE - PHANTOM_MIN_DISTANCE);
      const x = playerPosition.x + Math.cos(angle) * distance;
      const z = playerPosition.z + Math.sin(angle) * distance;
      const y = 0.4 + Math.random() * 1.9;
      this.spawnAt(x, y, z, 1 + Math.random() * 1.6, 0.6 + Math.random() * 0.4, 0.25 + Math.random() * 1.8);
      this.playAt(x, y, z);
    }

    for (let i = this.phantoms.length - 1; i >= 0; i--) {
      const phantom = this.phantoms[i]!;
      phantom.age += deltaSeconds;
      const t = phantom.age / phantom.life;
      if (t >= 1) {
        removeGlitchZone(phantom.zone);
        this.phantoms.splice(i, 1);
        continue;
      }
      // Attaque brutale, extinction saccadée (pas de fondu propre).
      const envelope = Math.min(1, t * 12) * (1 - t);
      phantom.zone.intensity = phantom.peak * envelope * (Math.random() < 0.2 ? 0.3 : 1);
    }
  }

  clear(): void {
    for (const phantom of this.phantoms) removeGlitchZone(phantom.zone);
    this.phantoms.length = 0;
  }

  private playAt(x: number, y: number, z: number): void {
    if (this.sound.context.state !== "running") return;
    if (this.sound.isPlaying) this.sound.stop();
    this.sound.position.set(x, y, z);
    this.sound.setBuffer(this.buffers[Math.floor(Math.random() * this.buffers.length)]!);
    this.sound.setVolume(0.35 + Math.random() * 0.25);
    this.sound.play();
  }
}

/** Craquement électrique bref : grésillement de bande bégayé, sourd, avec un bourdon secteur. */
function createPhantomBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, 0.9);
  let gate = 1;
  for (let i = 0; i < data.length; i++) {
    if (i % Math.floor(sampleRate * 0.018) === 0) gate = Math.random() < 0.55 ? 1 : 0.05;
    const t = i / sampleRate;
    const decay = Math.exp(-t * 4);
    const buzz = Math.tanh(Math.sin(2 * Math.PI * 50 * t) * 4) * 0.25;
    data[i] = ((Math.random() * 2 - 1) * gate + buzz * gate) * decay;
  }
  bandpass(data, sampleRate, 1400, 0.8);
  highpass(data, sampleRate, 120);
  reverb(data, sampleRate, 0.35, 1.2);
  return toBuffer(context, fadeEdges(normalize(data, 0.8), sampleRate));
}
