import * as THREE from "three";
import { isDebugMenuEnabled, setDebugMenuEnabled } from "../debug/debugLog";
import { getLanguage, onLanguageChange, setLanguage, t } from "../i18n";
import { drawButton, drawPanelBackground, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.5;
const HEIGHT = 0.44;
const PX_PER_M = 1600;
const DISTANCE = 0.7;

type ButtonId = "lang" | "vignette" | "height" | "debug" | "back";

const BUTTONS: Record<ButtonId, Rect> = {
  lang: { x: 100, y: 180, w: 600, h: 76 },
  vignette: { x: 100, y: 270, w: 600, h: 76 },
  height: { x: 100, y: 360, w: 600, h: 76 },
  debug: { x: 100, y: 450, w: 600, h: 76 },
  back: { x: 100, y: 560, w: 600, h: 76 },
};

export interface SettingsMenuActions {
  recalibrateHeight(): void;
  vignetteEnabled(): boolean;
  toggleVignette(): boolean;
  /** Retour à l'écran qui a ouvert les paramètres (toujours le menu principal, voir mainMenu.ts). */
  back(): void;
}

/**
 * Paramètres et options de jeu, tous rassemblés ici (langue, vignette de confort, recalage de
 * hauteur, et le mode debug) plutôt qu'éparpillés dans l'inventaire — accessible depuis le menu
 * principal, et depuis l'inventaire en jeu (raccourci direct, retour au menu principal ensuite).
 */
export class SettingsMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();
  private statusMessage = "";
  private statusUntil = 0;
  private time = 0;

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly actions: SettingsMenuActions,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "settings-menu";
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
    if (button) hand.pulse(0.08, 10);
    this.hovered.set(hand, button);
    this.invalidate();
  }

  onPress(_hand: Hand, px: number, py: number, button: PressButton): boolean {
    if (button !== "trigger") return true;
    const id = this.buttonAt(px, py);
    if (!id) return true;
    this.sfx.play("click", 0.4);
    switch (id) {
      case "lang":
        setLanguage(getLanguage() === "fr" ? "en" : "fr");
        this.showStatus(t("inv.langStatus"));
        break;
      case "vignette":
        this.showStatus(this.actions.toggleVignette() ? t("inv.vignetteOnStatus") : t("inv.vignetteOffStatus"));
        break;
      case "height":
        this.actions.recalibrateHeight();
        this.showStatus(t("inv.heightStatus"));
        break;
      case "debug":
        setDebugMenuEnabled(!isDebugMenuEnabled());
        this.showStatus(isDebugMenuEnabled() ? t("settings.debugOnStatus") : t("settings.debugOffStatus"));
        break;
      case "back":
        this.close();
        this.actions.back();
        return true;
    }
    this.invalidate();
    return true;
  }

  private showStatus(message: string): void {
    this.statusMessage = message;
    this.statusUntil = this.time + 3;
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
    ctx.fillText(t("settings.title"), width / 2, 90);

    drawButton(ctx, BUTTONS.lang, t("inv.lang"), { hovered: hovered.has("lang") });
    drawButton(ctx, BUTTONS.vignette, this.actions.vignetteEnabled() ? t("inv.vignetteOn") : t("inv.vignetteOff"), { hovered: hovered.has("vignette") });
    drawButton(ctx, BUTTONS.height, t("inv.height"), { hovered: hovered.has("height") });
    drawButton(ctx, BUTTONS.debug, isDebugMenuEnabled() ? t("settings.debugOn") : t("settings.debugOff"), {
      hovered: hovered.has("debug"),
      accent: "#7fc4e8",
    });
    drawButton(ctx, BUTTONS.back, t("settings.back"), { hovered: hovered.has("back") });

    if (this.statusUntil) {
      ctx.font = "22px monospace";
      ctx.fillStyle = "#9fe39f";
      ctx.fillText(this.statusMessage, width / 2, 650);
    }
  }
}
