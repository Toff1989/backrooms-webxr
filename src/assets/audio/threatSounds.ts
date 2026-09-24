import { bandpass, brownNoise, createSamples, fadeEdges, highpass, lowpass, makeLoopable, normalize, reverb, toBuffer } from "./synth";

/**
 * Sons des menaces (Coupure, Cadreur), synthétisés comme le reste de l'ambiance : pas de
 * fichier audio, des sons sourds et réverbérés qui sonnent "dans le bâtiment".
 */

/** Percussion amortie (sinus qui descend + bruit bref) ajoutée en place. */
function addThump(data: Float32Array, sampleRate: number, at: number, frequency: number, decay: number, gain: number): void {
  const start = Math.floor(at * sampleRate);
  const length = Math.floor(decay * 6 * sampleRate);
  let phase = 0;
  for (let i = 0; i < length && start + i < data.length; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t / decay);
    phase += (2 * Math.PI * frequency * (1 + 1.5 * Math.exp(-t / 0.015))) / sampleRate;
    data[start + i] = data[start + i]! + (Math.sin(phase) * 0.8 + (Math.random() * 2 - 1) * Math.exp(-t / 0.006) * 0.6) * envelope * gain;
  }
}

/** Crépitement d'arc électrique : salves de craquements secs. */
function addCrackle(data: Float32Array, sampleRate: number, at: number, seconds: number, density: number, gain: number): void {
  const start = Math.floor(at * sampleRate);
  const length = Math.floor(seconds * sampleRate);
  for (let i = 0; i < length && start + i < data.length; i++) {
    if (Math.random() < density / sampleRate) {
      const burst = Math.floor(sampleRate * (0.001 + Math.random() * 0.004));
      const amplitude = gain * (0.3 + Math.random() * 0.7) * (1 - i / length);
      for (let k = 0; k < burst && start + i + k < data.length; k++) data[start + i + k] = data[start + i + k]! + (Math.random() * 2 - 1) * amplitude;
    }
  }
}

/** Disjoncteur qui saute au loin : claquement métallique lourd, arc, coup sourd dans la structure. */
export function createBreakerBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, 4);
  addCrackle(data, sampleRate, 0, 0.35, 900, 0.5);
  addThump(data, sampleRate, 0.3, 58, 0.18, 1);
  addThump(data, sampleRate, 0.31, 230, 0.03, 0.5);
  addThump(data, sampleRate, 0.52, 44, 0.3, 0.6);
  const metal = createSamples(sampleRate, 4);
  addThump(metal, sampleRate, 0.3, 1240, 0.06, 0.4);
  addThump(metal, sampleRate, 0.3, 1780, 0.04, 0.3);
  for (let i = 0; i < data.length; i++) data[i] = data[i]! + metal[i]!;
  lowpass(data, sampleRate, 2600);
  reverb(data, sampleRate, 0.6, 2.2);
  return toBuffer(context, fadeEdges(normalize(data, 0.9), sampleRate));
}

/** Les néons meurent autour de soi : le bourdonnement 100 Hz glisse vers le grave et s'éteint. */
export function createWindDownBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const seconds = 2.6;
  const data = createSamples(sampleRate, seconds);
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const progress = t / seconds;
    const frequency = 100 * Math.pow(1 - progress, 1.6) + 12;
    phase += (2 * Math.PI * frequency) / sampleRate;
    const level = Math.pow(1 - progress, 1.3) * (0.85 + 0.15 * Math.sin(t * 37));
    data[i] = Math.tanh(Math.sin(phase) * 3) * 0.5 * level + Math.sin(phase * 1.2) * 0.2 * level;
  }
  addCrackle(data, sampleRate, 0, 0.8, 120, 0.25);
  lowpass(data, sampleRate, 1200);
  return toBuffer(context, fadeEdges(normalize(data, 0.8), sampleRate, 0.03));
}

/** Tube qui lâche : "tink" de verre chaud + grésillement bref du ballast. */
export function createTubeDeathBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, 1.4);
  addCrackle(data, sampleRate, 0, 0.25, 500, 0.35);
  addThump(data, sampleRate, 0.22, 2900 + Math.random() * 800, 0.025, 0.45);
  const hum = createSamples(sampleRate, 1.4);
  for (let i = 0; i < Math.floor(0.3 * sampleRate); i++) {
    const t = i / sampleRate;
    hum[i] = Math.tanh(Math.sin(2 * Math.PI * 120 * t) * 4) * 0.3 * (1 - t / 0.3) * (Math.random() < 0.7 ? 1 : 0.2);
  }
  for (let i = 0; i < data.length; i++) data[i] = data[i]! + hum[i]!;
  highpass(data, sampleRate, 90);
  reverb(data, sampleRate, 0.45, 1.3);
  return toBuffer(context, fadeEdges(normalize(data, 0.7), sampleRate));
}

