import * as THREE from "three";

const ON_INTENSITY = 14;
const LIGHT_COLOR = 0xfff1d6;

/**
 * Lampe torche frontale (B) — comme la lampe de poitrine de Saints & Sinners, utile dans les
 * niveaux profonds où les néons faiblissent (voir `Atmosphere`). La lumière existe toujours
 * dans la scène et ne fait que changer d'intensité : ajouter/retirer une lumière forcerait la
 * recompilation de tous les shaders (gros à-coup sur Quest).
 */
export class Flashlight {
  on = false;
  private readonly light: THREE.SpotLight;
  private intensity = 0;

  constructor(camera: THREE.Camera) {
    this.light = new THREE.SpotLight(LIGHT_COLOR, 0, 16, THREE.MathUtils.degToRad(28), 0.55, 1.4);
    this.light.position.set(0, -0.08, 0);
    this.light.target.position.set(0, -0.35, -3);
    camera.add(this.light, this.light.target);
  }

  toggle(): void {
    this.on = !this.on;
  }

  update(deltaSeconds: number, corruption: number): void {
    const target = this.on ? ON_INTENSITY * (1 - Math.min(0.6, corruption * 0.5 * Math.random())) : 0;
    this.intensity = THREE.MathUtils.damp(this.intensity, target, 18, deltaSeconds);
    this.light.intensity = this.intensity;
  }
}
