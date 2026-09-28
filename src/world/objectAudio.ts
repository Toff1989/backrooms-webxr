import * as THREE from "three";
import dishes02Url from "../assets/audio/cc0/dishes_02.ogg?url";
import doorClose03Url from "../assets/audio/cc0/door_close_03.ogg?url";
import doorClose04Url from "../assets/audio/cc0/door_close_04.ogg?url";
import door02Url from "../assets/audio/cc0/door_02.ogg?url";
import glass02Url from "../assets/audio/cc0/glass_02.ogg?url";
import glass03Url from "../assets/audio/cc0/glass_03.ogg?url";
import gong01Url from "../assets/audio/cc0/gong_01.ogg?url";
import gong02Url from "../assets/audio/cc0/gong_02.ogg?url";
import hit01Url from "../assets/audio/cc0/hit_01.ogg?url";
import hit02Url from "../assets/audio/cc0/hit_02.ogg?url";
import hit03Url from "../assets/audio/cc0/hit_03.ogg?url";
import metal01Url from "../assets/audio/cc0/metal_01.ogg?url";
import metal02Url from "../assets/audio/cc0/metal_02.ogg?url";
import metal03Url from "../assets/audio/cc0/metal_03.ogg?url";
import metal07Url from "../assets/audio/cc0/metal_07.ogg?url";
import metal09Url from "../assets/audio/cc0/metal_09.ogg?url";
import microwaveCloseUrl from "../assets/audio/cc0/microwave_door_close.ogg?url";
import microwaveOpenUrl from "../assets/audio/cc0/microwave_door_open.ogg?url";
import noise01Url from "../assets/audio/cc0/noise_01.ogg?url";
import paper02Url from "../assets/audio/cc0/paper_02.ogg?url";
import plop01Url from "../assets/audio/cc0/plop_01.ogg?url";
import plop02Url from "../assets/audio/cc0/plop_02.ogg?url";
import shot02Url from "../assets/audio/cc0/shot_02.ogg?url";
import slam05Url from "../assets/audio/cc0/slam_05.ogg?url";
import splash02Url from "../assets/audio/cc0/splash_02.ogg?url";
import spring03Url from "../assets/audio/cc0/spring_03.ogg?url";
import switch01Url from "../assets/audio/cc0/switch_01.ogg?url";
import switch02Url from "../assets/audio/cc0/switch_02.ogg?url";
import tools04Url from "../assets/audio/cc0/tools_04.ogg?url";
import weird04Url from "../assets/audio/cc0/weird_04.ogg?url";
import weird05Url from "../assets/audio/cc0/weird_05.ogg?url";
import woodedBoxOpenUrl from "../assets/audio/cc0/wooded_box_open.ogg?url";
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

/**
 * Sons propres à un objet précis (`"kind:action"`, voir l'artefact "Atelier des objets") : pris
 * en priorité sur `EXTERNAL_SOUNDS`, qui reste le son partagé par défaut pour tout le reste.
 */
const OVERRIDE_SOUNDS: Record<string, string> = {
  "alarmClock:arm": switch02Url,
  "armChair:impact": wooden01Url,
  "bleach:impact": splash02Url,
  "bookshelf:impact": hit03Url,
  "brassPot:impact": gong02Url,
  "brassPot:use": gong01Url,
  "cabinet:impact": metal01Url,
  "can:crush": slam05Url,
  "can:impact": metal02Url,
  "cardboardBox:impact": paper02Url,
  "chair:impact": wooden01Url,
  "chalkboard:write": weird04Url,
  "cigaretteCase:open": switch02Url,
  "cigarettePack:open": noise01Url,
  "cleanerTin:open": noise01Url,
  "coffeeTable:impact": doorClose04Url,
  "combWrench:impact": metal02Url,
  "digitalWatch:tick": switch01Url,
  "drainCleaner:impact": hit02Url,
  "dustpan:impact": metal02Url,
  "gamepad:vibrate": weird05Url,
  "hammer:impact": hit03Url,
  "lightbulb:impact": glass03Url,
  "lighter:flick": switch01Url,
  "metalShelves:impact": metal09Url,
  "metalShelves:shake": metal01Url,
  "metalStool:impact": metal03Url,
  "metalStool:spin": metal02Url,
  "monoblocChair:impact": woodedBoxOpenUrl,
  "officeDesk:impact": metal01Url,
  "photo:change": weird04Url,
  "plasticCrate:impact": hit01Url,
  "pliers:use": hit02Url,
  "plunger:stick": plop01Url,
  "plunger:unstick": plop02Url,
  "pottedPlant:impact": glass02Url,
  "schoolDesk:impact": wooden01Url,
  "screwdriver:impact": hit02Url,
  "screwdriverFlat:impact": hit02Url,
  "sofa:impact": doorClose03Url,
  "storageCart:roll": woodedBoxOpenUrl,
  "television:off": microwaveCloseUrl,
  "television:on": microwaveOpenUrl,
  "toolbox:impact": metal07Url,
  "toy:impact": spring03Url,
  "toy:squeeze": spring03Url,
  "vase:impact": dishes02Url,
  "wallClock:mount": slam05Url,
  "wallClock:unmount": shot02Url,
  "watch:open": switch01Url,
  "wetFloorSign:fold": tools04Url,
  "wetFloorSign:impact": hit01Url,
  "woodenSpoon:impact": hit02Url,
  "wrench:impact": metal02Url,
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
  private readonly overrideBuffers = new Map<string, AudioBuffer>();
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
      if (url) void this.loadExternal(url, (buffer) => this.externalBuffers.set(name, buffer));
    }
    for (const [key, url] of Object.entries(OVERRIDE_SOUNDS)) {
      void this.loadExternal(url, (buffer) => this.overrideBuffers.set(key, buffer));
    }
  }

  private async loadExternal(url: string, store: (buffer: AudioBuffer) => void): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.arrayBuffer();
      store(await this.listener.context.decodeAudioData(data));
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

  /**
   * Son ponctuel à une position du monde. `overrideKey` (`"kind:action"`) prend le pas sur `name`
   * quand un son propre à cet objet précis a été choisi (voir `OVERRIDE_SOUNDS`).
   */
  playAt(name: ObjectSoundName, position: THREE.Vector3, volume = 0.8, overrideKey?: string): void {
    if (!this.running) return;
    const voice = this.oneShots[this.next]!;
    this.next = (this.next + 1) % this.oneShots.length;
    if (voice.isPlaying) voice.stop();
    voice.position.copy(position);
    voice.setBuffer((overrideKey ? this.overrideBuffers.get(overrideKey) : undefined) ?? this.externalBuffers.get(name) ?? this.buffer(name));
    voice.setLoop(false);
    voice.setVolume(volume);
    voice.play();
  }

  /**
   * Son en boucle accroché à `owner` (il le suit). Null si toutes les voix de boucle sont
   * prises : le son est alors simplement muet, jamais une erreur.
   */
  loop(name: ObjectSoundName, owner: THREE.Object3D, volume = 0.6, overrideKey?: string): LoopHandle | null {
    if (!this.running || !LOOPING_SOUNDS.has(name) && name !== "alarm") return null;
    const voice = this.loops.find((candidate) => candidate.owner === null);
    if (!voice) return null;
    voice.owner = owner;
    owner.add(voice.audio);
    voice.audio.position.set(0, 0, 0);
    voice.audio.setBuffer((overrideKey ? this.overrideBuffers.get(overrideKey) : undefined) ?? this.buffer(name));
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
