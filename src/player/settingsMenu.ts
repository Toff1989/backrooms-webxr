import * as THREE from "three";
import { DEBUG_CODE_LENGTH, isDebugMenuEnabled, setDebugMenuEnabled, verifyDebugCode } from "../debug/debugLog";
import { getLanguage, onLanguageChange, setLanguage, t } from "../i18n";
import { generatePseudoSuggestion, PSEUDO_ADJECTIVE_COUNT, PSEUDO_NOUN_COUNT } from "../shared/pseudoGenerator";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import type { Difficulty } from "./difficulty";
import type { JumpscareLevel } from "./comfortSettings";
import type { VignetteLevel } from "./comfortVignette";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.5;
const HEIGHT = 0.5;
const PX_PER_M = 1600;
const DISTANCE = 0.7;

type ListButtonId = "lang" | "vignette" | "jumpscare" | "difficulty" | "height" | "pseudo" | "debug" | "reset" | "back";
type PseudoButtonId = "adjective" | "noun" | "confirm" | "cancel";
type ResetButtonId = "confirm" | "cancel";
type CodeButtonId = "cancel" | `key:${string}`;
type ButtonId = ListButtonId | PseudoButtonId | ResetButtonId | CodeButtonId;

const LIST_BUTTONS: Record<ListButtonId, Rect> = {
  lang: { x: 100, y: 120, w: 600, h: 54 },
  vignette: { x: 100, y: 182, w: 600, h: 54 },
  jumpscare: { x: 100, y: 244, w: 600, h: 54 },
  difficulty: { x: 100, y: 306, w: 600, h: 54 },
  height: { x: 100, y: 368, w: 600, h: 54 },
  pseudo: { x: 100, y: 430, w: 600, h: 54 },
  debug: { x: 100, y: 492, w: 600, h: 54 },
  reset: { x: 100, y: 554, w: 600, h: 54 },
  back: { x: 100, y: 640, w: 600, h: 58 },
};

const PSEUDO_BUTTONS: Record<PseudoButtonId, Rect> = {
  adjective: { x: 60, y: 290, w: 340, h: 68 },
  noun: { x: 420, y: 290, w: 340, h: 68 },
  confirm: { x: 100, y: 420, w: 600, h: 76 },
  cancel: { x: 100, y: 520, w: 600, h: 68 },
};

const RESET_BUTTONS: Record<ResetButtonId, Rect> = {
  confirm: { x: 100, y: 420, w: 600, h: 76 },
  cancel: { x: 100, y: 520, w: 600, h: 68 },
};

/** Pavé numérique de saisie du code debug : 3 colonnes × 4 lignes (⌫ 0 OK en bas). */
const CODE_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"] as const;
const CODE_KEY_RECTS = new Map<string, Rect>(
  CODE_KEYS.map((key, index) => [`key:${key}`, { x: 130 + (index % 3) * 190, y: 280 + Math.floor(index / 3) * 78, w: 170, h: 68 }]),
);
const CODE_CANCEL: Rect = { x: 100, y: 610, w: 600, h: 68 };

