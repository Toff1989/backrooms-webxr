import * as THREE from "three";
import { onLanguageChange, t, type TranslationKey } from "../i18n";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import type { CameraTracker, TrackMode } from "./cameraTracker";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.56;
const HEIGHT = 0.46;
const PX_PER_M = 1600;
const DISTANCE = 0.66;

type ButtonId = TrackMode | "back";

const BUTTONS: Record<ButtonId, Rect> = {
  exit: { x: 70, y: 180, w: 756, h: 66 },
  cadreur: { x: 70, y: 302, w: 756, h: 66 },
  archive: { x: 70, y: 424, w: 756, h: 66 },
  back: { x: 250, y: 580, w: 396, h: 76 },
};

const LABEL_KEYS: Record<TrackMode, TranslationKey> = { exit: "camera.exit", cadreur: "camera.cadreur", archive: "camera.archive" };
const DESC_KEYS: Record<TrackMode, TranslationKey> = { exit: "camera.exitDesc", cadreur: "camera.cadreurDesc", archive: "camera.archiveDesc" };
const ACCENTS: Record<TrackMode, string> = { exit: "#9fe39f", cadreur: "#ff6b5a", archive: "#e8c34a" };

/** Menu du caméscope : choix de ce que traque le signal (sortie, Cadreur, archive perdue la plus proche). */
export class CameraMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly tracker: CameraTracker,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "camera-menu";
    parent.add(this.group);
    onLanguageChange(() => this.invalidate());
  }

  open(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.03, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    this.group.visible = true;
    this.invalidate();
  }

  close(): void {
    this.group.visible = false;
  }

  /** Le mode a changé ailleurs (raccourci manette) : le panneau ouvert se met à jour. */
  refreshMode(): void {
    this.invalidate();
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
    if (id === "back") this.close();
    else this.tracker.mode = id;
    this.invalidate();
    return true;
  }

  private buttonAt(px: number, py: number): ButtonId | null {
    for (const [id, rect] of Object.entries(BUTTONS) as Array<[ButtonId, Rect]>) if (inRect(rect, px, py)) return id;
    return null;
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    const width = this.canvas.width;
    drawPanelBackground(ctx, width, this.canvas.height);
    const hovered = new Set(this.hovered.values());
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff6b5a";
    ctx.font = "bold 38px monospace";
    ctx.fillText(t("camera.title"), width / 2, 70);
    ctx.font = "20px monospace";
    ctx.fillStyle = "#b9ae93";
    wrapText(ctx, t("camera.hint"), width / 2, 120, width - 120, 26, 2);

    for (const mode of ["exit", "cadreur", "archive"] as const) {
      const rect = BUTTONS[mode];
      const active = this.tracker.mode === mode;
      drawButton(ctx, rect, `${active ? "● " : "○ "}${t(LABEL_KEYS[mode])}`, { hovered: hovered.has(mode), accent: active ? ACCENTS[mode] : undefined });
      // Description sous le bouton (jamais dessus : elle masquerait ou chevaucherait son libellé).
      ctx.font = "18px monospace";
      ctx.fillStyle = "#b9ae93";
      ctx.textAlign = "center";
      ctx.fillText(t(DESC_KEYS[mode]), rect.x + rect.w / 2, rect.y + rect.h + 24);
    }
    drawButton(ctx, BUTTONS.back, t("camera.back"), { hovered: hovered.has("back") });
  }
}
