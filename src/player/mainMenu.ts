import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { drawButton, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

// Même principe que le quad plein champ de VhsOverlay (écran bleu "NIV. X" entre deux niveaux) :
// un plan collé à la caméra qui couvre tout le champ de vision quel que soit le FOV (casque ou
// aperçu écran) — contrairement à un panneau de menu classique (inventaire, journal), posé dans
// le monde à distance fixe, qui laisse voir le chargement tout autour. Dimensionné pour couvrir
// large (jusqu'à ~100° verticaux, le plus large FOV casque courant) sans être démesuré au point
// que le contenu dessiné dessus finisse hors du champ visible réel (testé à 70° sur l'aperçu
// desktop) : à cette distance, un plan bien plus grand ne ferait que reculer tout le contenu vers
// le centre minuscule du canevas.
const SIZE = 2.2;
const PX_PER_M = 400;
const DEPTH = -0.9;

type ButtonId = "continue" | "newGame" | "settings" | "quit";

const CANVAS = SIZE * PX_PER_M;
const BUTTON_W = 600;
const BUTTON_H = 80;
const BUTTON_X = (CANVAS - BUTTON_W) / 2;
// Groupés serrés autour du centre du canevas : sur un FOV plus étroit (aperçu desktop, ~70°),
// seule une bande centrale du plan reste dans le champ — un dernier bouton posé trop bas
// disparaîtrait sous le bord de l'écran.
const BUTTONS: Record<ButtonId, Rect> = {
  continue: { x: BUTTON_X, y: 320, w: BUTTON_W, h: BUTTON_H },
  newGame: { x: BUTTON_X, y: 415, w: BUTTON_W, h: BUTTON_H },
  settings: { x: BUTTON_X, y: 510, w: BUTTON_W, h: BUTTON_H },
  quit: { x: BUTTON_X, y: 605, w: BUTTON_W, h: BUTTON_H },
};

export interface MainMenuActions {
  continueRun(): void;
  newGame(): void;
  openSettings(): void;
  quit(): void;
}

/**
 * Menu principal : le jeu charge toujours en arrière-plan (voir `main.ts`, `beginNewRun` au
 * chargement) — ce panneau plein champ, collé à la caméra, cache ce chargement en attendant que
 * le joueur choisisse (Continuer / Nouvelle partie / Paramètres / Quitter). Accessible au
 * lancement, et depuis l'inventaire en jeu ("Menu principal") sans mettre fin à la run en cours
 * (elle reste reprise par "Continuer").
 */
export class MainMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();

  constructor(
    camera: THREE.Camera,
    private readonly sfx: Sfx,
    private readonly actions: MainMenuActions,
  ) {
    super(SIZE, SIZE, PX_PER_M);
    this.group.name = "main-menu";
    this.group.position.set(0, 0, DEPTH);
    camera.add(this.group);
    // Au-dessus du HUD caméscope (renderOrder 997/998, lui aussi collé à la caméra) : sans ça,
    // "REC"/les jauges continuent de transpercer un menu censé tout masquer. depthTest désactivé
    // pour la même raison que le HUD et l'overlay VHS (mêmes réglages, mesh très proche de l'œil).
    this.mesh.renderOrder = 999;
    (this.mesh.material as THREE.MeshBasicMaterial).depthTest = false;
    onLanguageChange(() => this.invalidate());
  }

  open(): void {
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
    const height = this.canvas.height;
    // Fond plein, bord à bord (pas le cadre arrondi avec marge de drawPanelBackground) : ce
    // panneau doit masquer entièrement la scène derrière, comme l'écran bleu VHS.
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0c0a07";
    ctx.fillRect(0, 0, width, height);
    const hovered = new Set(this.hovered.values());

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff6b5a";
    ctx.font = "bold 48px monospace";
    ctx.fillText(t("menu.title"), width / 2, 240);

    drawButton(ctx, BUTTONS.continue, t("menu.continue"), { hovered: hovered.has("continue"), accent: "#9fe39f" });
    drawButton(ctx, BUTTONS.newGame, t("menu.newGame"), { hovered: hovered.has("newGame") });
    drawButton(ctx, BUTTONS.settings, t("menu.settings"), { hovered: hovered.has("settings") });
    drawButton(ctx, BUTTONS.quit, t("menu.quit"), { hovered: hovered.has("quit"), accent: "#e06a5a" });
  }
}
