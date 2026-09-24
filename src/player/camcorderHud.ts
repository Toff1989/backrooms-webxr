import * as THREE from "three";
import { t } from "../i18n";

const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 220;
const UPDATE_INTERVAL_SECONDS = 0.25;
/**
 * Bandeau façon viseur de caméscope, en haut du champ de vision (confortable à lire sans
 * baisser les yeux) : texte blanc cerné de noir sur fond transparent, pas de bloc opaque.
 */
const PANEL_WIDTH = 0.36;
const PANEL_HEIGHT = (CANVAS_HEIGHT / CANVAS_WIDTH) * PANEL_WIDTH;
const PANEL_POSITION = new THREE.Vector3(0, 0.1465, -0.5);

export interface HudStatus {
  depth: number;
  crouching: boolean;
  sprinting: boolean;
  flashlight: boolean;
  items: number;
  /** Batterie de la lampe torche (0..1). */
  battery: number;
  /** Force du "signal" de la sortie (0..1) : monte en s'en approchant. */
  signal: number;
  /** Ligne de mesures de perfs (`?debug=1`), sinon null. */
  debug: string | null;
}

/**
 * Overlay caméscope fixé à la tête : REC clignotant, horodatage de la run, batterie,
 * profondeur, et l'état du corps (accroupi, sprint, lampe) pour que les bascules de
 * boutons soient toujours visibles.
 */
export class CamcorderHud {
  status: HudStatus = { depth: 0, crouching: false, sprinting: false, flashlight: false, items: 0, battery: 1, signal: 0, debug: null };

  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private elapsedSeconds = 0;
  private timeSinceRedraw = Infinity;

  constructor(camera: THREE.Camera) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Contexte 2D indisponible pour le HUD caméscope");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false }),
    );
    mesh.position.copy(PANEL_POSITION);
    mesh.renderOrder = 997;
    mesh.frustumCulled = false;
    camera.add(mesh);
  }

  /** Remet le compteur REC à zéro (nouvelle run). */
  resetClock(): void {
    this.elapsedSeconds = 0;
    this.timeSinceRedraw = Infinity;
  }

  update(deltaSeconds: number): void {
    this.elapsedSeconds += deltaSeconds;
    this.timeSinceRedraw += deltaSeconds;
    if (this.timeSinceRedraw < UPDATE_INTERVAL_SECONDS) return;
    this.timeSinceRedraw = 0;
    this.redraw();
  }

  private text(value: string, x: number, y: number, align: CanvasTextAlign, color = "#f4f1e8"): void {
    const ctx = this.ctx;
    ctx.textAlign = align;
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.strokeText(value, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    ctx.font = "bold 44px monospace";
    const blink = Math.floor(this.elapsedSeconds * 1.2) % 2 === 0;
    if (blink) {
      ctx.beginPath();
      ctx.arc(34, 46, 15, 0, Math.PI * 2);
      ctx.fillStyle = "#ff3b30";
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.stroke();
    }
    this.text("REC", 60, 48, "left");

    const total = Math.floor(this.elapsedSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    this.text(`${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`, CANVAS_WIDTH / 2, 48, "center");

    // Batterie de la lampe torche (vraie ressource de jeu) : rouge sous 20 %, clignote sous 10 %.
    const level = Math.round(this.status.battery * 100);
    if (level >= 10 || blink) this.text(`${t("hud.battery")} ${level}%`, CANVAS_WIDTH - 20, 48, "right", level < 20 ? "#ff6b5a" : "#f4f1e8");

    ctx.font = "bold 34px monospace";
    this.text(`${t("hud.level")} ${this.status.depth}`, 20, 120, "left", "#ffe89a");
    this.text(`${t("hud.bag")} ${this.status.items}`, 200, 120, "left");
    // Signal de la sortie (façon réception du caméscope) : 5 barres, de plus en plus pleines.
    const bars = Math.round(this.status.signal * 5);
    this.text(`${t("hud.signal")} ${"▮".repeat(bars)}${"▯".repeat(5 - bars)}`, 380, 120, "left", bars >= 4 ? "#9fe39f" : "#f4f1e8");
    const flags = [this.status.crouching ? t("hud.crouch") : "", this.status.sprinting ? t("hud.sprint") : "", this.status.flashlight ? t("hud.flashlight") : ""].filter(Boolean).join("  ");
    this.text(flags, CANVAS_WIDTH - 20, 120, "right", "#b9e0ff");

    if (this.status.debug) {
      ctx.font = "bold 21px monospace";
      this.text(this.status.debug, 20, 185, "left", "#9dff9d");
    }

    this.texture.needsUpdate = true;
  }
}
