import * as THREE from "three";
import { loreFragment } from "../i18n";
import type { CamcorderHud } from "./camcorderHud";

/** Volume du souffle de bande (relatif au volume général du jeu). */
const HISS_VOLUME = 0.09;
const SPEAKER_SECONDS = 2.2;
const MIN_LINE_SECONDS = 2.6;
/** Temps de lecture d'un sous-titre : ~15 caractères par seconde. */
const SECONDS_PER_CHAR = 0.066;

interface Subtitle {
  text: string;
  seconds: number;
  color: string;
}

/**
 * Lecteur des cassettes audio des bandes perdues. Pas de voix enregistrée : le souffle d'une
 * vieille bande magnétique (bruit filtré, pleurage lent) pendant que la transcription défile en
 * sous-titres dans le viseur du caméscope — le locuteur d'abord, puis chaque réplique.
 */
export class TapePlayer {
  private readonly context: AudioContext;
  private noise: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private wow: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private queue: Subtitle[] = [];
  private timer = 0;
  private fragment: number | null = null;

  constructor(
    private readonly listener: THREE.AudioListener,
    private readonly hud: CamcorderHud,
  ) {
    this.context = listener.context;
  }

  get playing(): boolean {
    return this.fragment !== null;
  }

  /** Lance la cassette `fragment` (sans effet si elle est déjà en cours de lecture). */
  play(fragment: number): void {
    if (this.fragment === fragment) return;
    this.stop();
    const lines = (loreFragment(fragment) ?? "").split("\n").filter(Boolean);
    const speaker = lines[0]?.startsWith("[") ? lines.shift()!.slice(1, -1) : null;
    this.queue = [
      ...(speaker ? [{ text: `● ${speaker}`, seconds: SPEAKER_SECONDS, color: "#7fc4e8" }] : []),
      ...lines.map((text) => ({ text: `« ${text} »`, seconds: Math.max(MIN_LINE_SECONDS, text.length * SECONDS_PER_CHAR), color: "#f4f1e8" })),
    ];
    this.fragment = fragment;
    this.timer = 2;
    this.startHiss();
  }

  update(deltaSeconds: number): void {
    if (this.fragment === null) return;
    this.timer -= deltaSeconds;
    if (this.timer > 0) return;
    const next = this.queue.shift();
    if (!next) {
      this.stop();
      return;
    }
    this.hud.showNotice(next.text, next.seconds + 0.2, next.color);
    this.timer = next.seconds;
  }

  stop(): void {
    if (this.fragment === null) return;
    this.fragment = null;
    this.queue = [];
    const now = this.context.currentTime;
    const { source, wow, gain } = this;
    if (gain && source && wow) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, 0.08);
      source.stop(now + 0.5);
      wow.stop(now + 0.5);
    }
    this.source = null;
    this.wow = null;
    this.gain = null;
  }

  private startHiss(): void {
    const context = this.context;
    if (!this.noise) {
      const length = context.sampleRate * 2;
      this.noise = context.createBuffer(1, length, context.sampleRate);
      const data = this.noise.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        brown = (brown + 0.02 * white) / 1.02;
        // Souffle + ronflement grave + petits craquements de bande.
        data[i] = white * 0.55 + brown * 3 + (Math.random() < 0.0004 ? (Math.random() - 0.5) * 3 : 0);
      }
    }
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 2100;
    band.Q.value = 0.55;
    // Pleurage : la bande ondule lentement (fréquence du filtre modulée).
    const wow = context.createOscillator();
    wow.frequency.value = 0.6;
    const wowDepth = context.createGain();
    wowDepth.gain.value = 420;
    wow.connect(wowDepth).connect(band.frequency);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(HISS_VOLUME, now + 0.25);
    source.connect(band).connect(gain).connect(this.listener.getInput());
    source.start(now);
    wow.start(now);
    this.source = source;
    this.wow = wow;
    this.gain = gain;
  }
}
