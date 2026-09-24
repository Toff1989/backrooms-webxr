import * as THREE from "three";
import { getCeilingMaterial } from "./materials";

const BASE_CEILING_EMISSIVE = 2.2;
const BASE_HEMISPHERE = 0.9;
const BASE_AMBIENT = 0.25;
const BASE_FOG_DENSITY = 0.035;
/** Chaque niveau plus bas assombrit l'éclairage (plancher à 28 % : il reste toujours un peu de lumière). */
const DARKENING_PER_DEPTH = 0.09;
const MIN_LIGHT_LEVEL = 0.28;

/**
 * Ambiance lumineuse (direction artistique rapprochée de Saints & Sinners : on commence dans
 * le jaune fluorescent du niveau 0, puis chaque descente assombrit, densifie le brouillard,
 * et les néons grésillent/clignotent quand la corruption monte ou au hasard en profondeur).
 */
export class Atmosphere {
  private lightLevel = 1;
  private flicker = 1;
  private flickerSeconds = 0;
  private nextRandomFlicker = 8;

  /** Niveau courant des néons (profondeur × clignotement), 0..1. */
  get level(): number {
    return this.lightLevel * this.flicker;
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly hemisphere: THREE.HemisphereLight,
    private readonly ambient: THREE.AmbientLight,
  ) {}

  setDepth(depth: number): void {
    this.lightLevel = Math.max(MIN_LIGHT_LEVEL, 1 - depth * DARKENING_PER_DEPTH);
    const fog = this.scene.fog;
    if (fog instanceof THREE.FogExp2) fog.density = BASE_FOG_DENSITY + Math.min(0.03, depth * 0.004);
  }

  /** Déclenche un clignotement des néons (piège, transition, glitch). */
  triggerFlicker(seconds = 0.6): void {
    this.flickerSeconds = Math.max(this.flickerSeconds, seconds);
  }

  update(deltaSeconds: number, corruption: number): void {
    this.nextRandomFlicker -= deltaSeconds;
    if (this.nextRandomFlicker <= 0) {
      // Plus on est bas (lumière faible), plus les pannes spontanées sont fréquentes.
      if (this.lightLevel < 0.95) this.triggerFlicker(0.3 + Math.random() * 0.6);
      this.nextRandomFlicker = 6 + Math.random() * 14 * this.lightLevel;
    }
    if (corruption > 0.35 && Math.random() < deltaSeconds * 2) this.triggerFlicker(0.2);

    if (this.flickerSeconds > 0) {
      this.flickerSeconds -= deltaSeconds;
      this.flicker = Math.random() < 0.45 ? 0.12 + Math.random() * 0.3 : 1;
    } else {
      this.flicker = THREE.MathUtils.damp(this.flicker, 1, 12, deltaSeconds);
    }

    const level = this.lightLevel * this.flicker;
    getCeilingMaterial().emissiveIntensity = BASE_CEILING_EMISSIVE * level;
    this.hemisphere.intensity = BASE_HEMISPHERE * (0.25 + 0.75 * level);
    this.ambient.intensity = BASE_AMBIENT * (0.4 + 0.6 * level);
  }
}