/** Néon qui redémarre : clics du starter, amorçages ratés, puis le bourdonnement prend. */
export function createTubeStartBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, 2.2);
  let time = 0.05;
  const tries = 2 + Math.floor(Math.random() * 3);
  for (let n = 0; n < tries; n++) {
    addThump(data, sampleRate, time, 3400, 0.008, 0.5);
    const start = Math.floor((time + 0.02) * sampleRate);
    const length = Math.floor((0.05 + Math.random() * 0.08) * sampleRate);
    for (let i = 0; i < length && start + i < data.length; i++) {
      data[start + i] = data[start + i]! + Math.tanh(Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 4) * 0.35;
    }
    time += 0.18 + Math.random() * 0.25;
  }
  const start = Math.floor(time * sampleRate);
  for (let i = start; i < data.length; i++) {
    const t = (i - start) / sampleRate;
    data[i] = data[i]! + Math.tanh(Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 3) * 0.25 * Math.min(1, t * 6) * Math.exp(-t / 0.9);
  }
  lowpass(data, sampleRate, 3000);
  reverb(data, sampleRate, 0.35, 1.2);
  return toBuffer(context, fadeEdges(normalize(data, 0.7), sampleRate));
}

/** Moteur de cassette d'un caméscope qui tourne : ronronnement fin, pleurage, cliquetis de mécanique. */
export function createTapeMotorBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const seconds = 3;
  const data = createSamples(sampleRate, seconds);
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const wow = 1 + Math.sin(2 * Math.PI * (1 / seconds) * t) * 0.02 + Math.sin(2 * Math.PI * (4 / seconds) * t) * 0.006;
    phase += (2 * Math.PI * 180 * wow) / sampleRate;
    data[i] = Math.sin(phase) * 0.25 + Math.sin(phase * 2.01) * 0.12 + Math.sin(phase * 7.3) * 0.05 + (Math.random() * 2 - 1) * 0.06;
    // Cliquetis du cabestan, un par tour.
    if (Math.sin(2 * Math.PI * (9 / seconds) * t) > 0.995) data[i] = data[i]! + (Math.random() * 2 - 1) * 0.3;
  }
  bandpass(data, sampleRate, 700, 0.6);
  return toBuffer(context, normalize(makeLoopable(data, sampleRate, 0.3), 0.7));
}

/** Pas feutré sur la moquette humide. */
export function createCarpetStepBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = brownNoise(createSamples(sampleRate, 0.9));
  const heel = 0.07 + Math.random() * 0.03;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t / 0.05) + (t > heel ? Math.exp(-(t - heel) / 0.07) * 0.8 : 0);
    data[i] = data[i]! * envelope;
  }
  addThump(data, sampleRate, 0, 65, 0.05, 0.6);
  lowpass(data, sampleRate, 520);
  reverb(data, sampleRate, 0.3, 1.2);
  return toBuffer(context, fadeEdges(normalize(data, 0.8), sampleRate));
}

/** Zoom motorisé du caméscope qui se resserre sur toi : servo aigu qui monte, puis mise au point. */
export function createZoomBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const seconds = 1.5;
  const data = createSamples(sampleRate, seconds);
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const running = t < 1.05 ? 1 : 0;
    const frequency = 820 + t * 360 + Math.sin(t * 60) * 12;
    phase += (2 * Math.PI * frequency) / sampleRate;
    data[i] = (Math.sign(Math.sin(phase)) * 0.12 + Math.sin(phase * 0.5) * 0.2 + (Math.random() * 2 - 1) * 0.05) * running * Math.min(1, t * 30);
  }
  addThump(data, sampleRate, 1.07, 2600, 0.01, 0.6);
  addThump(data, sampleRate, 1.16, 2100, 0.008, 0.35);
  bandpass(data, sampleRate, 1100, 0.8);
  reverb(data, sampleRate, 0.2, 0.8);
  return toBuffer(context, fadeEdges(normalize(data, 0.6), sampleRate));
}

/** Rattrapé : bande qui s'arrête net (chute de vitesse), puis neige blanche saturée. */
export function createCaughtBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const seconds = 2.4;
  const data = createSamples(sampleRate, seconds);
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    if (t < 0.7) {
      const speed = Math.pow(1 - t / 0.7, 2);
      phase += (2 * Math.PI * (60 + 240 * speed)) / sampleRate;
      data[i] = (Math.sin(phase) * 0.6 + Math.sin(phase * 3.1) * 0.25) * (0.4 + speed * 0.6);
    } else {
      data[i] = (Math.random() * 2 - 1) * 0.55 * Math.exp(-(t - 0.7) / 0.9);
    }
  }
  addThump(data, sampleRate, 0.68, 50, 0.12, 1);
  lowpass(data, sampleRate, 6000);
  return toBuffer(context, fadeEdges(normalize(data, 0.85), sampleRate, 0.02));
}
