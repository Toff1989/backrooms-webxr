import * as THREE from "three";
import { generatePseudoSuggestion, PSEUDO_ADJECTIVE_COUNT, PSEUDO_NOUN_COUNT } from "../shared/pseudoGenerator";
import type { LeaderboardEntry } from "../world/runSession";

const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 576;
const PANEL_WIDTH = 0.5;
const PANEL_HEIGHT = (CANVAS_HEIGHT / CANVAS_WIDTH) * PANEL_WIDTH;
const PANEL_POSITION = new THREE.Vector3(0, 0, -0.9);

/** Index du bouton de clic du thumbstick (voir `wristMenu.ts`). */
const STICK_CLICK_BUTTON_INDEX = 2;
const TRIGGER_BUTTON_INDEX = 0;
const LEADERBOARD_ROWS = 8;

type Phase = "hidden" | "review" | "submitting" | "result" | "error";

/**
 * Écran de fin de run (fiche projet étape 7 : "Fin de run : saisie du pseudo → envoi du
 * score au classement"). Pas de clavier virtuel : le pseudo est choisi parmi des
 * suggestions générées, qu'on fait défiler (clic thumbstick gauche/droit) puis qu'on
 * valide (gâchette droite) — cohérent avec l'absence de raycaster UI dans ce projet
 * (voir `wristMenu.ts`, même limitation). Panneau fixé à la tête, visible seulement une
 * fois affiché (`show`), pour ne jamais gêner l'exploration normale.
 */
export class EndRunScreen {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;

  private phase: Phase = "hidden";
  private depthReached = 0;
  private adjectiveIndex = 0;
  private nounIndex = 0;
  private suffix = 0;
  private leaderboard: LeaderboardEntry[] = [];
  private errorMessage = "";

