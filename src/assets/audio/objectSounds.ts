import { bandpass, brownNoise, createSamples, fadeEdges, highpass, lowpass, makeLoopable, normalize, reverb, toBuffer } from "./synth";

/**
 * Sons des objets manipulables, synthétisés hors ligne comme le reste du jeu (pas de fichier
 * audio) : télé qui grésille, réveil, bouilloire, verre qui éclate, tapette qui claque...
 * Sourds et « dans la pièce » plutôt que des bips de synthé.
 */
export type ObjectSoundName =
  | "tvStatic"
  | "tvOn"
  | "tvOff"
  | "alarm"
  | "tick"
  | "whistle"
  | "squeak"
  | "gong"
  | "shatter"
  | "snap"
  | "crumple"
  | "thump"
  | "bang"
  | "clank"
  | "beep"
  | "spray"
  | "drawer"
  | "wheel"
  | "flick"
  | "creak"
  | "rattle"
  | "suction"
  | "zip"
  | "rustle"
  | "metalClick"
  | "projector"
  | "crackle"
  | "buzz";

/** Sons joués en boucle (attachés à l'objet tant qu'il est actif). */
export const LOOPING_SOUNDS = new Set<ObjectSoundName>(["tvStatic", "projector", "buzz", "tick"]);

const noise = (): number => Math.random() * 2 - 1;

function decayHit(data: Float32Array, sampleRate: number, at: number, freq: number, decay: number, gain: number, noiseMix = 0.5): void {
  const start = Math.floor(at * sampleRate);
  for (let i = 0; start + i < data.length; i++) {
    const t = i / sampleRate;
    data[start + i] = data[start + i]! + (noise() * noiseMix + Math.sin(2 * Math.PI * freq * t) * (1 - noiseMix)) * Math.exp(-t / decay) * gain;
  }
}

