import * as THREE from "three";
import { setVhsCorruption } from "./vhsMaterial";

/** Vitesse de dissipation (cf. THREE.MathUtils.damp) — plus haut = se dissipe plus vite. */
const DECAY_LAMBDA = 2.2;

/**
 * Intensité de corruption visuelle cumulable (fiche projet, étape 5 : "intensité
 * cumulable... dissipation progressive"). Plusieurs sources (transition de level,
 * pièges glitch) peuvent l'augmenter ; elle se dissipe ensuite dans le temps.
 * Aucune distorsion de position/rotation caméra — uniquement l'uniforme shader VHS.
 */
class CorruptionState {
  private intensity = 0;

  add(amount: number): void {
    this.intensity = Math.min(1, this.intensity + amount);
  }

  update(deltaSeconds: number): void {
    this.intensity = THREE.MathUtils.damp(this.intensity, 0, DECAY_LAMBDA, deltaSeconds);
    setVhsCorruption(this.intensity);
  }
}

export const corruption = new CorruptionState();
