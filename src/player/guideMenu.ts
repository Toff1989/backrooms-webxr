import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.62;
const HEIGHT = 0.62;
const PX_PER_M = 1500;
const DISTANCE = 0.72;

type ButtonId = "previous" | "next" | "back";
type Page = "controls" | "systems" | "credits";

const PAGES: readonly Page[] = ["controls", "systems", "credits"];
const TITLE_KEYS = { controls: "guide.controlsTitle", systems: "guide.systemsTitle", credits: "guide.creditsTitle" } as const;

const BUTTONS: Record<ButtonId, Rect> = {
  previous: { x: 40, y: 820, w: 250, h: 66 },
  next: { x: 640, y: 820, w: 250, h: 66 },
  back: { x: 320, y: 820, w: 290, h: 66 },
};

const PAGE_LINES: Record<Page, string[]> = {
  controls: Array.from({ length: 8 }, (_, index) => `guide.controls.${index + 1}`),
  systems: Array.from({ length: 9 }, (_, index) => `guide.systems.${index + 1}`),
  credits: Array.from({ length: 5 }, (_, index) => `guide.credits.${index + 1}`),
};

export class GuideMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();
  private page: Page = "controls";

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly onBack: () => void,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "guide-menu";
    parent.add(this.group);
    onLanguageChange(() => this.invalidate());
  }

  open(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.04, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    this.page = "controls";
    this.group.visible = true;
    this.invalidate();
  }

  close(): void {
    this.group.visible = false;
  }

  onHover(hand: Hand, px: number | null, py: number | null): void {
    const button = px === null || py === null ? null : this.buttonAt(px, py);
    if (this.hovered.get(hand) === button) return;
    if (button) hand.pulse(0.08, 10);
    this.hovered.set(hand, button);
    this.invalidate();
  }

  onPress(_hand: Hand, px: number, py: number, button: PressButton): boolean {
    if (button !== "trigger") return true;
    const id = this.buttonAt(px, py);
    if (!id) return true;
    this.sfx.play("click", 0.4);
    if (id === "previous") this.page = PAGES[Math.max(0, PAGES.indexOf(this.page) - 1)]!;
    else if (id === "next") this.page = PAGES[Math.min(PAGES.length - 1, PAGES.indexOf(this.page) + 1)]!;
    else {
      this.close();
      this.onBack();
    }
    this.invalidate();
    return true;
  }

  private buttonAt(px: number, py: number): ButtonId | null {
    for (const [id, rect] of Object.entries(BUTTONS) as Array<[ButtonId, Rect]>) {
      if (inRect(rect, px, py)) return id;
    }
    return null;
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    const width = this.canvas.width;
    drawPanelBackground(ctx, width, this.canvas.height);
    const hovered = new Set(this.hovered.values());
    const index = PAGES.indexOf(this.page);
    const title = t(TITLE_KEYS[this.page]);
    const previousPage = PAGES[index - 1];
    const nextPage = PAGES[index + 1];

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff6b5a";
    ctx.font = "bold 42px monospace";
    ctx.fillText(t("guide.title"), width / 2, 54);
    ctx.fillStyle = "#f2e8cf";
    ctx.font = "bold 28px monospace";
    ctx.fillText(title, width / 2, 105);

    ctx.textAlign = "left";
    ctx.font = "22px monospace";
    ctx.fillStyle = "#d8cfb6";
    // Les paragraphes s'enchaînent selon leur hauteur réelle (1 à 3 lignes) au lieu d'un pas fixe.
    let y = 158;
    for (const key of PAGE_LINES[this.page]) {
      const lines = wrapText(ctx, t(key as Parameters<typeof t>[0]), 60, y, width - 120, 28, 3);
      y += lines * 28 + 20;
    }

    drawButton(ctx, BUTTONS.previous, previousPage ? `◀ ${t(TITLE_KEYS[previousPage])}` : "", { hovered: hovered.has("previous"), disabled: !previousPage });
    drawButton(ctx, BUTTONS.back, t("guide.back"), { hovered: hovered.has("back") });
    drawButton(ctx, BUTTONS.next, nextPage ? `${t(TITLE_KEYS[nextPage])} ▶` : "", { hovered: hovered.has("next"), disabled: !nextPage });
  }
}