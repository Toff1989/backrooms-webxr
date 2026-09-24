import * as THREE from "three";
import { bandpass, brownNoise, createSamples, fadeEdges, highpass, lowpass, makeLoopable, normalize, reverb, toBuffer } from "./synth";

const BUZZ_VOLUME = 0.07;
const ROOM_VOLUME = 0.1;
/** Nappe d'angoisse : quasi muette sous les néons, elle enfle dans les zones éteintes. */
const DREAD_MIN_VOLUME = 0.03;
const DREAD_MAX_VOLUME = 0.32;

const EVENT_MIN_DISTANCE = 9;
const EVENT_MAX_DISTANCE = 18;

type DistantEventKind = "steps" | "knock" | "thud" | "groan" | "surge" | "breath";
const EVENT_KINDS: DistantEventKind[] = ["steps", "knock", "thud", "groan", "surge", "breath"];

/**
 * Ambiance sonore (générée procéduralement, pas de fichier audio) :
 * - bourdonnement électrique des néons (100/120 Hz riche en harmoniques, qui ondule) et
 *   ton de pièce (grondement sourd de ventilation) ;
 * - nappe d'angoisse (drone grave désaccordé qui bat lentement) dont le volume suit
 *   l'obscurité à la position du joueur — le noir s'entend avant de se voir ;
 * - événements lointains positionnels (pas qui s'arrêtent, coups contre un mur, impact
 *   sourd, grincement de structure, surtension, souffle) : jamais proches, jamais
 *   visibles — plus fréquents en profondeur et dans le noir.
 */
export class AmbientHum {
  private readonly buzz: THREE.Audio;
  private readonly room: THREE.Audio;
  private readonly dread: THREE.Audio;
  private readonly eventVoice: THREE.PositionalAudio;
  private readonly eventBuffers = new Map<DistantEventKind, AudioBuffer[]>();
  private started = false;
  private dreadLevel = 0;
  private nextEvent = 14;
  private lastEvent: DistantEventKind | null = null;

  constructor(
    private readonly listener: THREE.AudioListener,
    scene: THREE.Scene,
  ) {
    const context = listener.context;
    this.buzz = this.createLoop(createBuzzBuffer(context), BUZZ_VOLUME);
    this.room = this.createLoop(createRoomToneBuffer(context), ROOM_VOLUME);
    this.dread = this.createLoop(createDreadBuffer(context), DREAD_MIN_VOLUME);

    this.eventVoice = new THREE.PositionalAudio(listener);
    this.eventVoice.setRefDistance(3);
    this.eventVoice.setMaxDistance(30);
    this.eventVoice.setRolloffFactor(0.9);
    scene.add(this.eventVoice);
  }

  private createLoop(buffer: AudioBuffer, volume: number): THREE.Audio {
    const sound = new THREE.Audio(this.listener);
    sound.setBuffer(buffer);
    sound.setLoop(true);
    sound.setVolume(volume);
    return sound;
  }

  /**
   * À appeler suite à un geste utilisateur (ex. entrée en session XR) : les navigateurs
   * bloquent la lecture audio automatique hors interaction utilisateur.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.listener.context.state === "suspended") {
      this.listener.context.resume().catch(() => {});
    }
    this.buzz.play();
    this.room.play();
    this.dread.play();
  }

  /**
   * `darkness` : 0 sous les néons, 1 dans une zone éteinte. `lightLevel` : niveau des néons
   * (baisse avec la profondeur et quand ils clignotent) — le bourdonnement le suit.
   */
  update(deltaSeconds: number, listenerPosition: THREE.Vector3, darkness: number, depth: number, lightLevel: number): void {
    if (!this.started) return;
    this.dreadLevel = THREE.MathUtils.damp(this.dreadLevel, Math.min(1, darkness + depth * 0.04), 0.8, deltaSeconds);
    this.dread.setVolume(DREAD_MIN_VOLUME + (DREAD_MAX_VOLUME - DREAD_MIN_VOLUME) * this.dreadLevel);
    this.buzz.setVolume(BUZZ_VOLUME * (1 - darkness * 0.85) * THREE.MathUtils.clamp(lightLevel, 0.1, 1));

    this.nextEvent -= deltaSeconds * (1 + darkness * 1.2 + depth * 0.1);
    if (this.nextEvent <= 0) {
      this.nextEvent = 16 + Math.random() * 28;
      this.playDistantEvent(listenerPosition);
    }
  }

