import * as THREE from "three";

const ON_INTENSITY = 26;
const LIGHT_COLOR = 0xfff1d6;
const RANGE = 18;
const DECAY = 1.3;
const ANGLE_DEGREES = 30;
const PENUMBRA = 0.6;
/** Autonomie d'une batterie pleine (s) lampe allumée, avant bonus de collection. */
const BATTERY_SECONDS = 240;
/** Sous ce niveau, la lampe faiblit et grésille. */
const LOW_BATTERY = 0.2;

/**
 * Lampe torche frontale (B) — comme la lampe de poitrine de Saints & Sinners, indispensable
 * dans les zones où les néons sont éteints (voir `lightField.ts`) : là-bas, l'éclairage
 * ambiant tombe presque à zéro et seule cette lumière directe éclaire les surfaces. La
 * lumière existe toujours dans la scène et ne fait que changer d'intensité : ajouter/retirer
 * une lumière forcerait la recompilation de tous les shaders (gros à-coup sur Quest).
 *
 * Le grésillement suit des baisses de tension lissées et de rares micro-coupures (plutôt
 * qu'un tirage aléatoire à chaque frame, qui stroboscopait dès la moindre corruption).
 *
 * Batterie : la lampe se vide quand elle est allumée (HUD `BAT`), faiblit sous 20 % et
 * s'éteint à 0 — il faut trouver des piles (voir `BatteryPickups`). Les zones sombres
 * deviennent un vrai choix : traverser vite dans le noir, ou dépenser de la batterie.
 */

export class Flashlight {
  on = false;
  private readonly light: THREE.SpotLight;
  private intensity = 0;
  private sag = 0;
  private sagTarget = 0;
  private sagTimer = 0;
  private cutSeconds = 0;
  /** Charge restante (0..1). */
  battery = 1;
  /** Multiplicateur d'autonomie (bonus de collection). */
  capacity = 1;

  constructor(camera: THREE.Camera) {
    this.light = new THREE.SpotLight(LIGHT_COLOR, 0, RANGE, THREE.MathUtils.degToRad(ANGLE_DEGREES), PENUMBRA, DECAY);
    this.light.position.set(0, -0.08, 0);
    this.light.target.position.set(0, -0.3, -3);
    camera.add(this.light, this.light.target);
  }

  /** Puissance actuelle (0..1), grésillements et batterie faible compris. */
  get strength(): number {
    return this.intensity / ON_INTENSITY;
  }

  /** Vrai si la lampe éclaire réellement (allumée et pas en micro-coupure). */
  get shining(): boolean {
    return this.intensity > ON_INTENSITY * 0.25;
  }

  /** Bascule la lampe. Faux si elle ne peut pas s'allumer (batterie vide). */
  toggle(): boolean {
    if (!this.on && this.battery <= 0) return false;
    this.on = !this.on;
    return true;
  }

  recharge(amount: number): void {
    this.battery = Math.min(1, this.battery + amount);
  }

  /** Coupure brève (téléportation, glitch fort). */
  cut(seconds: number): void {
    this.cutSeconds = Math.max(this.cutSeconds, seconds);
  }

  update(deltaSeconds: number, corruption: number): void {
    if (this.on) {
      this.battery = Math.max(0, this.battery - deltaSeconds / (BATTERY_SECONDS * this.capacity));
      if (this.battery === 0) this.on = false;
    }
    const low = this.battery < LOW_BATTERY ? 1 - this.battery / LOW_BATTERY : 0;

    this.sagTimer -= deltaSeconds;
    if (this.sagTimer <= 0) {
      // Nouvelle "tension" tous les 0,1 à 0,6 s : amplitude liée à la corruption et à la batterie faible.
      this.sagTarget = Math.random() * Math.min(0.75, 0.08 + corruption * 0.8 + low * 0.4);
      this.sagTimer = 0.1 + Math.random() * 0.5;
      if ((corruption > 0.3 && Math.random() < corruption * 0.25) || Math.random() < low * 0.3) this.cut(0.05 + Math.random() * 0.12);
    }
    this.sag = THREE.MathUtils.damp(this.sag, this.sagTarget, 10, deltaSeconds);
    this.cutSeconds = Math.max(0, this.cutSeconds - deltaSeconds);

    const target = this.on && this.cutSeconds === 0 ? ON_INTENSITY * (1 - this.sag) * (1 - low * 0.6) : 0;
    this.intensity = THREE.MathUtils.damp(this.intensity, target, 22, deltaSeconds);
    this.light.intensity = this.intensity;
  }
}
