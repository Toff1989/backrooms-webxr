import * as THREE from "three";
import { createObjectSound, LOOPING_SOUNDS, type ObjectSoundName } from "../assets/audio/objectSounds";
import { queueWarmup } from "../assets/audio/synth";

/** Voix 3D : peu nombreuses, réutilisées (le thread audio du Quest sature vite, voir `worldSound`). */
const ONE_SHOT_VOICES = 5;
const LOOP_VOICES = 4;

export interface LoopHandle {
  setVolume(volume: number): void;
  stop(): void;
}

interface LoopVoice {
  audio: THREE.PositionalAudio;
  owner: THREE.Object3D | null;
}

/**
 * Sons des objets manipulables, spatialisés : quelques voix ponctuelles (chocs, déclics) posées
 * à l'endroit du son, et quelques voix en boucle accrochées à l'objet qui les produit (télé qui
 * grésille, horloge, projecteur). Tous les sons sont synthétisés à l'avance (warmup).
 */
export class ObjectAudio {
  private readonly buffers = new Map<ObjectSoundName, AudioBuffer>();
  private readonly oneShots: THREE.PositionalAudio[] = [];
  private readonly loops: LoopVoice[] = [];
  private next = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly listener: THREE.AudioListener,
  ) {
    for (let i = 0; i < ONE_SHOT_VOICES; i++) {
      const voice = new THREE.PositionalAudio(listener);
      voice.setRefDistance(1.5);
      voice.setMaxDistance(18);
      scene.add(voice);
      this.oneShots.push(voice);
    }
    for (let i = 0; i < LOOP_VOICES; i++) {
      const audio = new THREE.PositionalAudio(listener);
      audio.setRefDistance(1.2);
      audio.setMaxDistance(14);
      audio.setLoop(true);
      scene.add(audio);
      this.loops.push({ audio, owner: null });
    }
    const names: ObjectSoundName[] = [
      "tvStatic", "tvOn", "tvOff", "alarm", "tick", "whistle", "squeak", "gong", "shatter", "crumple", "thump", "bang", "clank",
      "beep", "spray", "wheel", "flick", "creak", "rattle", "suction", "rustle", "metalClick", "crackle", "buzz",
    ];
    for (const name of names) queueWarmup(() => this.buffer(name));
  }

  private buffer(name: ObjectSoundName): AudioBuffer {
    let buffer = this.buffers.get(name);
    if (!buffer) {
      buffer = createObjectSound(this.listener.context, name);
      this.buffers.set(name, buffer);
    }
    return buffer;
  }

  private get running(): boolean {
    return this.listener.context.state === "running";
  }

  /** Son ponctuel à une position du monde. */
  playAt(name: ObjectSoundName, position: THREE.Vector3, volume = 0.8): void {
    if (!this.running) return;
    const voice = this.oneShots[this.next]!;
    this.next = (this.next + 1) % this.oneShots.length;
    if (voice.isPlaying) voice.stop();
    voice.position.copy(position);
    voice.setBuffer(this.buffer(name));
    voice.setLoop(false);
    voice.setVolume(volume);
    voice.play();
  }

  /**
   * Son en boucle accroché à `owner` (il le suit). Null si toutes les voix de boucle sont
   * prises : le son est alors simplement muet, jamais une erreur.
   */
  loop(name: ObjectSoundName, owner: THREE.Object3D, volume = 0.6): LoopHandle | null {
    if (!this.running || !LOOPING_SOUNDS.has(name) && name !== "alarm") return null;
    const voice = this.loops.find((candidate) => candidate.owner === null);
    if (!voice) return null;
    voice.owner = owner;
    owner.add(voice.audio);
    voice.audio.position.set(0, 0, 0);
    voice.audio.setBuffer(this.buffer(name));
    voice.audio.setVolume(volume);
    voice.audio.play();
    return {
      setVolume: (value) => {
        if (voice.owner === owner) voice.audio.setVolume(value);
      },
      stop: () => {
        if (voice.owner !== owner) return;
        if (voice.audio.isPlaying) voice.audio.stop();
        this.scene.add(voice.audio);
        voice.owner = null;
      },
    };
  }
}
