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
  private notice = "";
  private noticeColor = "#e8c34a";
  private noticeUntil = 0;
  /** Contenu du dernier dessin (voir `redraw`). */
  private lastSignature = "";

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

  /**
   * Message bref dans le viseur (bande ajoutée au journal, sous-titre d'une cassette), à la
   * place de la ligne de mesures ; coupé sur deux lignes s'il est long.
   */
  showNotice(text: string, seconds = 4, color = "#e8c34a"): void {
    this.notice = text;
    this.noticeColor = color;
    this.noticeUntil = this.elapsedSeconds + seconds;
    this.timeSinceRedraw = Infinity;
  }

  clearNotice(): void {
    this.noticeUntil = 0;
    this.timeSinceRedraw = Infinity;
  }

  /** Temps d'enregistrement de la run (s), celui du compteur REC. */
  get recordingSeconds(): number {
    return this.elapsedSeconds;
  }

  /** Remet le compteur REC à zéro (nouvelle run). */
  resetClock(): void {
    this.elapsedSeconds = 0;
    this.noticeUntil = 0;
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
    const blink = Math.floor(this.elapsedSeconds * 1.2) % 2 === 0;
    const total = Math.floor(this.elapsedSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const clock = `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    // Batterie de la lampe torche (vraie ressource de jeu) : rouge sous 20 %, clignote sous 10 %.
    const level = Math.round(this.status.battery * 100);
    const battery = level >= 10 || blink ? `${t("hud.battery")} ${level}%` : "";
    const depth = `${t("hud.level")} ${this.status.depth}`;
    const bag = `${t("hud.bag")} ${this.status.items}`;
    // Signal de la sortie (façon réception du caméscope) : 5 barres, de plus en plus pleines.
    const bars = Math.round(this.status.signal * 5);
    const signalText = `${t("hud.signal")} ${"▮".repeat(bars)}${"▯".repeat(5 - bars)}`;
    const flags = [this.status.crouching ? t("hud.crouch") : "", this.status.sprinting ? t("hud.sprint") : "", this.status.flashlight ? t("hud.flashlight") : ""].filter(Boolean).join("  ");
    const notice = this.elapsedSeconds < this.noticeUntil ? `${this.noticeColor}${this.notice}` : "";
    const debug = notice ? "" : (this.status.debug ?? "");
    // Rien n'a changé depuis le dernier dessin : ni redessin, ni envoi de la texture au GPU
    // (1024 × 220 px, mipmaps comprises) — le cas le plus courant entre deux secondes du compteur.
    const signature = `${blink}|${clock}|${battery}|${depth}|${bag}|${signalText}|${flags}|${notice}|${debug}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    ctx.font = "bold 44px monospace";
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
    this.text(clock, CANVAS_WIDTH / 2, 48, "center");
    if (battery) this.text(battery, CANVAS_WIDTH - 20, 48, "right", level < 20 ? "#ff6b5a" : "#f4f1e8");

    ctx.font = "bold 34px monospace";
    this.text(depth, 20, 120, "left", "#ffe89a");
    this.text(bag, 200, 120, "left");
    const SIGNAL_X = 380;
    // Les indicateurs passent sur leur propre ligne s'ils empiéteraient sur SIGNAL (langue plus
    // longue, ou les trois actifs à la fois) : mieux vaut deux lignes lisibles qu'un chevauchement.
    const signalEndX = SIGNAL_X + ctx.measureText(signalText).width;
    const flagsStartX = flags ? CANVAS_WIDTH - 20 - ctx.measureText(flags).width : CANVAS_WIDTH;
    const flagsOnOwnRow = signalEndX + 24 > flagsStartX;
    this.text(signalText, SIGNAL_X, 120, "left", bars >= 4 ? "#9fe39f" : "#f4f1e8");
    if (flags) this.text(flags, CANVAS_WIDTH - 20, flagsOnOwnRow ? 148 : 120, "right", "#b9e0ff");

    if (notice) {
      ctx.font = "bold 27px monospace";
      const lines = wrapTwoLines(ctx, this.notice, CANVAS_WIDTH - 60);
      lines.forEach((line, index) => this.text(line, CANVAS_WIDTH / 2, lines.length === 1 ? 185 : 168 + index * 34, "center", this.noticeColor));
    } else if (debug) {
      ctx.font = "bold 21px monospace";
      this.text(debug, 20, 185, "left", "#9dff9d");
    }

    this.texture.needsUpdate = true;
  }
}

/** Coupe un texte en deux lignes au plus (la seconde tronquée si besoin). */
function wrapTwoLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = text.split(" ");
  let first = "";
  while (words.length > 0 && ctx.measureText(first ? `${first} ${words[0]}` : words[0]!).width <= maxWidth) first = first ? `${first} ${words.shift()}` : words.shift()!;
  let second = words.join(" ");
  while (second.length > 1 && ctx.measureText(second).width > maxWidth) second = `${second.slice(0, -2)}…`;
  return [first, second];
}
