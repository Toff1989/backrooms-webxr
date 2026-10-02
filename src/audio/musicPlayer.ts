import * as THREE from "three";
import chaseUrl from "../assets/audio/music/chase-horror-cliche.ogg?url";
import insistentUrl from "../assets/audio/music/insistent.ogg?url";
import menuUrl from "../assets/audio/music/menu-theme.ogg?url";
import paranoidTruthUrl from "../assets/audio/music/paranoid-truth.ogg?url";
import searchingUrl from "../assets/audio/music/searching.ogg?url";
import tensionUrl from "../assets/audio/music/tension-distress.ogg?url";

/**
 * Musique liée à ce qui se passe (pistes CC0, voir `assets/audio/music/README.txt`) :
 * - menu : le thème principal, au menu et sur les écrans de fin ;
 * - explore : pistes d'ambiance enchaînées en fondu, jamais deux fois la même d'affilée ;
 * - tension : coupure de courant, folie qui monte ;
 * - chase : le Cadreur te voit ou te colle.
 * Chaque changement d'état est un fondu enchaîné : la poursuite entre vite, en sort lentement.
 */
export type MusicState = "menu" | "explore" | "tension" | "chase";

interface TrackDef {
  url: string;
  state: MusicState;
  /** Niveau de la piste à pleine échelle (les pistes sont déjà normalisées à -24 LUFS). */
  gain: number;
}

const TRACK_DEFS: readonly TrackDef[] = [
  { url: menuUrl, state: "menu", gain: 0.6 },
  { url: paranoidTruthUrl, state: "explore", gain: 0.55 },
  { url: searchingUrl, state: "explore", gain: 0.55 },
  { url: insistentUrl, state: "explore", gain: 0.55 },
  { url: tensionUrl, state: "tension", gain: 0.6 },
  { url: chaseUrl, state: "chase", gain: 0.75 },
];

/** Seules ces pistes s'enchaînent entre elles ; les autres états bouclent sur leur unique piste. */
const ROTATING_STATE: MusicState = "explore";
const START_DELAY_SECONDS = 2;
/** Durée du fondu entre deux pistes d'ambiance, et fin de piste à partir de laquelle on lance la suivante. */
const ROTATE_FADE_SECONDS = 6;
/** Fondu d'entrée selon l'état d'arrivée (s) ; la poursuite entre vite. */
const FADE_IN: Record<MusicState, number> = { menu: 3, explore: 5, tension: 3, chase: 1.5 };
/** Fondu de sortie de l'ancienne piste : rapide pour laisser place à la poursuite, lent quand elle se termine. */
const FADE_OUT_TO_CHASE = 1.5;
const FADE_OUT_FROM_CHASE = 5;
const FADE_OUT_DEFAULT = 3;
/** Un état ne change pas avant ce délai (s), pour éviter les va-et-vient — sauf poursuite et menu. */
const MIN_HOLD_SECONDS = 8;

interface Track {
  def: TrackDef;
  element: HTMLAudioElement;
  audio: THREE.Audio;
  /** Fondu propre à la piste [0..1]. */
  level: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

/**
 * Lecteur de musique. Les pistes sont lues en flux (élément audio) plutôt que décodées en entier
 * (plusieurs minutes de stéréo décodées pèsent des dizaines de Mo, trop pour un casque autonome).
 */
export class MusicPlayer {
  private readonly tracks: Track[];
  private active: Track | null = null;
  private last: Track | null = null;
  private state: MusicState = "menu";
  private sinceSwitch = MIN_HOLD_SECONDS;
  private delay = START_DELAY_SECONDS;

  constructor(private readonly listener: THREE.AudioListener) {
    this.tracks = TRACK_DEFS.map((def) => {
      const element = new Audio(def.url);
      element.preload = "none";
      element.loop = def.state !== ROTATING_STATE;
      const audio = new THREE.Audio(listener);
      audio.setMediaElementSource(element);
      audio.setVolume(0);
      return { def, element, audio, level: 0, fadeInSeconds: 3, fadeOutSeconds: 3 };
    });
  }

  update(deltaSeconds: number, wanted: MusicState): void {
    if (this.listener.context.state !== "running") return;
    this.sinceSwitch += deltaSeconds;

    if (wanted !== this.state && (this.sinceSwitch >= MIN_HOLD_SECONDS || wanted === "chase" || wanted === "menu")) {
      const previous = this.state;
      this.state = wanted;
      this.sinceSwitch = 0;
      if (this.active) this.start(wanted, previous);
    }

    if (!this.active) {
      this.delay -= deltaSeconds;
      if (this.delay <= 0) this.start(this.state, this.state);
    } else if (this.state === ROTATING_STATE) {
      const element = this.active.element;
      if (element.duration - element.currentTime < ROTATE_FADE_SECONDS || element.ended) this.start(this.state, this.state, ROTATE_FADE_SECONDS);
    }

    for (const track of this.tracks) {
      if (track === this.active) track.level = Math.min(1, track.level + deltaSeconds / track.fadeInSeconds);
      else if (track.level > 0) {
        track.level = Math.max(0, track.level - deltaSeconds / track.fadeOutSeconds);
        if (track.level === 0) track.element.pause();
      }
      track.audio.setVolume(track.level * track.def.gain);
    }
  }

  /** Lance une piste de l'état voulu (pas la précédente) ; l'ancienne s'éteint en fondu. */
  private start(state: MusicState, from: MusicState, rotateFade?: number): void {
    const pool = this.tracks.filter((track) => track.def.state === state);
    const fresh = pool.filter((track) => track !== this.active && track !== this.last);
    const candidates = fresh.length > 0 ? fresh : pool.filter((track) => track !== this.active || pool.length === 1);
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    if (!next) return;
    const previous = this.active;
    if (previous && previous !== next) {
      previous.fadeOutSeconds = rotateFade ?? (state === "chase" ? FADE_OUT_TO_CHASE : from === "chase" ? FADE_OUT_FROM_CHASE : FADE_OUT_DEFAULT);
      this.last = previous;
    }
    this.active = next;
    next.fadeInSeconds = rotateFade ?? FADE_IN[state];
    next.element.preload = "auto";
    if (next.level === 0) next.element.currentTime = 0;
    void next.element.play().catch(() => {
      // Lecture refusée (pas encore de geste du joueur) : on retentera dans un instant.
      if (this.active === next) this.active = null;
      this.delay = 2;
    });
  }
}
