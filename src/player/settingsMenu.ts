import * as THREE from "three";
import { isDebugMenuEnabled, setDebugMenuEnabled } from "../debug/debugLog";
import { getLanguage, onLanguageChange, setLanguage, t } from "../i18n";
import { generatePseudoSuggestion, PSEUDO_ADJECTIVE_COUNT, PSEUDO_NOUN_COUNT } from "../shared/pseudoGenerator";
import { drawButton, drawPanelBackground, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import { setPseudo } from "../world/playerIdentity";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.5;
const HEIGHT = 0.5;
const PX_PER_M = 1600;
const DISTANCE = 0.7;

type ListButtonId = "lang" | "vignette" | "height" | "pseudo" | "debug" | "back";
type PseudoButtonId = "adjective" | "noun" | "confirm" | "cancel";
type ButtonId = ListButtonId | PseudoButtonId;

const LIST_BUTTONS: Record<ListButtonId, Rect> = {
  lang: { x: 100, y: 170, w: 600, h: 70 },
  vignette: { x: 100, y: 252, w: 600, h: 70 },
  height: { x: 100, y: 334, w: 600, h: 70 },
  pseudo: { x: 100, y: 416, w: 600, h: 70 },
  debug: { x: 100, y: 498, w: 600, h: 70 },
  back: { x: 100, y: 610, w: 600, h: 70 },
};

const PSEUDO_BUTTONS: Record<PseudoButtonId, Rect> = {
  adjective: { x: 60, y: 290, w: 340, h: 68 },
  noun: { x: 420, y: 290, w: 340, h: 68 },
  confirm: { x: 100, y: 420, w: 600, h: 76 },
  cancel: { x: 100, y: 520, w: 600, h: 68 },
};

export interface SettingsMenuActions {
  recalibrateHeight(): void;
  vignetteEnabled(): boolean;
  toggleVignette(): boolean;
  /** Pseudo actuel (null si jamais choisi — pas encore soumis de score). */
  currentPseudo(): string | null;
  /** Retour à l'écran qui a ouvert les paramètres (toujours le menu principal, voir mainMenu.ts). */
  back(): void;
}

/**
 * Paramètres et options de jeu, tous rassemblés ici (langue, vignette de confort, recalage de
 * hauteur, pseudo, et le mode debug) plutôt qu'éparpillés dans l'inventaire — accessible depuis
 * le menu principal, et depuis l'inventaire en jeu (raccourci direct, retour au menu principal
 * ensuite).
 */
export class SettingsMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();
  private statusMessage = "";
  private statusUntil = 0;
  private time = 0;
  private mode: "list" | "pseudo" = "list";
  private adjectiveIndex = 0;
  private nounIndex = 0;
  private suffix = 0;

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
    this.mode = "list";
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
    if (this.mode === "pseudo") this.pressPseudoButton(id as PseudoButtonId);
    else this.pressListButton(id as ListButtonId);
    this.invalidate();
    return true;
  }

  private pressListButton(id: ListButtonId): void {
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
      case "pseudo":
        this.adjectiveIndex = Math.floor(Math.random() * PSEUDO_ADJECTIVE_COUNT);
        this.nounIndex = Math.floor(Math.random() * PSEUDO_NOUN_COUNT);
        this.suffix = Math.floor(Math.random() * 10000);
        this.mode = "pseudo";
        break;
      case "debug":
        setDebugMenuEnabled(!isDebugMenuEnabled());
        this.showStatus(isDebugMenuEnabled() ? t("settings.debugOnStatus") : t("settings.debugOffStatus"));
        break;
      case "back":
        this.close();
        this.actions.back();
        break;
    }
  }

  private pressPseudoButton(id: PseudoButtonId): void {
    switch (id) {
      case "adjective":
        this.adjectiveIndex += 1;
        break;
      case "noun":
        this.nounIndex += 1;
        break;
      case "cancel":
        this.mode = "list";
        break;
      case "confirm": {
        const pseudo = this.pendingPseudo();
        this.mode = "list";
        setPseudo(pseudo)
          .then((confirmed) => this.showStatus(confirmed ? t("settings.pseudoSet", { pseudo: confirmed }) : t("settings.pseudoFailed")))
          .catch(() => this.showStatus(t("settings.pseudoFailed")));
        break;
      }
    }
  }

  private pendingPseudo(): string {
    return generatePseudoSuggestion(this.adjectiveIndex, this.nounIndex, this.suffix);
  }

  private showStatus(message: string): void {
    this.statusMessage = message;
    this.statusUntil = this.time + 3;
  }

  private buttonAt(px: number, py: number): ButtonId | null {
    const buttons: Record<string, Rect> = this.mode === "pseudo" ? PSEUDO_BUTTONS : LIST_BUTTONS;
    for (const [id, rect] of Object.entries(buttons)) if (inRect(rect, px, py)) return id as ButtonId;
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
    ctx.fillText(t(this.mode === "pseudo" ? "settings.pseudoTitle" : "settings.title"), width / 2, 90);

    if (this.mode === "pseudo") {
      ctx.font = "bold 36px monospace";
      ctx.fillStyle = "#ffe89a";
      ctx.fillText(this.pendingPseudo(), width / 2, 210);
      drawButton(ctx, PSEUDO_BUTTONS.adjective, t("end.adjective"), { hovered: hovered.has("adjective") });
      drawButton(ctx, PSEUDO_BUTTONS.noun, t("end.noun"), { hovered: hovered.has("noun") });
      drawButton(ctx, PSEUDO_BUTTONS.confirm, t("settings.pseudoConfirm"), { hovered: hovered.has("confirm"), accent: "#9fe39f" });
      drawButton(ctx, PSEUDO_BUTTONS.cancel, t("settings.back"), { hovered: hovered.has("cancel") });
      return;
    }

    drawButton(ctx, LIST_BUTTONS.lang, t("inv.lang"), { hovered: hovered.has("lang") });
    drawButton(ctx, LIST_BUTTONS.vignette, this.actions.vignetteEnabled() ? t("inv.vignetteOn") : t("inv.vignetteOff"), { hovered: hovered.has("vignette") });
    drawButton(ctx, LIST_BUTTONS.height, t("inv.height"), { hovered: hovered.has("height") });
    const pseudo = this.actions.currentPseudo();
    drawButton(ctx, LIST_BUTTONS.pseudo, pseudo ? t("settings.pseudo", { pseudo }) : t("settings.pseudoNone"), { hovered: hovered.has("pseudo") });
    drawButton(ctx, LIST_BUTTONS.debug, isDebugMenuEnabled() ? t("settings.debugOn") : t("settings.debugOff"), {
      hovered: hovered.has("debug"),
      accent: "#7fc4e8",
    });
    drawButton(ctx, LIST_BUTTONS.back, t("settings.back"), { hovered: hovered.has("back") });

    if (this.statusUntil) {
      ctx.font = "20px monospace";
      ctx.fillStyle = "#9fe39f";
      ctx.fillText(this.statusMessage, width / 2, 700);
    }
  }
}
