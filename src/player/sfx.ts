import * as THREE from "three";
import { bandpass, createSamples, fadeEdges, highpass, lowpass, normalize, queueWarmup, toBuffer } from "../assets/audio/synth";

const SOUND_NAMES = ["store", "take", "grab", "click", "denied", "battery"] as const;
type SoundName = (typeof SOUND_NAMES)[number];

/**
 * Sons d'interaction générés procéduralement (pas de fichier audio), volontairement
 * diégétiques et sourds plutôt que des bips : froissement de sac (rangement / sortie),
 * contact mat (saisie), déclic mécanique (lampe, menu), cognement étouffé (refus),
 * pile glissée dans la lampe.
 */
export class Sfx {
  private readonly buffers = new Map<SoundName, AudioBuffer>();
  private readonly voices: THREE.Audio[] = [];
  private nextVoice = 0;

  constructor(private readonly listener: THREE.AudioListener) {
    for (let i = 0; i < 4; i++) {
      const audio = new THREE.Audio(listener);
      listener.add(audio);
      this.voices.push(audio);
    }
    for (const name of SOUND_NAMES) queueWarmup(() => this.bufferFor(name));
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
    const buffer = this.bufferFor(name);
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
      data = createSamples(sampleRate, 0.35);
      for (const [at, gain, freq] of [[0, 0.8, 3200], [0.07, 0.5, 2600], [0.2, 1, 1800]] as const) {
        const start = Math.floor(at * sampleRate);
        for (let i = 0; start + i < data.length; i++) {
          const t = i / sampleRate;
          data[start + i] = data[start + i]! + ((Math.random() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * freq * t) * 0.4) * Math.exp(-t / 0.006) * gain;
        }
      }
      highpass(data, sampleRate, 500);
      break;
    }
  }

  return toBuffer(context, fadeEdges(normalize(data, 0.6), sampleRate, 0.003));
}