export interface SettingsMenuActions {
  recalibrateHeight(): void;
  vignetteLevel(): VignetteLevel;
  /** Passe au niveau de vignette suivant (désactivée, légère, normale, forte) et le renvoie. */
  cycleVignette(): VignetteLevel;
  difficulty(): Difficulty;
  /** Passe à la difficulté suivante (facile, normale, difficile) et la renvoie. */
  cycleDifficulty(): Difficulty;
  jumpscareLevel(): JumpscareLevel;
  /** Passe à l'intensité de sursaut suivante (normale, atténuée, désactivée) et la renvoie. */
  cycleJumpscare(): JumpscareLevel;
  /** Pseudo actuel (null si jamais choisi — pas encore soumis de score). */
  currentPseudo(): string | null;
  /** Choisit/change le pseudo persistant (voir playerIdentity.ts). */
  setPseudo(pseudo: string): Promise<string | null>;
  /**
   * Recommencer à zéro (archives, sauvegarde en cours, succès une fois ajoutés) — pas
   * l'identité/le pseudo/le code de cassette. Renvoie faux si le serveur était injoignable
   * (l'état local est quand même remis à zéro par l'appelant, voir main.ts).
   */
  resetProgress(): Promise<boolean>;
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
  private mode: "list" | "pseudo" | "resetConfirm" | "debugCode" = "list";
  private codeDigits = "";
  private verifying = false;
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
    this.codeDigits = "";
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
    else if (this.mode === "resetConfirm") this.pressResetButton(id as ResetButtonId);
    else if (this.mode === "debugCode") this.pressCodeButton(id as CodeButtonId);
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
        this.showStatus(t("settings.vignetteStatus", { level: t(`settings.vignette.${this.actions.cycleVignette()}`) }));
        break;
      case "jumpscare":
        this.showStatus(t("settings.jumpscareStatus", { level: t(`settings.jumpscare.${this.actions.cycleJumpscare()}`) }));
        break;
      case "difficulty":
        this.showStatus(t("settings.difficultyStatus", { level: t(`settings.difficulty.${this.actions.cycleDifficulty()}`) }));
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
        // Activer le menu debug demande le code ; le désactiver, non.
        if (isDebugMenuEnabled()) {
          setDebugMenuEnabled(false);
          this.showStatus(t("settings.debugOffStatus"));
        } else {
          this.codeDigits = "";
          this.mode = "debugCode";
        }
        break;
      case "reset":
        this.mode = "resetConfirm";
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
        this.actions
          .setPseudo(pseudo)
          .then((confirmed) => this.showStatus(confirmed ? t("settings.pseudoSet", { pseudo: confirmed }) : t("settings.pseudoFailed")))
          .catch(() => this.showStatus(t("settings.pseudoFailed")));
        break;
      }
    }
  }

  private pressCodeButton(id: CodeButtonId): void {
    if (this.verifying) return;
    if (id === "cancel") {
      this.mode = "list";
      return;
    }
    const key = id.slice("key:".length);
    if (key === "⌫") this.codeDigits = this.codeDigits.slice(0, -1);
    else if (key === "OK") this.submitCode();
    else if (this.codeDigits.length < DEBUG_CODE_LENGTH) {
      this.codeDigits += key;
      if (this.codeDigits.length === DEBUG_CODE_LENGTH) this.submitCode();
    }
  }

  private submitCode(): void {
    const code = this.codeDigits;
    this.verifying = true;
    verifyDebugCode(code)
      .then((ok) => {
        this.verifying = false;
        this.codeDigits = "";
        if (ok) {
          setDebugMenuEnabled(true);
          this.mode = "list";
          this.showStatus(t("settings.debugOnStatus"));
        } else {
          this.showStatus(t("settings.debugCodeWrong"));
        }
        this.invalidate();
      })
      .catch(() => {
        this.verifying = false;
        this.codeDigits = "";
        this.showStatus(t("settings.debugCodeWrong"));
        this.invalidate();
      });
  }

  private pressResetButton(id: ResetButtonId): void {
    if (id === "cancel") {
      this.mode = "list";
      return;
    }
    this.mode = "list";
    this.actions
      .resetProgress()
      .then((ok) => this.showStatus(ok ? t("settings.resetDone") : t("settings.resetOffline")))
      .catch(() => this.showStatus(t("settings.resetOffline")));
  }

  private pendingPseudo(): string {
    return generatePseudoSuggestion(this.adjectiveIndex, this.nounIndex, this.suffix);
  }

  private showStatus(message: string): void {
    this.statusMessage = message;
    this.statusUntil = this.time + 3;
  }

  private buttonAt(px: number, py: number): ButtonId | null {
    if (this.mode === "debugCode") {
      if (inRect(CODE_CANCEL, px, py)) return "cancel";
      for (const [id, rect] of CODE_KEY_RECTS) if (inRect(rect, px, py)) return id as CodeButtonId;
      return null;
    }
    const buttons: Record<string, Rect> = this.mode === "pseudo" ? PSEUDO_BUTTONS : this.mode === "resetConfirm" ? RESET_BUTTONS : LIST_BUTTONS;
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
    ctx.fillText(
      t(this.mode === "pseudo" ? "settings.pseudoTitle" : this.mode === "resetConfirm" ? "settings.resetTitle" : this.mode === "debugCode" ? "settings.debugCodeTitle" : "settings.title"),
      width / 2,
      90,
    );

    if (this.mode === "debugCode") {
      ctx.font = "22px monospace";
      ctx.fillStyle = "#b9ae93";
      ctx.fillText(t("settings.debugCodeHint"), width / 2, 150);
      // Les chiffres saisis restent masqués (•), les places libres sont des tirets.
      ctx.font = "bold 64px monospace";
      ctx.fillStyle = "#ffe89a";
      const masked = Array.from({ length: DEBUG_CODE_LENGTH }, (_, index) => (index < this.codeDigits.length ? "•" : "–")).join(" ");
      ctx.fillText(masked, width / 2, 215);
      for (const key of CODE_KEYS) drawButton(ctx, CODE_KEY_RECTS.get(`key:${key}`)!, key, { hovered: hovered.has(`key:${key}`), accent: key === "OK" ? "#9fe39f" : undefined });
      drawButton(ctx, CODE_CANCEL, t("settings.back"), { hovered: hovered.has("cancel") });
      if (this.statusUntil) {
        ctx.font = "22px monospace";
        ctx.fillStyle = "#e06a5a";
        ctx.fillText(this.statusMessage, width / 2, 728);
      }
      return;
    }

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

    if (this.mode === "resetConfirm") {
      ctx.font = "22px monospace";
      ctx.fillStyle = "#e2d8bf";
      ctx.textAlign = "left";
      wrapText(ctx, t("settings.resetWarning"), 60, 230, width - 120, 30, 4);
      ctx.textAlign = "center";
      drawButton(ctx, RESET_BUTTONS.confirm, t("settings.resetConfirm"), { hovered: hovered.has("confirm"), accent: "#e06a5a" });
      drawButton(ctx, RESET_BUTTONS.cancel, t("settings.back"), { hovered: hovered.has("cancel") });
      return;
    }

    drawButton(ctx, LIST_BUTTONS.lang, t("inv.lang"), { hovered: hovered.has("lang") });
    drawButton(ctx, LIST_BUTTONS.vignette, t("settings.vignette", { level: t(`settings.vignette.${this.actions.vignetteLevel()}`) }), { hovered: hovered.has("vignette") });
    drawButton(ctx, LIST_BUTTONS.jumpscare, t("settings.jumpscare", { level: t(`settings.jumpscare.${this.actions.jumpscareLevel()}`) }), { hovered: hovered.has("jumpscare") });
    drawButton(ctx, LIST_BUTTONS.difficulty, t("settings.difficulty", { level: t(`settings.difficulty.${this.actions.difficulty()}`) }), { hovered: hovered.has("difficulty") });
    drawButton(ctx, LIST_BUTTONS.height, t("inv.height"), { hovered: hovered.has("height") });
    const pseudo = this.actions.currentPseudo();
    drawButton(ctx, LIST_BUTTONS.pseudo, pseudo ? t("settings.pseudo", { pseudo }) : t("settings.pseudoNone"), { hovered: hovered.has("pseudo") });
    drawButton(ctx, LIST_BUTTONS.debug, isDebugMenuEnabled() ? t("settings.debugOn") : t("settings.debugOff"), {
      hovered: hovered.has("debug"),
      accent: "#7fc4e8",
    });
    drawButton(ctx, LIST_BUTTONS.reset, t("settings.reset"), { hovered: hovered.has("reset"), accent: "#e06a5a" });
    drawButton(ctx, LIST_BUTTONS.back, t("settings.back"), { hovered: hovered.has("back") });

    if (this.statusUntil) {
      ctx.font = "20px monospace";
      ctx.fillStyle = "#9fe39f";
      wrapText(ctx, this.statusMessage, width / 2, 738, width - 100, 24, 2);
    }
  }
}