  private playDistantEvent(listenerPosition: THREE.Vector3): void {
    if (this.listener.context.state !== "running" || this.eventVoice.isPlaying) return;
    let kind: DistantEventKind;
    do kind = EVENT_KINDS[Math.floor(Math.random() * EVENT_KINDS.length)]!;
    while (kind === this.lastEvent);
    this.lastEvent = kind;

    let variants = this.eventBuffers.get(kind);
    if (!variants) {
      variants = [createEventBuffer(this.listener.context, kind), createEventBuffer(this.listener.context, kind)];
      this.eventBuffers.set(kind, variants);
    }

    const angle = Math.random() * Math.PI * 2;
    const distance = EVENT_MIN_DISTANCE + Math.random() * (EVENT_MAX_DISTANCE - EVENT_MIN_DISTANCE);
    this.eventVoice.position.set(
      listenerPosition.x + Math.cos(angle) * distance,
      kind === "steps" ? 0.2 : 1 + Math.random() * 1.5,
      listenerPosition.z + Math.sin(angle) * distance,
    );
    this.eventVoice.setBuffer(variants[Math.floor(Math.random() * variants.length)]!);
    this.eventVoice.setVolume(kind === "breath" ? 0.5 : 0.9);
    this.eventVoice.play();
  }
}

/** Néons : 100 Hz saturé (harmoniques impaires = grésillement électrique), qui ondule lentement. */
function createBuzzBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, 4);
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const wobble = 1 + Math.sin(2 * Math.PI * 0.25 * t) * 0.25 + Math.sin(2 * Math.PI * 1.75 * t) * 0.1;
    const buzz = Math.tanh(Math.sin(2 * Math.PI * 100 * t) * 3) * 0.5 + Math.sin(2 * Math.PI * 120 * t) * 0.2;
    const crackle = Math.random() < 0.0006 ? (Math.random() * 2 - 1) * 2 : 0;
    data[i] = buzz * wobble + crackle + (Math.random() * 2 - 1) * 0.03;
  }
  lowpass(data, sampleRate, 1400);
  return toBuffer(context, normalize(makeLoopable(data, sampleRate), 0.8));
}

/** Ton de pièce : ventilation lointaine, grondement sourd et large. */
function createRoomToneBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = brownNoise(createSamples(sampleRate, 6));
  lowpass(data, sampleRate, 260);
  highpass(data, sampleRate, 25);
  return toBuffer(context, normalize(makeLoopable(data, sampleRate, 0.8), 0.8));
}

/** Drone grave désaccordé : deux fondamentales proches qui battent (~0,5 Hz), sous-grave qui enfle. */
function createDreadBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const seconds = 8;
  const data = createSamples(sampleRate, seconds);
  const air = brownNoise(createSamples(sampleRate, seconds));
  bandpass(air, sampleRate, 180, 2.5);
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / seconds);
    const drone = Math.sin(2 * Math.PI * 41 * t) * 0.5 + Math.sin(2 * Math.PI * 41.5 * t) * 0.5 + Math.sin(2 * Math.PI * 58.25 * t) * 0.18;
    const high = Math.sin(2 * Math.PI * 311 * t + Math.sin(2 * Math.PI * 0.125 * t) * 3) * 0.035;
    data[i] = drone * swell + air[i]! * 0.6 + high;
  }
  return toBuffer(context, normalize(makeLoopable(data, sampleRate, 1), 0.8));
}

