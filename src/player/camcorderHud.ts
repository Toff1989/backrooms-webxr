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
const GAUGES_POSITION = new THREE.Vector3(0.2, -0.2, -0.5);
const GAUGE_SPACING = 0.047;

type GaugeId = "energy" | "health" | "madness";

interface GaugeDisplay {
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
  visibleUntil: number;
  lastValue: number;
}

export interface HudStatus {
  depth: number;
  crouching: boolean;
  sprinting: boolean;
  flashlight: boolean;
  items: number;
  /** Batterie de la lampe torche (0..1). */
  battery: number;
  /** Energie de sprint (0..1). */
  sprintEnergy: number;
  /** Force du "signal" de la cible suivie (0..1) : monte en s'en approchant. */
  signal: number;
  /** Libellé du mode de traque ("SIGNAL" pour la sortie, "CADREUR", "ARCHIVE"). */
  signalLabel: string;
  /** Flèche + distance vers la cible (modes Cadreur/Archive), "--" si introuvable, "" pour la sortie. */
  signalAim: string;
  /** Santé du joueur (0..1), irréversible pendant la run. */
  health: number;
  /** Folie du joueur (0..1), dissipée par l'attente lampe allumée. */
  madness: number;
  /** Ligne de mesures de perfs (`?debug=1`), sinon null. */
  debug: string | null;
}

/**
 * Overlay caméscope fixé à la tête : REC clignotant, horodatage de la run, batterie,
 * profondeur, et l'état du corps (accroupi, sprint, lampe) pour que les bascules de
 * boutons soient toujours visibles.
 */
export class CamcorderHud {
  status: HudStatus = {
    depth: 0,
    crouching: false,
    sprinting: false,
    flashlight: false,
    items: 0,
    battery: 1,
    sprintEnergy: 1,
    signal: 0,
    signalLabel: "",
    signalAim: "",
    health: 1,
    madness: 0,
    debug: null,
  };

  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly gauges = new Map<GaugeId, GaugeDisplay>();
  private elapsedSeconds = 0;
  private timeSinceRedraw = Infinity;
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

    const gaugeIds: GaugeId[] = ["energy", "health", "madness"];
    gaugeIds.forEach((id, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Contexte 2D indisponible pour les jauges de survie");
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.04, 0.18),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false }),
      );
      mesh.position.set(GAUGES_POSITION.x + (index - (gaugeIds.length - 1) / 2) * GAUGE_SPACING, GAUGES_POSITION.y, GAUGES_POSITION.z);
      mesh.renderOrder = 998;
      mesh.frustumCulled = false;
      mesh.visible = false;
      camera.add(mesh);
      this.gauges.set(id, { ctx, texture, mesh, visibleUntil: 0, lastValue: id === "health" || id === "energy" ? 1 : 0 });
    });
  }

  /** Temps d'enregistrement de la run (s), celui du compteur REC. */
  get recordingSeconds(): number {
    return this.elapsedSeconds;
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

  private updateGauge(id: GaugeId, value: number, label: string, color: string): void {
    const gauge = this.gauges.get(id)!;
    if (Math.abs(value - gauge.lastValue) > 0.001) {
      gauge.visibleUntil = this.elapsedSeconds + 2.2;
      gauge.lastValue = value;
      gauge.ctx.clearRect(0, 0, 64, 256);
      drawVerticalBar(gauge.ctx, 32, label, value, color);
      gauge.texture.needsUpdate = true;
    }
    gauge.mesh.visible = this.elapsedSeconds < gauge.visibleUntil;
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
    const energyLevel = THREE.MathUtils.clamp(this.status.sprintEnergy, 0, 1);
    const healthLevel = THREE.MathUtils.clamp(this.status.health, 0, 1);
    const madnessLevel = THREE.MathUtils.clamp(this.status.madness, 0, 1);
    this.updateGauge("energy", energyLevel, t("hud.energyShort"), energyLevel < 0.2 ? "#ff6b5a" : "#9fe39f");
    this.updateGauge("health", healthLevel, t("hud.healthShort"), "#ff6b5a");
    this.updateGauge("madness", madnessLevel, t("hud.madnessShort"), "#c48cff");
    const depth = `${t("hud.level")} ${this.status.depth}`;
    const bag = `${t("hud.bag")} ${this.status.items}`;
    // Signal de la sortie (façon réception du caméscope) : 5 barres, de plus en plus pleines.
    const bars = Math.round(this.status.signal * 5);
    const signalText = `${this.status.signalLabel || t("hud.signal")} ${"▮".repeat(bars)}${"▯".repeat(5 - bars)}${this.status.signalAim ? ` ${this.status.signalAim}` : ""}`;
    const flags = [this.status.crouching ? t("hud.crouch") : "", this.status.sprinting ? t("hud.sprint") : "", this.status.flashlight ? t("hud.flashlight") : ""].filter(Boolean).join("  ");
    const debug = this.status.debug ?? "";
    // Rien n'a changé depuis le dernier dessin : ni redessin, ni envoi de la texture au GPU
    // (1024 × 220 px, mipmaps comprises) — le cas le plus courant entre deux secondes du compteur.
    const signature = `${blink}|${clock}|${battery}|${energyLevel.toFixed(3)}|${healthLevel.toFixed(3)}|${madnessLevel.toFixed(3)}|${depth}|${bag}|${signalText}|${flags}|${debug}`;
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

    if (debug) {
      ctx.font = "bold 21px monospace";
      this.text(debug, 20, 185, "left", "#9dff9d");
    }

    this.texture.needsUpdate = true;
  }
}

function drawVerticalBar(ctx: CanvasRenderingContext2D, x: number, label: string, value: number, color: string): void {
  const top = 34;
  const height = 178;
  const width = 30;
  ctx.font = "bold 22px monospace";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
  ctx.strokeText(label, x, 25);
  ctx.fillStyle = "#f4f1e8";
  ctx.fillText(label, x, 25);
  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(x - width / 2, top, width, height);
  ctx.fillStyle = color;
  const fillHeight = Math.max(0, height * value - 6);
  ctx.fillRect(x - width / 2 + 3, top + height - fillHeight - 3, width - 6, fillHeight);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(244, 241, 232, 0.8)";
  ctx.strokeRect(x - width / 2 - 1, top - 1, width + 2, height + 2);
}
