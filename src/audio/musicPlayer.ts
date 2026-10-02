import * as THREE from "three";
import insistentUrl from "../assets/audio/music/insistent.ogg?url";
import paranoidTruthUrl from "../assets/audio/music/paranoid-truth.ogg?url";
import searchingUrl from "../assets/audio/music/searching.ogg?url";

/** Musique d'ambiance (CC0, voir `assets/audio/music/README.txt`) : enchaînée en fondu, jamais deux fois la même d'affilée. */
const TRACK_URLS = [paranoidTruthUrl, searchingUrl, insistentUrl];
/** Silence avant la toute première piste, puis durée du fondu enchaîné entre deux pistes (s). */
const START_DELAY_SECONDS = 4;
const FADE_SECONDS = 6;
/** Niveau d'une piste à pleine échelle : la musique reste un fond, jamais devant les sons du jeu. */
const TRACK_GAIN = 0.55;
/** Part de la musique conservée quand une menace est proche (elle s'efface pour laisser entendre le danger). */
const THREAT_DUCK_FLOOR = 0.25;
const DUCK_LAMBDA = 1.6;

interface Track {
  element: HTMLAudioElement;
  audio: THREE.Audio;
  /** Fondu propre à la piste [0..1]. */
  level: number;
}

/**
 * Lecteur de musique. Les pistes sont lues en flux (élément audio) plutôt que décodées en entier
 * (trois minutes de stéréo décodées pèsent des dizaines de Mo, trop pour un casque autonome).
 */
export class MusicPlayer {
  private readonly tracks: Track[];
  private active: Track | null = null;
  private last: Track | null = null;
  private delay = START_DELAY_SECONDS;
  private duck = 1;

  constructor(private readonly listener: THREE.AudioListener) {
    this.tracks = TRACK_URLS.map((url) => {
      const element = new Audio(url);
      element.preload = "none";
      element.loop = false;
      const audio = new THREE.Audio(listener);
      audio.setMediaElementSource(element);
      audio.setVolume(0);
      return { element, audio, level: 0 };
    });
  }

  /** `threat` [0..1] : danger proche (le Cadreur te voit ou te colle), la musique s'efface d'autant. */
  update(deltaSeconds: number, threat: number): void {
    if (this.listener.context.state !== "running") return;
    this.duck = THREE.MathUtils.damp(this.duck, 1 - (1 - THREAT_DUCK_FLOOR) * THREE.MathUtils.clamp(threat, 0, 1), DUCK_LAMBDA, deltaSeconds);

    if (!this.active) {
      this.delay -= deltaSeconds;
      if (this.delay <= 0) this.startNext();
    } else if (this.active.element.duration - this.active.element.currentTime < FADE_SECONDS || this.active.element.ended) {
      this.startNext();
    }

    for (const track of this.tracks) {
      if (track === this.active) {
        track.level = Math.min(1, track.level + deltaSeconds / FADE_SECONDS);
      } else if (track.level > 0) {
        track.level = Math.max(0, track.level - deltaSeconds / FADE_SECONDS);
        if (track.level === 0) track.element.pause();
      }
      track.audio.setVolume(track.level * TRACK_GAIN * this.duck);
    }
  }

  /** Lance une autre piste que la précédente ; l'ancienne s'éteint en fondu. */
  private startNext(): void {
    const candidates = this.tracks.filter((track) => track !== this.active && track !== this.last);
    const pool = candidates.length > 0 ? candidates : this.tracks.filter((track) => track !== this.active);
    const next = pool[Math.floor(Math.random() * pool.length)];
    if (!next) return;
    this.last = this.active;
    this.active = next;
    next.element.preload = "auto";
    next.element.currentTime = 0;
    next.level = 0;
    void next.element.play().catch(() => {
      // Lecture refusée (pas encore de geste du joueur) : on retentera à la prochaine piste.
      if (this.active === next) this.active = null;
      this.delay = 2;
    });
  }
}
