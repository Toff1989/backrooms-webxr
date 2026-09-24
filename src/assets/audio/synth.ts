/**
 * Petite boîte à outils de synthèse hors-ligne (pas de fichier audio) : on calcule des
 * échantillons dans un Float32Array puis on les filtre/réverbère en JS, une seule fois,
 * avant de les confier à un AudioBuffer. Objectif : des sons sourds, étouffés, qui sonnent
 * "loin dans un bâtiment vide" plutôt que des bips de synthé.
 */

export function createSamples(sampleRate: number, seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.floor(sampleRate * seconds)));
}

export function toBuffer(context: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buffer = context.createBuffer(1, data.length, context.sampleRate);
  buffer.getChannelData(0).set(data);
  return buffer;
}

/** Filtre passe-bas biquad (RBJ) appliqué en place. */
export function lowpass(data: Float32Array, sampleRate: number, cutoff: number, q = 0.707): Float32Array {
  return biquad(data, sampleRate, cutoff, q, "lowpass");
}

export function highpass(data: Float32Array, sampleRate: number, cutoff: number, q = 0.707): Float32Array {
  return biquad(data, sampleRate, cutoff, q, "highpass");
}

export function bandpass(data: Float32Array, sampleRate: number, center: number, q = 1): Float32Array {
  return biquad(data, sampleRate, center, q, "bandpass");
}

function biquad(data: Float32Array, sampleRate: number, frequency: number, q: number, type: "lowpass" | "highpass" | "bandpass"): Float32Array {
  const w0 = (2 * Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === "lowpass") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i]!;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    data[i] = y0;
  }
  return data;
}

/** Bruit brun (marche aléatoire amortie) : grondement sourd, pas un souffle aigu. */
export function brownNoise(data: Float32Array, amplitude = 1): Float32Array {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + (Math.random() * 2 - 1) * 0.02) * 0.998;
    data[i] = data[i]! + last * 3.5 * amplitude;
  }
  return data;
}

/**
 * Réverbération de grande pièce vide (Schroeder : 4 filtres en peigne + 2 passe-tout).
 * Les sons ponctuels gagnent une queue qui traîne dans les couloirs.
 */
export function reverb(data: Float32Array, sampleRate: number, wet = 0.4, size = 1): Float32Array {
  const combDelays = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => Math.floor(d * size * sampleRate));
  const combFeedback = 0.84;
  const out = new Float32Array(data.length);
  for (const delay of combDelays) {
    const buffer = new Float32Array(delay);
    let index = 0;
    let damp = 0;
    for (let i = 0; i < data.length; i++) {
      const delayed = buffer[index]!;
      damp = delayed * 0.6 + damp * 0.4;
      buffer[index] = data[i]! + damp * combFeedback;
      out[i] = out[i]! + delayed * 0.25;
      index = (index + 1) % delay;
    }
  }
  for (const seconds of [0.005, 0.0017]) {
    const delay = Math.floor(seconds * sampleRate);
    const buffer = new Float32Array(delay);
    let index = 0;
    for (let i = 0; i < out.length; i++) {
      const delayed = buffer[index]!;
      const input = out[i]!;
      const output = -input * 0.7 + delayed;
      buffer[index] = input + delayed * 0.7;
      out[i] = output;
      index = (index + 1) % delay;
    }
  }
  for (let i = 0; i < data.length; i++) data[i] = data[i]! * (1 - wet) + out[i]! * wet;
  return data;
}

/** Normalise au pic donné (évite les écarts de volume entre sons générés). */
export function normalize(data: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]!));
  if (max === 0) return data;
  const gain = peak / max;
  for (let i = 0; i < data.length; i++) data[i] = data[i]! * gain;
  return data;
}

/** Fondu d'entrée/sortie (évite les clics aux extrémités). */
export function fadeEdges(data: Float32Array, sampleRate: number, seconds = 0.01): Float32Array {
  const n = Math.min(Math.floor(seconds * sampleRate), Math.floor(data.length / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    data[i] = data[i]! * g;
    data[data.length - 1 - i] = data[data.length - 1 - i]! * g;
  }
  return data;
}

/** Fondu enchaîné de la fin sur le début : boucle sans couture pour les sons continus. */
export function makeLoopable(data: Float32Array, sampleRate: number, seconds = 0.25): Float32Array {
  const n = Math.min(Math.floor(seconds * sampleRate), Math.floor(data.length / 3));
  const out = data.slice(0, data.length - n);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    out[i] = data[i]! * g + data[data.length - n + i]! * (1 - g);
  }
  return out;
}
