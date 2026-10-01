import * as THREE from "three";
import type { VhsOverlay } from "./vhsOverlay";

export type VignetteLevel = "off" | "soft" | "normal" | "strong";
export const VIGNETTE_LEVELS: readonly VignetteLevel[] = ["off", "soft", "normal", "strong"];

/** Intensité maximale (0..1, voir `VhsOverlay.setVignette`) atteinte en plein déplacement, par niveau. */
const MAX_INTENSITY: Record<VignetteLevel, number> = { off: 0, soft: 0.55, normal: 0.8, strong: 1 };
const FADE_IN_LAMBDA = 9;
const FADE_OUT_LAMBDA = 4;
/** Plancher quand on se déplace à peine : la vignette se déclenche dès le moindre mouvement. */
const MOVING_FLOOR = 0.55;

/**
 * Vignette de confort : les bords se resserrent pendant le déplacement fluide et se dissipent
 * à l'arrêt. Dessinée par le quad plein écran de l'overlay VHS (voir `VhsOverlay.setVignette`) :
 * un quad séparé coûtait une passe plein écran de plus par œil, à chaque frame, même à l'arrêt.
 */
export class ComfortVignette {
  level: VignetteLevel = "normal";

  private currentIntensity = 0;

  constructor(private readonly overlay: VhsOverlay) {}

  get enabled(): boolean {
    return this.level !== "off";
  }

  update(movementIntensity: number, deltaSeconds: number): void {
    const moving = THREE.MathUtils.clamp(movementIntensity, 0, 1);
    const eased = moving > 0.02 ? MOVING_FLOOR + (1 - MOVING_FLOOR) * moving : 0;
    const target = eased * MAX_INTENSITY[this.level];
    const lambda = target > this.currentIntensity ? FADE_IN_LAMBDA : FADE_OUT_LAMBDA;
    this.currentIntensity = THREE.MathUtils.damp(this.currentIntensity, target, lambda, deltaSeconds);
    this.overlay.setVignette(this.currentIntensity);
  }
}
