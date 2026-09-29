import * as THREE from "three";
import metal03Url from "../assets/audio/cc0/metal_03.ogg?url";
import paper01Url from "../assets/audio/cc0/paper_01.ogg?url";
import paper02Url from "../assets/audio/cc0/paper_02.ogg?url";
import slam01Url from "../assets/audio/cc0/slam_01.ogg?url";
import switch01Url from "../assets/audio/cc0/switch_01.ogg?url";
import { bandpass, createSamples, fadeEdges, highpass, lowpass, normalize, queueWarmup, reverb, toBuffer } from "../assets/audio/synth";

const SOUND_NAMES = ["store", "take", "grab", "click", "denied", "battery", "discovery", "unlock"] as const;
type SoundName = (typeof SOUND_NAMES)[number];
const EXTERNAL_SOUNDS: Partial<Record<SoundName, string>> = {
  store: paper01Url,
  take: paper02Url,
  grab: metal03Url,
  click: switch01Url,
  denied: slam01Url,
};

/**
 * Sons d'interaction générés procéduralement (pas de fichier audio), volontairement
 * diégétiques et sourds plutôt que des bips : froissement de sac (rangement / sortie),
 * contact mat (saisie), déclic mécanique (lampe, menu), cognement étouffé (refus),
 * pile glissée dans la lampe, confirmation de mise au point (archive trouvée), petit
 * arpège (succès débloqué) — ces deux derniers restent feutrés (passe-bas + réverbe),
 * pas des bips d'interface qui casseraient l'ambiance found-footage.
 */
export class Sfx {
  private readonly buffers = new Map<SoundName, AudioBuffer>();
  private readonly externalBuffers = new Map<SoundName, AudioBuffer>();
  private readonly voices: THREE.Audio[] = [];
  private nextVoice = 0;

  constructor(private readonly listener: THREE.AudioListener) {
    for (let i = 0; i < 4; i++) {
      const audio = new THREE.Audio(listener);
      listener.add(audio);
      this.voices.push(audio);
    }
    for (const name of SOUND_NAMES) queueWarmup(() => this.bufferFor(name));
    for (const name of SOUND_NAMES) {
      const url = EXTERNAL_SOUNDS[name];
      if (url) void this.loadExternal(name, url);
    }
  }

  private async loadExternal(name: SoundName, url: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.arrayBuffer();
      this.externalBuffers.set(name, await this.listener.context.decodeAudioData(data));
    } catch {
      // The generated sound remains available when an asset cannot be decoded.
    }
  }

  private bufferFor(name: SoundName): AudioBuffer {
    let buffer = this.buffers.get(name);
    if (!buffer) {
      buffer = createBuffer(this.listener.context, name);
      this.buffers.set(name, buffer);
    }
    return buffer;
  }

  play(name: SoundName, volume = 0.5): void {
    const context = this.listener.context;
    if (context.state !== "running") return;
    const buffer = this.externalBuffers.get(name) ?? this.bufferFor(name);
    const voice = this.voices[this.nextVoice]!;
    this.nextVoice = (this.nextVoice + 1) % this.voices.length;
    if (voice.isPlaying) voice.stop();
    voice.setBuffer(buffer);
    voice.setVolume(volume);
    voice.play();
  }
}

function createBuffer(context: BaseAudioContext, name: SoundName): AudioBuffer {
  const sampleRate = context.sampleRate;
  let data: Float32Array;

  switch (name) {
    case "store":
    case "take": {
      // Froissement de tissu/sac : bouffées de bruit filtré irrégulières.
      const seconds = name === "store" ? 0.45 : 0.3;
      data = createSamples(sampleRate, seconds);
      let grain = 0;
      for (let i = 0; i < data.length; i++) {
        if (i % Math.floor(sampleRate * 0.012) === 0) grain = Math.random();
        const p = i / data.length;
        const envelope = name === "store" ? Math.sin(Math.PI * p) : Math.pow(1 - p, 1.5);
        data[i] = (Math.random() * 2 - 1) * grain * envelope;
      }
      bandpass(data, sampleRate, name === "store" ? 1800 : 2600, 0.7);
      break;
    }
    case "grab": {
      // Contact mat de la main sur un objet.
      data = createSamples(sampleRate, 0.14);
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        data[i] = (Math.sin(2 * Math.PI * 110 * t) * 0.6 + (Math.random() * 2 - 1) * 0.4) * Math.exp(-t / 0.025);
      }
      lowpass(data, sampleRate, 900);
      break;
    }
    case "click": {
      // Déclic mécanique d'interrupteur (deux contacts rapprochés), pas un bip.
      data = createSamples(sampleRate, 0.08);
      for (const at of [0, 0.018]) {
        const start = Math.floor(at * sampleRate);
        for (let i = 0; start + i < data.length; i++) {
          const t = i / sampleRate;
          data[start + i] = data[start + i]! + ((Math.random() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 2300 * t) * 0.3) * Math.exp(-t / 0.003) * (at === 0 ? 1 : 0.6);
        }
      }
      highpass(data, sampleRate, 600);
      break;
    }
    case "denied": {
      // Cognement étouffé et bourdon bref : "ça ne rentre pas".
      data = createSamples(sampleRate, 0.3);
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        data[i] = (Math.sin(2 * Math.PI * 75 * t) + Math.tanh(Math.sin(2 * Math.PI * 150 * t) * 3) * 0.3) * Math.exp(-t / 0.07);
      }
      lowpass(data, sampleRate, 600);
      break;
    }
    case "battery": {
      // Pile qu'on glisse dans la lampe : cliquetis métallique puis ressort qui se referme.
      data = createSamples(sampleRate, 0.24);
      for (const [at, gain, freq] of [[0, 0.7, 2850], [0.095, 0.55, 2250]] as const) {
        const start = Math.floor(at * sampleRate);
        for (let i = 0; start + i < data.length; i++) {
          const t = i / sampleRate;
          data[start + i] = data[start + i]! + ((Math.random() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * freq * t) * 0.4) * Math.exp(-t / 0.006) * gain;
        }
      }
      highpass(data, sampleRate, 700);
      break;
    }
    case "discovery": {
      // Confirmation de mise au point du caméscope : deux notes brèves, la seconde plus aiguë.
      data = createSamples(sampleRate, 0.42);
      for (const [at, freq, seconds] of [[0, 920, 0.09], [0.14, 1380, 0.12]] as const) {
        const start = Math.floor(at * sampleRate);
        for (let i = 0; start + i < data.length && i < seconds * sampleRate; i++) {
          const t = i / sampleRate;
          data[start + i] = data[start + i]! + Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.05);
        }
      }
      lowpass(data, sampleRate, 3200);
      reverb(data, sampleRate, 0.25, 0.6);
      break;
    }
    case "unlock": {
      // Petit arpège ascendant, feutré : la découverte d'un succès, sans virer au jingle.
      data = createSamples(sampleRate, 0.85);
      for (const [at, freq] of [[0, 523], [0.11, 659], [0.22, 784]] as const) {
        const start = Math.floor(at * sampleRate);
        for (let i = 0; start + i < data.length && i < 0.45 * sampleRate; i++) {
          const t = i / sampleRate;
          data[start + i] = data[start + i]! + Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.3) * 0.8;
        }
      }
      lowpass(data, sampleRate, 2600);
      reverb(data, sampleRate, 0.35, 0.9);
      break;
    }
  }

  return toBuffer(context, fadeEdges(normalize(data, 0.6), sampleRate, 0.003));
}
