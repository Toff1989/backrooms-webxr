import * as THREE from "three";
import type { Hand } from "../player/hand";

export type PressButton = "trigger" | "grip";

export interface PanelHit {
  distance: number;
  /** Coordonnées canvas (pixels) du point visé. */
  px: number;
  py: number;
  point: THREE.Vector3;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function inRect(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

const tmpInverse = new THREE.Matrix4();
const tmpOrigin = new THREE.Vector3();
const tmpDirection = new THREE.Vector3();
const tmpLocal = new THREE.Vector3();

/**
 * Panneau de menu en espace monde : texture canvas sur un plan, visée au pointeur laser
 * (voir `UiPointer`). Les sous-classes dessinent le canvas et réagissent au survol/aux clics.
 */
/**
 * Intervalle minimal (ms) entre deux redessins effectifs d'un panneau. Un survol qui change
 * (rayon laser qui tremble pile à la frontière de deux cases) peut appeler `invalidate()` à
 * chaque frame ; sans ce plancher, chaque appel redessine tout le canvas (fillText/roundRect en
 * nombre) et réuploade la texture au GPU — coûteux, et inutile à plus de ~20 Hz pour une simple
 * surbrillance de survol. L'état affiché reste toujours le plus récent, juste légèrement différé.
 */
const MIN_REDRAW_INTERVAL_MS = 45;

export abstract class UiPanel {
  readonly group = new THREE.Group();
  readonly canvas: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  protected readonly texture: THREE.CanvasTexture;
  protected readonly mesh: THREE.Mesh;
  private dirty = true;
  private lastDrawAt = -Infinity;

  protected constructor(
    readonly widthMeters: number,
    readonly heightMeters: number,
    pixelsPerMeter: number,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.round(widthMeters * pixelsPerMeter);
    this.canvas.height = Math.round(heightMeters * pixelsPerMeter);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Contexte 2D indisponible pour un panneau de menu");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthMeters, heightMeters),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }),
    );
    this.mesh.renderOrder = 10;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Redessin demandé : fait au prochain `refresh`, jamais plus d'une fois par frame. */
  invalidate(): void {
    this.dirty = true;
  }

  refresh(): void {
    if (!this.dirty || !this.visible) return;
    const now = performance.now();
    // Reste "dirty" : redessiné dès que le prochain refresh() passe le seuil, jamais perdu.
    if (now - this.lastDrawAt < MIN_REDRAW_INTERVAL_MS) return;
    this.dirty = false;
    this.lastDrawAt = now;
    this.draw(this.ctx);
    this.texture.needsUpdate = true;
  }

  raycast(origin: THREE.Vector3, direction: THREE.Vector3): PanelHit | null {
    if (!this.visible) return null;
    this.mesh.updateWorldMatrix(true, false);
    tmpInverse.copy(this.mesh.matrixWorld).invert();
    tmpOrigin.copy(origin).applyMatrix4(tmpInverse);
    tmpDirection.copy(direction).transformDirection(tmpInverse);
    if (Math.abs(tmpDirection.z) < 1e-6) return null;
    const t = -tmpOrigin.z / tmpDirection.z;
    if (t <= 0) return null;
    tmpLocal.copy(tmpOrigin).addScaledVector(tmpDirection, t);
    const halfW = this.widthMeters / 2;
    const halfH = this.heightMeters / 2;
    if (Math.abs(tmpLocal.x) > halfW || Math.abs(tmpLocal.y) > halfH) return null;

    const point = tmpLocal.clone().applyMatrix4(this.mesh.matrixWorld);
    return {
      distance: point.distanceTo(origin),
      px: ((tmpLocal.x + halfW) / this.widthMeters) * this.canvas.width,
      py: ((halfH - tmpLocal.y) / this.heightMeters) * this.canvas.height,
      point,
    };
  }

  /** Le point monde est-il "sur" le panneau (volume juste devant/derrière), pour y déposer un objet. */
  containsPoint(world: THREE.Vector3, margin = 0.06): boolean {
    if (!this.visible) return false;
    this.mesh.updateWorldMatrix(true, false);
    tmpLocal.copy(world).applyMatrix4(tmpInverse.copy(this.mesh.matrixWorld).invert());
    return (
      Math.abs(tmpLocal.x) <= this.widthMeters / 2 + margin &&
      Math.abs(tmpLocal.y) <= this.heightMeters / 2 + margin &&
      tmpLocal.z > -0.12 &&
      tmpLocal.z < 0.22
    );
  }

  /** Survol courant du pointeur de cette main (null = plus survolé). */
  abstract onHover(hand: Hand, px: number | null, py: number | null): void;
  /** Clic ; renvoie vrai si l'appui est consommé (il ne doit alors rien attraper dans le monde). */
  abstract onPress(hand: Hand, px: number, py: number, button: PressButton): boolean;
  protected abstract draw(ctx: CanvasRenderingContext2D): void;
}

/** Bouton arrondi dessiné sur un canvas de panneau. */
export function drawButton(ctx: CanvasRenderingContext2D, rect: Rect, label: string, state: { hovered: boolean; accent?: string; disabled?: boolean }): void {
  const radius = 14;
  ctx.save();
  ctx.globalAlpha = state.disabled ? 0.35 : 1;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  ctx.fillStyle = state.hovered ? (state.accent ?? "#e9d9a6") : "rgba(255, 244, 214, 0.08)";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = state.accent ?? "rgba(255, 244, 214, 0.45)";
  ctx.stroke();
  ctx.fillStyle = state.hovered ? "#15110b" : (state.accent ?? "#efe6cf");
  ctx.font = "bold 30px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
  ctx.restore();
}

/** Fond commun des panneaux : cadre sombre, liseré ambré (cohérent avec le HUD caméscope). */
export function drawPanelBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  ctx.roundRect(4, 4, width - 8, height - 8, 28);
  ctx.fillStyle = "rgba(12, 10, 7, 0.9)";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(255, 226, 150, 0.35)";
  ctx.stroke();
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): void {
  const words = text.split(" ");
  let line = "";
  let lines = 0;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      line = word;
      lines += 1;
      if (lines >= maxLines) return;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, y + lines * lineHeight);
}
