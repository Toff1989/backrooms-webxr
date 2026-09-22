import * as THREE from "three";

const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 140;
const UPDATE_INTERVAL_SECONDS = 0.5;
// Petit panneau tassé dans le coin bas-gauche du champ de vision (viseur caméscope),
// pas un bloc flottant au centre de la vue.
const PANEL_WIDTH = 0.22;
const PANEL_HEIGHT = (CANVAS_HEIGHT / CANVAS_WIDTH) * PANEL_WIDTH;
const PANEL_POSITION = new THREE.Vector3(-0.35, -0.3, -0.55);

interface BatteryLike {
  level: number;
}

/**
 * Overlay caméscope (panneau 3D fixé à la tête) : REC clignotant, horodatage de la run,
 * indicateur batterie, profondeur actuelle. La profondeur reste à 0 tant que les levels
 * (étape 4 de la roadmap) ne sont pas branchés ; `depth` est déjà exposé pour ça.
 */
export class CamcorderHud {
  depth = 0;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private elapsedSeconds = 0;
  private timeSinceRedraw = 0;
  private battery: BatteryLike | null = null;

  constructor(camera: THREE.Camera) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Contexte 2D indisponible pour le HUD caméscope");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(PANEL_POSITION);
    mesh.renderOrder = 997;
    mesh.frustumCulled = false;
    camera.add(mesh);

    this.redraw();
    this.tryInitBattery();
  }

  update(deltaSeconds: number): void {
    this.elapsedSeconds += deltaSeconds;
    this.timeSinceRedraw += deltaSeconds;
    if (this.timeSinceRedraw < UPDATE_INTERVAL_SECONDS) return;
    this.timeSinceRedraw = 0;
    this.redraw();
  }

  private tryInitBattery(): void {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    nav
      .getBattery?.()
      .then((battery) => {
        this.battery = battery;
      })
      .catch(() => {
        this.battery = null;
      });
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.font = "bold 34px monospace";
    ctx.textBaseline = "middle";

    const blink = Math.floor(this.elapsedSeconds) % 2 === 0;
    ctx.fillStyle = blink ? "#ff3b30" : "rgba(255, 59, 48, 0.35)";
    ctx.beginPath();
    ctx.arc(34, 40, 12, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f2f2f2";
    ctx.fillText("REC", 56, 42);

    const minutes = Math.floor(this.elapsedSeconds / 60)
      .toString()
      .padStart(2, "0");
    const seconds = Math.floor(this.elapsedSeconds % 60)
      .toString()
      .padStart(2, "0");
    ctx.fillText(`${minutes}:${seconds}`, 200, 42);

    const batteryLabel = this.battery ? `${Math.round(this.battery.level * 100)}%` : "--%";
    ctx.fillText(`BAT ${batteryLabel}`, 360, 42);

    ctx.font = "22px monospace";
    ctx.fillStyle = "#cfcfcf";
    ctx.fillText(`PROFONDEUR ${this.depth}`, 24, 96);

    this.texture.needsUpdate = true;
  }
}
