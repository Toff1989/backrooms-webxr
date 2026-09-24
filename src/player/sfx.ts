import * as THREE from "three";

type SoundName = "store" | "take" | "grab" | "click" | "denied";

/**
 * Petits sons d'interface générés procéduralement (pas de fichier audio) : rangement,
 * sortie d'inventaire, saisie, clic de menu, refus (objet trop lourd / non rangeable).
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
  }

  play(name: SoundName, volume = 0.5): void {
    const context = this.listener.context;
    if (context.state !== "running") return;
    let buffer = this.buffers.get(name);
    if (!buffer) {
      buffer = createBuffer(context, name);
      this.buffers.set(name, buffer);
    }
    const voice = this.voices[this.nextVoice]!;
    this.nextVoice = (this.nextVoice + 1) % this.voices.length;
    if (voice.isPlaying) voice.stop();
    voice.setBuffer(buffer);
    voice.setVolume(volume);
    voice.play();
  }
}

function createBuffer(context: AudioContext, name: SoundName): AudioBuffer {
  const duration = name === "store" ? 0.4 : name === "denied" ? 0.22 : 0.12;
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const progress = t / duration;
    let sample = 0;
    switch (name) {
      case "store": {
        const freq = progress < 0.4 ? 784 : 1175;
        sample = (Math.sin(2 * Math.PI * freq * t) * 0.4 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.12) * Math.pow(1 - progress, 1.6);
        break;
      }
      case "take":
        sample = Math.sin(2 * Math.PI * (500 + progress * 500) * t) * 0.35 * (1 - progress);
        break;
      case "grab":
        sample = ((Math.random() * 2 - 1) * 0.25 + Math.sin(2 * Math.PI * 140 * t) * 0.35) * Math.pow(1 - progress, 3);
        break;
      case "click":
        sample = Math.sin(2 * Math.PI * 1400 * t) * 0.3 * Math.pow(1 - progress, 4);
        break;
      case "denied":
        sample = Math.sign(Math.sin(2 * Math.PI * 180 * t)) * 0.18 * (1 - progress);
        break;
    }
    data[i] = sample;
  }
  return buffer;
}
