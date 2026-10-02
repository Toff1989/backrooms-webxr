import * as THREE from "three";

/** Ce que le signal du caméscope traque : la sortie du level, le Cadreur ou l'archive perdue la plus proche. */
export type TrackMode = "exit" | "cadreur" | "archive";
export const TRACK_MODES: readonly TrackMode[] = ["exit", "cadreur", "archive"];

/** Plein à moins de 5 m ; la sortie est à 65-150 m du spawn (voir `levelProfile.ts`) : le signal ne s'éteint qu'au-delà. */
const EXIT_NEAR = 5;
const EXIT_RANGE = 150;
const CADREUR_NEAR = 3;
const CADREUR_RANGE = 37;
const ARCHIVE_NEAR = 4;
const ARCHIVE_RANGE = 90;
/** Traquer le Cadreur vide la pile de la lampe (fraction de pile par seconde) : ~100 s sur une pile pleine. */
export const CADREUR_TRACK_DRAIN_PER_SECOND = 0.01;

export interface TrackInputs {
  head: THREE.Vector3;
  /** Direction du regard à plat (x, z), normalisée. */
  forward: { x: number; z: number };
  exit: { x: number; z: number };
  /** Position du Cadreur quand il est là, sinon null. */
  cadreur: { x: number; z: number } | null;
  /** Archive perdue de ce level encore à trouver, sinon null (déjà lue, ou récit complet). */
  archive: { x: number; z: number } | null;
  /** Pile restante de la lampe (0..1) : à sec, le suivi du Cadreur est coupé. */
  battery: number;
  /** Brouillage (corruption) : réduit le signal. */
  noise: number;
}

export interface TrackReading {
  mode: TrackMode;
  /** Force du signal [0..1]. */
  signal: number;
  /** Distance (m) à la cible, null si introuvable. */
  distance: number | null;
  /** Angle (rad) de la cible par rapport au regard, + à droite ; null pour la sortie (distance seule). Non affiché pour l'instant : le HUD ne montre que la distance. */
  bearing: number | null;
  /** Mode qui consomme la pile et pile vide / cible absente : rien à afficher. */
  unavailable: boolean;
  /** Vrai quand ce mode vide la pile (Cadreur détecté). */
  draining: boolean;
}

/** Mode du signal du caméscope et lecture de la cible suivie (voir `CamcorderHud`, `CameraMenu`). */
export class CameraTracker {
  mode: TrackMode = "exit";

  cycle(): TrackMode {
    this.mode = TRACK_MODES[(TRACK_MODES.indexOf(this.mode) + 1) % TRACK_MODES.length]!;
    return this.mode;
  }

  read(inputs: TrackInputs): TrackReading {
    const mode = this.mode;
    const jitter = 1 - inputs.noise * 0.6 * Math.random();
    if (mode === "exit") {
      const distance = Math.hypot(inputs.head.x - inputs.exit.x, inputs.head.z - inputs.exit.z);
      return { mode, signal: strength(distance, EXIT_NEAR, EXIT_RANGE) * jitter, distance, bearing: null, unavailable: false, draining: false };
    }
    if (mode === "cadreur") {
      if (!inputs.cadreur || inputs.battery <= 0) return unavailable(mode);
      return { ...aim(mode, inputs, inputs.cadreur, CADREUR_NEAR, CADREUR_RANGE, jitter), draining: true };
    }
    if (!inputs.archive) return unavailable(mode);
    return aim(mode, inputs, inputs.archive, ARCHIVE_NEAR, ARCHIVE_RANGE, jitter);
  }
}

function strength(distance: number, near: number, range: number): number {
  return THREE.MathUtils.clamp(1 - (distance - near) / range, 0, 1);
}

function unavailable(mode: TrackMode): TrackReading {
  return { mode, signal: 0, distance: null, bearing: null, unavailable: true, draining: false };
}

function aim(mode: TrackMode, inputs: TrackInputs, target: { x: number; z: number }, near: number, range: number, jitter: number): TrackReading {
  const dx = target.x - inputs.head.x;
  const dz = target.z - inputs.head.z;
  const distance = Math.hypot(dx, dz);
  // Angle signé entre le regard et la cible (rotation à plat) : positif = la cible est à droite.
  const cross = inputs.forward.x * dz - inputs.forward.z * dx;
  const dot = inputs.forward.x * dx + inputs.forward.z * dz;
  const bearing = Math.atan2(cross, dot);
  return { mode, signal: strength(distance, near, range) * jitter, distance, bearing, unavailable: false, draining: false };
}
