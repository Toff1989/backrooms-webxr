import * as THREE from "three";
import type { VhsOverlay } from "./vhsOverlay";

const MAX_ALPHA = 0.85;
const FADE_LAMBDA = 6;

/**
 * Vignette de confort : les bords s'assombrissent pendant le déplacement fluide et se dissipent
 * à l'arrêt. Dessinée par le quad plein écran de l'overlay VHS (voir `VhsOverlay.setVignette`) :
 * un quad séparé coûtait une passe plein écran de plus par œil, à chaque frame, même à l'arrêt.
 */
export class ComfortVignette {
  enabled = true;

  private currentIntensity = 0;

  constructor(private readonly overlay: VhsOverlay) {}

  update(movementIntensity: number, deltaSeconds: number): void {
    const target = this.enabled ? THREE.MathUtils.clamp(movementIntensity, 0, 1) * MAX_ALPHA : 0;
    this.currentIntensity = THREE.MathUtils.damp(this.currentIntensity, target, FADE_LAMBDA, deltaSeconds);
    this.overlay.setVignette(this.currentIntensity);
  }
}
