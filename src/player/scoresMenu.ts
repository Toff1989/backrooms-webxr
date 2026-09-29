import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { drawButton, drawPanelBackground, fitFont, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import type { LoreJournal } from "../world/loreJournal";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.5;
const HEIGHT = 0.5;
const PX_PER_M = 1600;
const DISTANCE = 0.72;
const CANVAS_W = Math.round(WIDTH * PX_PER_M);

const BACK_BUTTON: Rect = { x: 100, y: 690, w: 600, h: 70 };

export class ScoresMenu extends UiPanel {
  private readonly hovered = new Map<Hand, boolean>();

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly lore: LoreJournal,
    private readonly sfx: Sfx,
    private readonly onBack: () => void,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "scores-menu";
    parent.add(this.group);
    onLanguageChange(() => this.invalidate());
    lore.onChange(() => this.invalidate());
  }

  open(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.04, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    this.group.visible = true;
    this.invalidate();
    void this.lore.sync();
  }

  close(): void {
    this.group.visible = false;
  }

  onHover(hand: Hand, px: number | null, py: number | null): void {
    const hovered = px !== null && py !== null && inRect(BACK_BUTTON, px, py);
    if (this.hovered.get(hand) === hovered) return;
    if (hovered) hand.pulse(0.08, 10);
    this.hovered.set(hand, hovered);
    this.invalidate();
  }

  onPress(_hand: Hand, px: number, py: number, button: PressButton): boolean {
    if (button !== "trigger" || !inRect(BACK_BUTTON, px, py)) return true;
    this.sfx.play("click", 0.35);
    this.close();
    this.onBack();
    return true;
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    drawPanelBackground(ctx, CANVAS_W, this.canvas.height);
    const hovered = new Set(this.hovered.values());
    const runs = this.lore.serverProfile?.bestRuns ?? [];

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff6b5a";
    ctx.font = "bold 42px monospace";
    ctx.fillText(t("scores.title"), CANVAS_W / 2, 60);
    ctx.fillStyle = "#f2e8cf";
    ctx.font = "bold 26px monospace";
    ctx.fillText(t("scores.personal"), CANVAS_W / 2, 120);

    if (runs.length === 0) {
      ctx.fillStyle = "#a79d86";
      ctx.font = "22px monospace";
      ctx.fillText(this.lore.serverProfile ? t("scores.none") : t("scores.offline"), CANVAS_W / 2, 220);
    }

    runs.slice(0, 7).forEach((run, index) => {
      const y = 200 + index * 58;
      const level = t("end.levelShort", { n: run.depth });
      ctx.textAlign = "left";
      ctx.font = "24px monospace";
      const levelWidth = ctx.measureText(level).width;
      // Le pseudo (jusqu'à 40 caractères) rétrécit pour laisser sa place au niveau plutôt que de le recouvrir.
      const row = `${String(index + 1).padStart(2, "0")}. ${run.pseudo}`;
      fitFont(ctx, row, CANVAS_W - 180 - levelWidth - 24, 24, 16);
      ctx.fillStyle = index === 0 ? "#ffe89a" : "#e2d8bf";
      ctx.fillText(row, 90, y);
      ctx.font = "24px monospace";
      ctx.textAlign = "right";
      ctx.fillStyle = "#a79d86";
      ctx.fillText(level, CANVAS_W - 90, y);
    });

    drawButton(ctx, BACK_BUTTON, t("scores.back"), { hovered: hovered.has(true) });
  }
}
