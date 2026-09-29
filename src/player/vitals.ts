import * as THREE from "three";

const MADNESS_DECAY_LAMBDA = 0.45;
/** Au-delà de ce seuil de folie (%), elle ronge directement la santé. */
const MADNESS_DAMAGE_THRESHOLD = 80;
/** Folie (%) à partir de laquelle la chute de santé est à son rythme maximal. */
const MADNESS_DAMAGE_MAX = 95;
/** Vitesse de perte de santé (points/s) une fois `MADNESS_DAMAGE_MAX` atteint. */
const MADNESS_DAMAGE_RATE = 6;

/** Santé irréversible et Folie dissipable du joueur. */
export class PlayerVitals {
  readonly maxHealth = 100;
  readonly maxMadness = 100;
  health = this.maxHealth;
  madness = 0;

  damage(amount: number): boolean {
    if (amount <= 0 || this.health <= 0) return this.health <= 0;
    this.health = Math.max(0, this.health - amount);
    return this.health === 0;
  }

  addMadness(amount: number): void {
    if (amount > 0) this.madness = Math.min(this.maxMadness, this.madness + amount);
  }

  /** Fait avancer folie et santé d'une frame ; renvoie vrai si la santé vient de tomber à 0. */
  update(deltaSeconds: number, calm: boolean): boolean {
    if (calm && this.madness > 0) this.madness = THREE.MathUtils.damp(this.madness, 0, MADNESS_DECAY_LAMBDA, deltaSeconds);
    // Passé 80 % de folie, elle ronge la santé ; le rythme grimpe linéairement jusqu'à son
    // maximum à 95 % (au lieu d'un seuil brutal tout-ou-rien).
    const ramp = THREE.MathUtils.clamp((this.madness - MADNESS_DAMAGE_THRESHOLD) / (MADNESS_DAMAGE_MAX - MADNESS_DAMAGE_THRESHOLD), 0, 1);
    if (ramp <= 0) return false;
    return this.damage(MADNESS_DAMAGE_RATE * ramp * deltaSeconds);
  }

  reset(): void {
    this.health = this.maxHealth;
    this.madness = 0;
  }
}
