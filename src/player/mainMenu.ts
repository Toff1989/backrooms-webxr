import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { drawButton, drawPanelBackground, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.6;
const HEIGHT = 0.62;
const PX_PER_M = 1500;
const DISTANCE = 0.75;
const QUIT_CONFIRM_SECONDS = 3;

type ButtonId = "continue" | "newGame" | "settings" | "achievements" | "quit";

const CANVAS_W = WIDTH * PX_PER_M;
const BUTTON_W = 700;
const BUTTON_H = 90;
const BUTTON_X = (CANVAS_W - BUTTON_W) / 2;
const BUTTONS: Record<ButtonId, Rect> = {
  continue: { x: BUTTON_X, y: 260, w: BUTTON_W, h: BUTTON_H },
  newGame: { x: BUTTON_X, y: 370, w: BUTTON_W, h: BUTTON_H },
  settings: { x: BUTTON_X, y: 480, w: BUTTON_W, h: BUTTON_H },
  achievements: { x: BUTTON_X, y: 590, w: BUTTON_W, h: BUTTON_H },
  quit: { x: BUTTON_X, y: 700, w: BUTTON_W, h: BUTTON_H },
};

export interface MainMenuActions {
  continueRun(): void;
  newGame(): void;
  openSettings(): void;
  openAchievements(): void;
  /** "Quitter" : termine la run en cours (ex-STOP REC de l'inventaire), si une run est en pause. */
  quit(): void;
}

/**
 * Menu principal : un panneau classique (comme l'inventaire/le journal), jamais un overlay
 * plein champ — il n'est affiché que dans le niveau 0 fictif du menu (voir `main.ts`,
 * `enterMenuLimbo`), où le joueur est figé et rien d'autre n'est interactif.
 */
export class MainMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();
  private quitArmedUntil = 0;
  private time = 0;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly worldParent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly actions: MainMenuActions,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "main-menu";
    onLanguageChange(() => this.invalidate());
  }

  open(): void {
    this.worldParent.add(this.group);
    this.placeInFrontOfHead();
    this.quitArmedUntil = 0;
    this.group.visible = true;
    this.invalidate();
  }

  close(): void {
    this.group.visible = false;
  }

  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    if (this.quitArmedUntil && this.time > this.quitArmedUntil) {
      this.quitArmedUntil = 0;
      this.invalidate();
    }
  }

  private placeInFrontOfHead(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.05, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
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
    if (id === "continue") this.actions.continueRun();
    else if (id === "newGame") this.actions.newGame();
    else if (id === "settings") this.actions.openSettings();
    else if (id === "achievements") this.actions.openAchievements();
    else if (id === "quit") {
      // Termine la run en cours (score/pseudo, voir endRunScreen) : une confirmation évite un
      // appui accidentel qui couperait la partie en cours.
      if (this.quitArmedUntil) {
        this.quitArmedUntil = 0;
        this.actions.quit();
      } else this.quitArmedUntil = this.time + QUIT_CONFIRM_SECONDS;
    }
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
    ctx.font = "bold 44px monospace";
    ctx.fillText(t("menu.title"), width / 2, 140);

    drawButton(ctx, BUTTONS.continue, t("menu.continue"), { hovered: hovered.has("continue"), accent: "#9fe39f" });
    drawButton(ctx, BUTTONS.newGame, t("menu.newGame"), { hovered: hovered.has("newGame") });
    drawButton(ctx, BUTTONS.settings, t("menu.settings"), { hovered: hovered.has("settings") });
    drawButton(ctx, BUTTONS.achievements, t("menu.achievements"), { hovered: hovered.has("achievements") });
    drawButton(ctx, BUTTONS.quit, this.quitArmedUntil ? t("inv.confirm") : t("menu.quit"), { hovered: hovered.has("quit"), accent: "#e06a5a" });
  }
}
