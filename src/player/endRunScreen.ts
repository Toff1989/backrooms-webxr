import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { generatePseudoSuggestion, PSEUDO_ADJECTIVE_COUNT, PSEUDO_NOUN_COUNT } from "../shared/pseudoGenerator";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import type { LeaderboardEntry } from "../world/runSession";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.56;
const HEIGHT = 0.38;
const PX_PER_M = 1830;
const DISTANCE = 0.75;
const LEADERBOARD_ROWS = 7;

type Phase = "review" | "submitting" | "result" | "error";
type ButtonId = "adjective" | "noun" | "submit" | "restart" | "mainMenu";
export type GameOverReason = "health" | "caught" | "victory";

const BUTTONS: Record<ButtonId, Rect> = {
  adjective: { x: 60, y: 330, w: 420, h: 70 },
  noun: { x: 545, y: 330, w: 420, h: 70 },
  submit: { x: 212, y: 440, w: 600, h: 84 },
  restart: { x: 212, y: 580, w: 320, h: 76 },
  mainMenu: { x: 550, y: 580, w: 320, h: 76 },
};

/**
 * Écran de fin de run (fiche projet étape 7 : "saisie du pseudo → envoi du score au
 * classement"). Pas de clavier virtuel : le pseudo se compose en faisant défiler un
 * adjectif et un nom au pointeur (gâchette), puis on l'envoie ; A valide aussi.
 *
 * Une seule voie d'entrée pour tout, qu'on arrête soi-même la prise (STOP REC) ou qu'on soit
 * rattrapé/vidé de santé (`showGameOver`) : dans les deux cas on compose un pseudo et on envoie
 * le score au classement — auparavant un game over sautait droit à "recommencer" sans jamais
 * pouvoir enregistrer son score.
 */
