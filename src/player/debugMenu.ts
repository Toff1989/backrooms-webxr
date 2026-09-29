import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { drawButton, drawPanelBackground, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.56;
const HEIGHT = 0.4;
const PX_PER_M = 1700;
const DISTANCE = 0.6;

export interface DebugAction {
  label(): string;
  run(): string;
}

const CLOSE_RECT: Rect = { x: 40, y: 620, w: 872, h: 70 };

function actionRect(index: number, count: number): Rect {
  const gap = 12;
  const columns = 2;
  const rows = Math.ceil(count / columns);
  const w = (872 - gap * (columns - 1)) / columns;
  const h = (520 - gap * (rows - 1)) / Math.max(1, rows);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return { x: 40 + column * (w + gap), y: 100 + row * (h + gap), w, h };
}

/**
 * Menu debug in-game : fenêtre indépendante de l'inventaire (auparavant une rangée de boutons
 * bolted dedans), ouvrable depuis l'inventaire uniquement quand le mode debug est activé (voir
 * `settingsMenu.ts` / `debugLog.ts`). Regroupe les actions de test (menaces, niveau, batterie,
 * spawn d'objet) précédemment mélangées aux boutons normaux de l'inventaire.
 */
export class DebugMenu extends UiPanel {
  private readonly hovered = new Map<Hand, number | "close" | null>();
  private statusMessage = "";
  private statusUntil = 0;
  private time = 0;

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly actions: DebugAction[],
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "debug-menu";
    parent.add(this.group);
    onLanguageChange(() => this.invalidate());
  }

  open(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.02, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    this.group.visible = true;
    this.invalidate();
  }

  close(): void {
    this.group.visible = false;
  }

  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    if (this.statusUntil && this.time > this.statusUntil) {
      this.statusUntil = 0;
      this.invalidate();
    }
  }

  onHover(hand: Hand, px: number | null, py: number | null): void {
    const button = px === null || py === null ? null : this.buttonAt(px, py);
    if (this.hovered.get(hand) === button) return;
    if (button !== null) hand.pulse(0.08, 10);
    this.hovered.set(hand, button);
    this.invalidate();
  }

  onPress(_hand: Hand, px: number, py: number, button: PressButton): boolean {
    if (button !== "trigger") return true;
    const id = this.buttonAt(px, py);
    if (id === null) return true;
    this.sfx.play("click", 0.4);
    if (id === "close") this.close();
    else {
      const action = this.actions[id];
      if (action) {
        this.statusMessage = action.run();
        this.statusUntil = this.time + 3;
      }
    }
    this.invalidate();
    return true;
  }

  private buttonAt(px: number, py: number): number | "close" | null {
    if (inRect(CLOSE_RECT, px, py)) return "close";
    for (let i = 0; i < this.actions.length; i++) if (inRect(actionRect(i, this.actions.length), px, py)) return i;
    return null;
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    const width = this.canvas.width;
    drawPanelBackground(ctx, width, this.canvas.height);
    const hovered = new Set(this.hovered.values());

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#7fc4e8";
    ctx.font = "bold 34px monospace";
    ctx.fillText(t("debugMenu.title"), width / 2, 50);

    this.actions.forEach((action, i) => drawButton(ctx, actionRect(i, this.actions.length), action.label(), { hovered: hovered.has(i), accent: "#7fc4e8" }));
    drawButton(ctx, CLOSE_RECT, t("inv.close"), { hovered: hovered.has("close") });

    if (this.statusUntil) {
      ctx.font = "20px monospace";
      ctx.fillStyle = "#9fe39f";
      ctx.fillText(this.statusMessage, width / 2, 604);
    }
  }
}
