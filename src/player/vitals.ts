import * as THREE from "three";

const MADNESS_DECAY_LAMBDA = 0.45;

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

  update(deltaSeconds: number, calm: boolean): void {
    if (!calm || this.madness <= 0) return;
    this.madness = THREE.MathUtils.damp(this.madness, 0, MADNESS_DECAY_LAMBDA, deltaSeconds);
  }

  reset(): void {
    this.health = this.maxHealth;
    this.madness = 0;
  }
}
