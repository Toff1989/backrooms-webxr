import * as THREE from "three";
import { t } from "../i18n";

const WIDTH_METERS = 0.5;
const HEIGHT_METERS = 0.22;
const CANVAS_W = 1000;
const CANVAS_H = Math.round((CANVAS_W * HEIGHT_METERS) / WIDTH_METERS);
// Assez bas pour ne jamais chevaucher le bandeau de notification (noticeModal.ts, transitoire,
// posé plus haut) : une archive au format audio déclenche les deux en même temps.
const POSITION = new THREE.Vector3(0, -0.16, -0.55);
const BAR_COUNT = 28;

/**
 * Modal dédié à la lecture d'une cassette (archive au format audio) : affiché tant qu'elle
 * joue, avec une animation de "signal capté" (barres qui grésillent, comme une réception TV
 * brouillée) et la transcription qui défile — déplacée hors du HUD caméscope, trop discret
 * pour porter tout le contenu d'une archive. Le grésillement audio lui-même reste dans
 * `tapePlayer.ts` (bruit de bande procédural, déjà en place).
 */
export class TapeSignalModal {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;
  private readonly bars = new Float32Array(BAR_COUNT).fill(0.2);
  private line = "";
  private lineColor = "#f4f1e8";
  private elapsed = 0;
  private redrawTimer = 0;

  constructor(camera: THREE.Camera) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Contexte 2D indisponible pour le modal de cassette");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH_METERS, HEIGHT_METERS), material);
    this.mesh.position.copy(POSITION);
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    camera.add(this.mesh);
  }

  show(): void {
    this.mesh.visible = true;
    this.line = "";
    this.redraw();
  }

  hide(): void {
    this.mesh.visible = false;
  }

  /** Réplique courante de la transcription (voir tapePlayer.ts), avec la couleur du locuteur/texte. */
  setLine(text: string, color: string): void {
    this.line = text;
    this.lineColor = color;
  }

  update(deltaSeconds: number): void {
    if (!this.mesh.visible) return;
    this.elapsed += deltaSeconds;
    for (let i = 0; i < BAR_COUNT; i++) {
      const target = 0.25 + 0.75 * Math.abs(Math.sin(this.elapsed * (2.2 + i * 0.37) + i));
      this.bars[i] = THREE.MathUtils.damp(this.bars[i]!, target, 6, deltaSeconds);
    }
    // Redessine à un rythme raisonnable (pas toutes les frames) : suffisant pour un grésillement crédible.
    this.redrawTimer += deltaSeconds;
    if (this.redrawTimer < 0.05) return;
    this.redrawTimer = 0;
    this.redraw();
  }

  private redraw(): void {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.roundRect(4, 4, width - 8, height - 8, 26);
    ctx.fillStyle = "rgba(10, 9, 6, 0.92)";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#7fc4e8";
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 30px monospace";
    ctx.fillStyle = "#7fc4e8";
    ctx.fillText(t("notice.tapeTitle"), width / 2, 56);

    const barsTop = 90;
    const barsHeight = 90;
    const barWidth = (width - 80) / BAR_COUNT;
    for (let i = 0; i < BAR_COUNT; i++) {
      const h = barsHeight * this.bars[i]!;
      ctx.fillStyle = i % 4 === 0 ? "#ffe89a" : "rgba(127, 196, 232, 0.85)";
      ctx.fillRect(40 + i * barWidth + 2, barsTop + barsHeight - h, barWidth - 4, h);
    }

    if (this.line) {
      ctx.font = "26px monospace";
      ctx.fillStyle = this.lineColor;
      ctx.fillText(this.line, width / 2, height - 44);
    }

    this.texture.needsUpdate = true;
  }
}
