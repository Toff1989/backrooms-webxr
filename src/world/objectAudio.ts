import * as THREE from "three";
import dishes02Url from "../assets/audio/cc0/dishes_02.ogg?url";
import door02Url from "../assets/audio/cc0/door_02.ogg?url";
import glass03Url from "../assets/audio/cc0/glass_03.ogg?url";
import gong02Url from "../assets/audio/cc0/gong_02.ogg?url";
import hit03Url from "../assets/audio/cc0/hit_03.ogg?url";
import metal02Url from "../assets/audio/cc0/metal_02.ogg?url";
import metal09Url from "../assets/audio/cc0/metal_09.ogg?url";
import microwaveCloseUrl from "../assets/audio/cc0/microwave_door_close.ogg?url";
import microwaveOpenUrl from "../assets/audio/cc0/microwave_door_open.ogg?url";
import noise01Url from "../assets/audio/cc0/noise_01.ogg?url";
import slam05Url from "../assets/audio/cc0/slam_05.ogg?url";
import spring03Url from "../assets/audio/cc0/spring_03.ogg?url";
import switch01Url from "../assets/audio/cc0/switch_01.ogg?url";
import tools04Url from "../assets/audio/cc0/tools_04.ogg?url";
import wooden01Url from "../assets/audio/cc0/wooden_01.ogg?url";
import { createObjectSound, LOOPING_SOUNDS, type ObjectSoundName } from "../assets/audio/objectSounds";
import { queueWarmup } from "../assets/audio/synth";

/** Voix 3D : peu nombreuses, réutilisées (le thread audio du Quest sature vite, voir `worldSound`). */
const ONE_SHOT_VOICES = 5;
const LOOP_VOICES = 4;
// Choisis à l'écoute, voir l'artefact "Casting des sons" (100 CC0 SFX, rubberduck).
const EXTERNAL_SOUNDS: Partial<Record<ObjectSoundName, string>> = {
  tvOn: microwaveOpenUrl,
  tvOff: microwaveCloseUrl,
  shatter: glass03Url,
  potBreak: dishes02Url,
  crumple: slam05Url,
  thump: wooden01Url,
  bang: hit03Url,
  clank: metal09Url,
  gong: gong02Url,
  squeak: spring03Url,
  creak: door02Url,
  rattle: metal02Url,
  plasticClack: tools04Url,
  rustle: noise01Url,
  metalClick: slam05Url,
  flick: switch01Url,
  wheel: wooden01Url,
};

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
  private readonly externalBuffers = new Map<ObjectSoundName, AudioBuffer>();
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
      "tvStatic", "tvOn", "tvOff", "alarm", "tick", "whistle", "squeak", "gong", "shatter", "potBreak", "crumple", "thump", "bang", "clank",
      "beep", "spray", "wheel", "flick", "creak", "rattle", "plasticClack", "suction", "rustle", "metalClick", "buzz",
    ];
    for (const name of names) queueWarmup(() => this.buffer(name));
    for (const name of names) {
      const url = EXTERNAL_SOUNDS[name];
      if (url) void this.loadExternal(name, url);
    }
  }

  private async loadExternal(name: ObjectSoundName, url: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.arrayBuffer();
      this.externalBuffers.set(name, await this.listener.context.decodeAudioData(data));
    } catch {
      // Keep the procedural buffer as a reliable fallback.
    }
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
    voice.setBuffer(this.externalBuffers.get(name) ?? this.buffer(name));
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