export class EndRunScreen extends UiPanel {
  private phase: Phase = "review";
  private depthReached = 0;
  private adjectiveIndex = 0;
  private nounIndex = 0;
  private suffix = 0;
  private leaderboard: LeaderboardEntry[] = [];
  private errorMessage = "";
  /** Pseudo réellement envoyé (repère fixe déjà connu, ou choisi cette fois) — affiché après
   * envoi ; distinct de `currentPseudo()` qui n'a de sens que pendant la phase "review". */
  private submittedPseudo = "";
  /** Non-null quand cet écran a été ouvert par un game over (affiche la raison au-dessus du reste). */
  private gameOverReason: GameOverReason | null = null;
  private readonly hovered = new Map<Hand, ButtonId | null>();

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly onConfirmPseudo: (pseudo: string) => Promise<{ leaderboard: LeaderboardEntry[] }>,
    private readonly onStartNewRun: () => void,
    private readonly onGoToMainMenu: () => void,
    /** Pseudo déjà choisi lors d'une fin de run précédente (ou null la première fois) : on
     * saute alors directement à l'envoi, sans repasser par le choix d'adjectif/nom. */
    private readonly getKnownPseudo: () => string | null,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "end-run-screen";
    parent.add(this.group);
    onLanguageChange(() => this.invalidate());
  }

  /** Fin volontaire (STOP REC) : pas de raison de game over affichée. */
  show(depthReached: number): void {
    this.gameOverReason = null;
    this.open(depthReached);
  }

  /** Fin forcée (santé à 0, rattrapé) : même écran, avec la raison affichée en plus. */
  showGameOver(depthReached: number, reason: GameOverReason): void {
    this.gameOverReason = reason;
    this.open(depthReached);
  }

  private open(depthReached: number): void {
    this.depthReached = depthReached;
    this.errorMessage = "";
    // Toujours repositionné devant la tête au moment de l'appel (pas une seule fois pour toute
    // la session) : sans ça, le panneau reste où il a été placé la première fois — potentiellement
    // loin derrière le joueur après qu'il a marché — et "recommencer" semble ne rien faire alors
    // qu'il suffit de se retourner pour le voir.
    this.place();
    this.group.visible = true;
    const known = this.getKnownPseudo();
    if (known) {
      this.confirmPseudo(known);
    } else {
      this.adjectiveIndex = Math.floor(Math.random() * PSEUDO_ADJECTIVE_COUNT);
      this.nounIndex = Math.floor(Math.random() * PSEUDO_NOUN_COUNT);
      this.suffix = Math.floor(Math.random() * 10000);
      this.phase = "review";
      this.invalidate();
    }
  }

  private place(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.05, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
  }

  /** Raccourci : A (main droite) valide / relance. */
  update(hands: Hand[]): void {
    if (!this.visible) return;
    for (const hand of hands) {
      if (hand.input.handedness !== "right" || !hand.input.primary.justPressed) continue;
      if (this.phase === "review") this.submit();
      else if (this.phase === "result" || this.phase === "error") this.restart();
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
    if (id === "adjective") this.adjectiveIndex += 1;
    else if (id === "noun") this.nounIndex += 1;
    else if (id === "submit") this.submit();
    else if (id === "restart") this.restart();
    else if (id === "mainMenu") this.goToMainMenu();
    this.invalidate();
    return true;
  }

  private buttonAt(px: number, py: number): ButtonId | null {
    const visible: ButtonId[] = this.phase === "review" ? ["adjective", "noun", "submit"] : this.phase === "submitting" ? [] : ["restart", "mainMenu"];
    return visible.find((id) => inRect(BUTTONS[id], px, py)) ?? null;
  }

  private currentPseudo(): string {
    return generatePseudoSuggestion(this.adjectiveIndex, this.nounIndex, this.suffix);
  }

  private submit(): void {
    if (this.phase !== "review") return;
    this.confirmPseudo(this.currentPseudo());
  }

  private confirmPseudo(pseudo: string): void {
    this.submittedPseudo = pseudo;
    this.phase = "submitting";
    this.invalidate();
    this.onConfirmPseudo(pseudo)
      .then(({ leaderboard }) => {
        this.leaderboard = leaderboard;
        this.phase = "result";
        this.invalidate();
      })
      .catch(() => {
        this.errorMessage = t("end.error");
        this.phase = "error";
        this.invalidate();
      });
  }

  private restart(): void {
    this.group.visible = false;
    this.onStartNewRun();
  }

  private goToMainMenu(): void {
    this.group.visible = false;
    this.onGoToMainMenu();
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    const width = this.canvas.width;
    drawPanelBackground(ctx, width, this.canvas.height);
    const hovered = new Set(this.hovered.values());

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff6b5a";
    ctx.font = "bold 40px monospace";
    ctx.fillText(t("end.title"), width / 2, 60);
    ctx.fillStyle = "#f2e8cf";
    ctx.font = "30px monospace";
    ctx.fillText(t("end.depth", { depth: this.depthReached }), width / 2, 116);
    if (this.gameOverReason) {
      const reasonKey = this.gameOverReason === "caught" ? "end.caught" : this.gameOverReason === "victory" ? "end.victory" : "end.healthEmpty";
      ctx.font = "24px monospace";
      ctx.fillStyle = this.gameOverReason === "victory" ? "#9fe39f" : "#e06a5a";
      ctx.fillText(t(reasonKey), width / 2, 150);
    }

    if (this.phase === "review") {
      ctx.font = "22px monospace";
      ctx.fillStyle = "#a79d86";
      ctx.fillText(t("end.prompt"), width / 2, this.gameOverReason ? 200 : 180);
      ctx.font = "bold 40px monospace";
      ctx.fillStyle = "#ffe89a";
      ctx.fillText(this.currentPseudo(), width / 2, 260);
      drawButton(ctx, BUTTONS.adjective, t("end.adjective"), { hovered: hovered.has("adjective") });
      drawButton(ctx, BUTTONS.noun, t("end.noun"), { hovered: hovered.has("noun") });
      drawButton(ctx, BUTTONS.submit, t("end.submit"), { hovered: hovered.has("submit"), accent: "#9fe39f" });
    } else if (this.phase === "submitting") {
      ctx.font = "30px monospace";
      ctx.fillStyle = "#cfc5ad";
      ctx.fillText(t("end.sending"), width / 2, 300);
    } else if (this.phase === "error") {
      ctx.font = "26px monospace";
      ctx.fillStyle = "#e06a5a";
      ctx.textAlign = "left";
      wrapText(ctx, this.errorMessage, 80, 260, width - 160, 32, 3);
      ctx.textAlign = "center";
      drawButton(ctx, BUTTONS.restart, t("end.restart"), { hovered: hovered.has("restart") });
      drawButton(ctx, BUTTONS.mainMenu, t("end.mainMenu"), { hovered: hovered.has("mainMenu") });
    } else {
      ctx.font = "bold 26px monospace";
      ctx.fillStyle = "#9fe39f";
      ctx.fillText(t("end.sent", { pseudo: this.submittedPseudo }), width / 2, 170);
      ctx.textAlign = "left";
      ctx.font = "24px monospace";
      this.leaderboard.slice(0, LEADERBOARD_ROWS).forEach((entry, index) => {
        const y = 222 + index * 46;
        ctx.fillStyle = index === 0 ? "#ffe89a" : "#e2d8bf";
        ctx.fillText(`${String(index + 1).padStart(2, "0")}. ${entry.pseudo}`, 120, y);
        ctx.fillStyle = "#a79d86";
        ctx.textAlign = "right";
        ctx.fillText(t("end.levelShort", { n: entry.depth }), width - 120, y);
        ctx.textAlign = "left";
      });
      if (this.leaderboard.length === 0) {
        ctx.fillStyle = "#a79d86";
        ctx.fillText(t("end.empty"), 120, 240);
      }
      ctx.textAlign = "center";
      drawButton(ctx, BUTTONS.restart, t("end.restart"), { hovered: hovered.has("restart") });
      drawButton(ctx, BUTTONS.mainMenu, t("end.mainMenu"), { hovered: hovered.has("mainMenu") });
    }
  }
}