function createEventBuffer(context: BaseAudioContext, kind: DistantEventKind): AudioBuffer {
  const sampleRate = context.sampleRate;
  let data: Float32Array;

  switch (kind) {
    case "steps": {
      // Quelques pas lourds, irréguliers, qui s'arrêtent net.
      const count = 3 + Math.floor(Math.random() * 5);
      data = createSamples(sampleRate, count * 0.62 + 2);
      let time = 0.1;
      for (let s = 0; s < count; s++) {
        addImpact(data, sampleRate, time, 70 + Math.random() * 25, 0.09, 0.8 + Math.random() * 0.3);
        time += 0.5 + Math.random() * 0.22;
      }
      lowpass(data, sampleRate, 700);
      reverb(data, sampleRate, 0.45, 1.5);
      break;
    }
    case "knock": {
      // Deux ou trois coups contre un mur creux.
      const count = 2 + Math.floor(Math.random() * 2);
      data = createSamples(sampleRate, 2.6);
      for (let s = 0; s < count; s++) addImpact(data, sampleRate, 0.1 + s * (0.28 + Math.random() * 0.1), 140, 0.05, 1);
      bandpass(data, sampleRate, 420, 1.2);
      reverb(data, sampleRate, 0.5, 1.6);
      break;
    }
    case "thud": {
      // Impact lourd très loin (quelque chose de massif est tombé).
      data = createSamples(sampleRate, 3.5);
      addImpact(data, sampleRate, 0.05, 42, 0.5, 1);
      brownNoiseBurst(data, sampleRate, 0.05, 0.4, 0.7);
      lowpass(data, sampleRate, 300);
      reverb(data, sampleRate, 0.6, 2);
      break;
    }
    case "groan": {
      // Grincement de structure métallique : frottement résonant qui glisse en fréquence.
      const seconds = 2.2 + Math.random() * 1.5;
      data = createSamples(sampleRate, seconds + 1.5);
      const start = 70 + Math.random() * 40;
      let phase = 0;
      for (let i = 0; i < sampleRate * seconds; i++) {
        const t = i / sampleRate;
        const p = t / seconds;
        const freq = start * (1 - p * 0.35) + Math.sin(t * 23) * 3;
        phase += (2 * Math.PI * freq) / sampleRate;
        const envelope = Math.sin(Math.PI * p) * (0.6 + 0.4 * Math.random());
        data[i] = (Math.tanh(Math.sin(phase) * 5) * 0.5 + (Math.random() * 2 - 1) * 0.3) * envelope;
      }
      bandpass(data, sampleRate, 520, 3);
      reverb(data, sampleRate, 0.55, 1.8);
      break;
    }
    case "surge": {
      // Surtension électrique : le bourdonnement enfle et crépite puis s'éteint.
      data = createSamples(sampleRate, 2.8);
      for (let i = 0; i < sampleRate * 1.6; i++) {
        const t = i / sampleRate;
        const envelope = Math.pow(Math.sin((Math.PI * t) / 1.6), 2);
        const arc = Math.random() < 0.02 ? (Math.random() * 2 - 1) * 3 : 0;
        data[i] = (Math.tanh(Math.sin(2 * Math.PI * 100 * t) * 8) * 0.4 + arc) * envelope;
      }
      lowpass(data, sampleRate, 2200);
      reverb(data, sampleRate, 0.4, 1.3);
      break;
    }
    case "breath": {
      // Souffle long et grave, presque inaudible : on n'est pas sûr de l'avoir entendu.
      data = createSamples(sampleRate, 3.5);
      for (let i = 0; i < sampleRate * 2.6; i++) {
        const t = i / sampleRate;
        const inhale = t < 1.1 ? Math.sin((Math.PI * t) / 1.1) : 0;
        const exhale = t >= 1.3 ? Math.sin((Math.PI * (t - 1.3)) / 1.3) : 0;
        data[i] = (Math.random() * 2 - 1) * (inhale * 0.6 + exhale);
      }
      bandpass(data, sampleRate, 650, 1.6);
      lowpass(data, sampleRate, 1200);
      reverb(data, sampleRate, 0.5, 1.4);
      break;
    }
  }

  return toBuffer(context, fadeEdges(normalize(data, 0.85), sampleRate, 0.02));
}

/** Impact sourd : sinus grave à décroissance rapide + claquement de bruit. */
function addImpact(data: Float32Array, sampleRate: number, at: number, frequency: number, decaySeconds: number, gain: number): void {
  const start = Math.floor(at * sampleRate);
  const length = Math.floor(decaySeconds * 6 * sampleRate);
  for (let i = 0; i < length && start + i < data.length; i++) {
    const t = i / sampleRate;
    const body = Math.sin(2 * Math.PI * frequency * t * (1 - t * 0.5)) * Math.exp(-t / decaySeconds);
    const click = (Math.random() * 2 - 1) * Math.exp(-t / 0.008) * 0.6;
    data[start + i] = data[start + i]! + (body + click) * gain;
  }
}

function brownNoiseBurst(data: Float32Array, sampleRate: number, at: number, seconds: number, gain: number): void {
  const start = Math.floor(at * sampleRate);
  const burst = brownNoise(createSamples(sampleRate, seconds));
  for (let i = 0; i < burst.length && start + i < data.length; i++) {
    data[start + i] = data[start + i]! + burst[i]! * gain * Math.exp(-i / (sampleRate * seconds * 0.3));
  }
}
