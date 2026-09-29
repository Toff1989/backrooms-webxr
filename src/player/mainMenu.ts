import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { drawButton, drawPanelBackground, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.5;
const HEIGHT = 0.4;
const PX_PER_M = 1600;
const DISTANCE = 0.7;

type ButtonId = "continue" | "newGame" | "settings" | "quit";

const BUTTONS: Record<ButtonId, Rect> = {
  continue: { x: 100, y: 240, w: 600, h: 84 },
  newGame: { x: 100, y: 340, w: 600, h: 84 },
  settings: { x: 100, y: 440, w: 600, h: 84 },
  quit: { x: 100, y: 540, w: 600, h: 84 },
};

export interface MainMenuActions {
  continueRun(): void;
  newGame(): void;
  openSettings(): void;
  quit(): void;
}

/**
 * Menu principal : le jeu charge toujours en arrière-plan (voir `main.ts`, `beginNewRun` au
 * chargement) — ce panneau se contente de garder le joueur en pause devant, le temps de choisir.
 * Accessible au lancement, et depuis l'inventaire en jeu ("Menu principal") sans mettre fin à la
 * run en cours (elle reste reprise par "Continuer").
 */
export class MainMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly actions: MainMenuActions,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "main-menu";
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
    else if (id === "quit") this.actions.quit();
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
    drawButton(ctx, BUTTONS.quit, t("menu.quit"), { hovered: hovered.has("quit"), accent: "#e06a5a" });
  }
}