export function createObjectSound(context: BaseAudioContext, name: ObjectSoundName): AudioBuffer {
  const rate = context.sampleRate;
  let data: Float32Array;
  let peak = 0.8;
  switch (name) {
    case "tvStatic": {
      // Neige d'un vieux téléviseur : souffle aigu + ronflement 50 Hz de la ligne.
      data = createSamples(rate, 2);
      for (let i = 0; i < data.length; i++) data[i] = noise() * 0.7 + Math.sin((2 * Math.PI * 50 * i) / rate) * 0.08 + Math.sin((2 * Math.PI * 15625 * i) / rate) * 0.04;
      highpass(data, rate, 900);
      data = makeLoopable(data, rate, 0.2);
      peak = 0.5;
      break;
    }
    case "tvOn": {
      // Claquement du relais puis montée du tube cathodique.
      data = createSamples(rate, 0.7);
      decayHit(data, rate, 0, 180, 0.03, 1, 0.6);
      for (let i = Math.floor(0.05 * rate); i < data.length; i++) {
        const t = i / rate;
        data[i] = data[i]! + Math.sin(2 * Math.PI * (2000 + t * 9000) * t) * 0.08 * Math.min(1, t * 6) * Math.exp(-t * 2);
      }
      break;
    }
    case "tvOff": {
      data = createSamples(rate, 0.45);
      decayHit(data, rate, 0, 140, 0.04, 1, 0.7);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = data[i]! + Math.sin(2 * Math.PI * (9000 - t * 14000) * t) * 0.06 * Math.exp(-t * 6);
      }
      break;
    }
    case "alarm": {
      // Sonnerie mécanique : marteau qui frappe deux cloches, par salves.
      data = createSamples(rate, 1.2);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        const strike = (t * 22) % 1;
        const bell = Math.sin(2 * Math.PI * 2350 * t) * 0.6 + Math.sin(2 * Math.PI * 3180 * t) * 0.4;
        data[i] = bell * Math.exp(-strike * 5) * ((t % 0.6) < 0.45 ? 1 : 0.15);
      }
      bandpass(data, rate, 2600, 0.8);
      data = makeLoopable(data, rate, 0.05);
      break;
    }
    case "tick": {
      // Tic-tac d'horloge : un clic sec par seconde, le "tac" plus grave.
      data = createSamples(rate, 1);
      decayHit(data, rate, 0, 3200, 0.004, 1, 0.5);
      decayHit(data, rate, 0.5, 2400, 0.005, 0.7, 0.5);
      highpass(data, rate, 800);
      peak = 0.45;
      break;
    }
    case "whistle": {
      data = createSamples(rate, 3);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        const freq = 1750 + Math.sin(t * 30) * 25 + t * 60;
        data[i] = (Math.sin(2 * Math.PI * freq * t) * 0.8 + noise() * 0.15) * Math.min(1, t * 2) * Math.min(1, (3 - t) * 4);
      }
      break;
    }
    case "squeak": {
      data = createSamples(rate, 0.35);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = Math.sin(2 * Math.PI * (1400 + Math.sin(t * 40) * 500 + t * 1500) * t) * Math.sin((Math.PI * t) / 0.35);
      }
      break;
    }
    case "gong": {
      // Pot en laiton frappé : partiels inharmoniques qui s'éteignent lentement.
      data = createSamples(rate, 3);
      for (const [freq, gain, decay] of [[196, 1, 1.4], [313, 0.6, 1.1], [487, 0.45, 0.8], [731, 0.3, 0.5], [1102, 0.2, 0.3]] as const) {
        for (let i = 0; i < data.length; i++) {
          const t = i / rate;
          data[i] = data[i]! + Math.sin(2 * Math.PI * freq * t * (1 + Math.sin(t * 5) * 0.002)) * gain * Math.exp(-t / decay);
        }
      }
      decayHit(data, rate, 0, 400, 0.01, 0.8, 0.9);
      reverb(data, rate, 0.3, 1.4);
      break;
    }
    case "shatter": {
      // Verre / céramique qui éclate : choc puis éclats qui retombent.
      data = createSamples(rate, 1);
      decayHit(data, rate, 0, 2800, 0.02, 1.2, 0.9);
      for (let k = 0; k < 26; k++) decayHit(data, rate, 0.02 + Math.random() * 0.7, 3000 + Math.random() * 5000, 0.006 + Math.random() * 0.01, 0.3 + Math.random() * 0.4, 0.3);
      highpass(data, rate, 1200);
      reverb(data, rate, 0.2, 0.8);
      break;
    }
    case "snap": {
      // Tapette qui claque : claquement sec du ressort + bois.
      data = createSamples(rate, 0.2);
      decayHit(data, rate, 0, 1900, 0.004, 1.3, 0.8);
      decayHit(data, rate, 0.004, 220, 0.03, 0.8, 0.3);
      break;
    }
    case "crumple": {
      data = createSamples(rate, 0.5);
      for (let k = 0; k < 40; k++) decayHit(data, rate, Math.random() * 0.4, 2500 + Math.random() * 3000, 0.002 + Math.random() * 0.004, Math.random(), 0.9);
      bandpass(data, rate, 3200, 0.6);
      break;
    }
    case "thump": {
      data = createSamples(rate, 0.3);
      decayHit(data, rate, 0, 90, 0.05, 1, 0.25);
      lowpass(data, rate, 700);
      break;
    }
    case "bang": {
      // Coup de marteau contre un mur : choc lourd, résonance du placo.
      data = createSamples(rate, 0.6);
      decayHit(data, rate, 0, 120, 0.08, 1, 0.4);
      decayHit(data, rate, 0, 1500, 0.01, 0.6, 0.9);
      reverb(data, rate, 0.35, 1.2);
      break;
    }
    case "clank": {
      // Canette qui rebondit : métal fin, creux.
      data = createSamples(rate, 0.4);
      decayHit(data, rate, 0, 1650, 0.05, 1, 0.3);
      decayHit(data, rate, 0.09, 1720, 0.035, 0.5, 0.3);
      decayHit(data, rate, 0.16, 1690, 0.02, 0.25, 0.3);
      break;
    }
    case "beep": {
      data = createSamples(rate, 0.08);
      for (let i = 0; i < data.length; i++) data[i] = Math.sign(Math.sin((2 * Math.PI * 2600 * i) / rate)) * 0.4;
      lowpass(data, rate, 5000);
      peak = 0.4;
      break;
    }
    case "spray": {
      data = createSamples(rate, 0.8);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = noise() * Math.min(1, t * 30) * Math.min(1, (0.8 - t) * 8);
      }
      highpass(data, rate, 3500);
      peak = 0.55;
      break;
    }
    case "drawer": {
      // Tiroir métallique qui coulisse, puis butée.
      data = brownNoise(createSamples(rate, 0.8), 2);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = data[i]! * (t < 0.6 ? 0.5 + 0.5 * Math.abs(Math.sin(t * 90)) : 0) + noise() * 0.15 * (t < 0.6 ? 1 : 0);
      }
      bandpass(data, rate, 1300, 0.7);
      decayHit(data, rate, 0.6, 700, 0.03, 1.2, 0.5);
      break;
    }
    case "wheel": {
      // Roulette de chariot qui grince.
      data = createSamples(rate, 0.4);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = Math.sin(2 * Math.PI * (2100 + Math.sin(t * 25) * 300) * t) * Math.sin((Math.PI * t) / 0.4) * (0.6 + 0.4 * Math.sin(t * 180));
      }
      peak = 0.5;
      break;
    }
    case "flick": {
      // Molette de briquet puis flamme qui prend.
      data = createSamples(rate, 0.4);
      decayHit(data, rate, 0, 3500, 0.006, 1, 0.9);
      for (let i = Math.floor(0.03 * rate); i < data.length; i++) data[i] = data[i]! + noise() * 0.3 * Math.exp(-(i / rate - 0.03) * 8);
      lowpass(data, rate, 4000);
      break;
    }
    case "creak": {
      data = createSamples(rate, 0.8);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        const pulse = Math.max(0, Math.sin(2 * Math.PI * (35 + t * 20) * t));
        data[i] = pulse ** 8 * Math.sin((Math.PI * t) / 0.8);
      }
      bandpass(data, rate, 800, 1.2);
      break;
    }
    case "rattle": {
      data = createSamples(rate, 0.6);
      for (let k = 0; k < 14; k++) decayHit(data, rate, Math.random() * 0.45, 900 + Math.random() * 1500, 0.015, 0.4 + Math.random() * 0.6, 0.4);
      reverb(data, rate, 0.2, 0.6);
      break;
    }
    case "suction": {
      data = createSamples(rate, 0.25);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = (noise() * 0.5 + Math.sin(2 * Math.PI * (300 - t * 800) * t)) * Math.exp(-t * 18);
      }
      lowpass(data, rate, 1500);
      break;
    }
    case "zip": {
      // Mètre ruban qui se rembobine.
      data = createSamples(rate, 0.45);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = noise() * (0.5 + 0.5 * Math.abs(Math.sin(t * 400))) * (1 - t / 0.45);
      }
      decayHit(data, rate, 0.42, 1400, 0.01, 1, 0.5);
      bandpass(data, rate, 2400, 0.8);
      break;
    }
    case "rustle": {
      data = createSamples(rate, 0.45);
      let grain = 0;
      for (let i = 0; i < data.length; i++) {
        if (i % Math.floor(rate * 0.01) === 0) grain = Math.random();
        data[i] = noise() * grain * Math.sin((Math.PI * i) / data.length);
      }
      bandpass(data, rate, 2200, 0.7);
      break;
    }
    case "metalClick": {
      data = createSamples(rate, 0.12);
      decayHit(data, rate, 0, 4200, 0.004, 1, 0.4);
      decayHit(data, rate, 0.035, 3600, 0.004, 0.6, 0.4);
      highpass(data, rate, 1500);
      break;
    }
    case "projector": {
      // Projecteur à bobines : claquement de la griffe (24 im/s) sur le ronron du moteur.
      data = createSamples(rate, 1);
      for (let frame = 0; frame < 24; frame++) decayHit(data, rate, frame / 24, 900, 0.006, 0.6, 0.7);
      for (let i = 0; i < data.length; i++) data[i] = data[i]! + Math.sin((2 * Math.PI * 100 * i) / rate) * 0.15;
      lowpass(data, rate, 3000);
      data = makeLoopable(data, rate, 0.05);
      peak = 0.5;
      break;
    }
    case "crackle": {
      // Grésillement bref (compteur, instrument affolé).
      data = createSamples(rate, 0.03);
      decayHit(data, rate, 0, 5000, 0.0015, 1, 0.95);
      peak = 0.5;
      break;
    }
    case "buzz": {
      // Ampoule qui bourdonne.
      data = createSamples(rate, 1);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = Math.tanh(Math.sin(2 * Math.PI * 100 * t) * 4) * 0.3 + noise() * 0.05;
      }
      lowpass(data, rate, 2500);
      data = makeLoopable(data, rate, 0.1);
      peak = 0.3;
      break;
    }
  }
  const looping = LOOPING_SOUNDS.has(name) || name === "alarm";
  return toBuffer(context, looping ? normalize(data, peak) : fadeEdges(normalize(data, peak), rate, 0.002));
}