  private leftStickButtonReady = true;
  private rightStickButtonReady = true;
  private triggerReady = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    private readonly onConfirmPseudo: (pseudo: string) => Promise<{ leaderboard: LeaderboardEntry[] }>,
    private readonly onStartNewRun: () => void,
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Contexte 2D indisponible pour l'écran de fin de run");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), material);
    this.mesh.position.copy(PANEL_POSITION);
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    camera.add(this.mesh);
  }

  get isVisible(): boolean {
    return this.phase !== "hidden";
  }

  /** "STOP REC" confirmé (voir `StopRecControl`) : ouvre l'écran sur une suggestion de pseudo. */
  show(depthReached: number): void {
    this.depthReached = depthReached;
    this.adjectiveIndex = Math.floor(Math.random() * PSEUDO_ADJECTIVE_COUNT);
    this.nounIndex = Math.floor(Math.random() * PSEUDO_NOUN_COUNT);
    this.suffix = Math.floor(Math.random() * 10000);
    this.phase = "review";
    this.mesh.visible = true;
    this.redraw();
  }

  update(): void {
    if (this.phase === "hidden") return;

    const session = this.renderer.xr.getSession();
    if (!session) return;

    let leftStickPressed = false;
    let rightStickPressed = false;
    let triggerPressed = false;
    for (const source of session.inputSources) {
      const buttons = source.gamepad?.buttons;
      if (!buttons) continue;
      if (source.handedness === "left") leftStickPressed = buttons[STICK_CLICK_BUTTON_INDEX]?.pressed ?? false;
      else if (source.handedness === "right") {
        rightStickPressed = buttons[STICK_CLICK_BUTTON_INDEX]?.pressed ?? false;
        triggerPressed = buttons[TRIGGER_BUTTON_INDEX]?.pressed ?? false;
      }
    }

    if (this.phase === "review") {
      if (leftStickPressed && this.leftStickButtonReady) {
        this.leftStickButtonReady = false;
        this.adjectiveIndex += 1;
        this.redraw();
      } else if (!leftStickPressed) this.leftStickButtonReady = true;

      if (rightStickPressed && this.rightStickButtonReady) {
        this.rightStickButtonReady = false;
        this.nounIndex += 1;
        this.redraw();
      } else if (!rightStickPressed) this.rightStickButtonReady = true;

      if (triggerPressed && this.triggerReady) {
        this.triggerReady = false;
        this.confirmPseudo();
      } else if (!triggerPressed) this.triggerReady = true;
      return;
    }

    if (this.phase === "result" || this.phase === "error") {
      if (triggerPressed && this.triggerReady) {
        this.triggerReady = false;
        this.hide();
        this.onStartNewRun();
      } else if (!triggerPressed) this.triggerReady = true;
    }
  }

  private hide(): void {
    this.phase = "hidden";
    this.mesh.visible = false;
  }

  private currentPseudo(): string {
    return generatePseudoSuggestion(this.adjectiveIndex, this.nounIndex, this.suffix);
  }

  private confirmPseudo(): void {
    this.phase = "submitting";
    this.redraw();
    this.onConfirmPseudo(this.currentPseudo())
      .then(({ leaderboard }) => {
        this.leaderboard = leaderboard;
        this.phase = "result";
        this.redraw();
      })
      .catch(() => {
        this.errorMessage = "Envoi impossible — score gardé en local uniquement.";
        this.phase = "error";
        this.redraw();
      });
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.fillStyle = "rgba(6, 5, 4, 0.92)";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.strokeStyle = "rgba(255, 242, 176, 0.3)";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_WIDTH - 4, CANVAS_HEIGHT - 4);

    ctx.textBaseline = "top";
    ctx.fillStyle = "#f2f2f2";
    ctx.font = "bold 30px monospace";
    ctx.fillText("FIN DE L'ENREGISTREMENT", 24, 24);

    ctx.font = "20px monospace";
    ctx.fillStyle = "#cfcfcf";
    ctx.fillText(`Profondeur atteinte : ${this.depthReached}`, 24, 68);

    if (this.phase === "review") {
      ctx.font = "16px monospace";
      ctx.fillStyle = "#8a8a8a";
      ctx.fillText("Pseudo suggéré :", 24, 120);
      ctx.font = "bold 26px monospace";
      ctx.fillStyle = "#ffe89a";
      ctx.fillText(this.currentPseudo(), 24, 150);

      ctx.font = "15px monospace";
      ctx.fillStyle = "#8a8a8a";
      ctx.fillText("Stick gauche (clic) : mot précédent    Stick droit (clic) : mot suivant", 24, 200);
      ctx.fillText("Gâchette droite : valider et envoyer au classement", 24, 224);
    } else if (this.phase === "submitting") {
      ctx.font = "20px monospace";
      ctx.fillStyle = "#cfcfcf";
      ctx.fillText("Envoi au classement…", 24, 130);
    } else if (this.phase === "error") {
      ctx.font = "18px monospace";
      ctx.fillStyle = "#e06a5a";
      wrapText(ctx, this.errorMessage, 24, 130, CANVAS_WIDTH - 48, 24);
      ctx.font = "15px monospace";
      ctx.fillStyle = "#8a8a8a";
      ctx.fillText("Gâchette droite : nouvelle run", 24, 190);
    } else if (this.phase === "result") {
      ctx.font = "bold 20px monospace";
      ctx.fillStyle = "#7fe87f";
      ctx.fillText(`Score envoyé : ${this.currentPseudo()}`, 24, 100);

      ctx.font = "16px monospace";
      ctx.fillStyle = "#a8a8a8";
      ctx.fillText("CLASSEMENT", 24, 140);

      let y = 168;
      const rows = this.leaderboard.slice(0, LEADERBOARD_ROWS);
      if (rows.length === 0) {
        ctx.fillStyle = "#8a8a8a";
        ctx.fillText("Aucune entrée pour l'instant.", 24, y);
      }
      rows.forEach((entry, index) => {
        ctx.fillStyle = index === 0 ? "#ffe89a" : "#cfcfcf";
        ctx.font = "16px monospace";
        ctx.fillText(`${(index + 1).toString().padStart(2, "0")}. ${entry.pseudo}`, 24, y);
        ctx.fillStyle = "#8a8a8a";
        ctx.fillText(`Niv. ${entry.depth}`, CANVAS_WIDTH - 120, y);
        y += 26;
      });

      ctx.font = "15px monospace";
      ctx.fillStyle = "#8a8a8a";
      ctx.fillText("Gâchette droite : nouvelle run", 24, CANVAS_HEIGHT - 32);
    }

    this.texture.needsUpdate = true;
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number): void {
  const words = text.split(" ");
  let line = "";
  let cursorY = y;
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}
