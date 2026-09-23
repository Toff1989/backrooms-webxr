import * as THREE from "three";
import type { CollectionEntry, CollectionStore } from "../world/collection";
import type { ControllerRig } from "./controllerRig";

const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 640;
const PANEL_WIDTH = 0.16;
const PANEL_HEIGHT = (CANVAS_HEIGHT / CANVAS_WIDTH) * PANEL_WIDTH;
// Posé comme une montre sur le dessus du poignet gauche : visible seulement quand le
// joueur tourne la main vers lui, pas en permanence dans le champ de vision.
const PANEL_POSITION = new THREE.Vector3(0, 0.04, -0.06);
const PANEL_ROTATION_X = -Math.PI / 2.1;

const ITEMS_PER_PAGE = 4;
/** Index du bouton de clic du thumbstick (contrôleurs Touch/Quest : pas de pavé tactile,
 * donc le thumbstick occupe l'index 2, pas 3 comme dans le mapping "xr-standard" générique). */
const STICK_CLICK_BUTTON_INDEX = 2;

type SortMode = "depth" | "rarity";

const RARITY_ORDER: Record<CollectionEntry["rarity"], number> = { legendary: 0, rare: 1, common: 2 };
const RARITY_LABEL_FR: Record<CollectionEntry["rarity"], string> = { legendary: "Légendaire", rare: "Rare", common: "Commun" };
const RARITY_COLOR: Record<CollectionEntry["rarity"], string> = { legendary: "#e8c34a", rare: "#7fc4e8", common: "#9a9a9a" };

/**
 * Menu poignet (fiche projet étape 6) : consultation de la collection persistante,
 * triable par profondeur ou rareté, paginée. Suit la main gauche (voir `ControllerRig`)
 * une fois qu'elle est identifiée ; clic du thumbstick droit = page suivante, clic du
 * thumbstick gauche = changer de tri (les deux sticks sont déjà utilisés pour les axes
 * de locomotion, leur clic est libre).
 */
export class WristMenu {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;
  private sortMode: SortMode = "depth";
  private page = 0;
  private dirty = true;
  private pageButtonReady = true;
  private sortButtonReady = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly controllerRig: ControllerRig,
    private readonly collection: CollectionStore,
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Contexte 2D indisponible pour le menu poignet");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(PANEL_POSITION);
    this.mesh.rotation.x = PANEL_ROTATION_X;
    this.mesh.renderOrder = 998;
    this.mesh.frustumCulled = false;

    this.redraw();
  }

  /** À appeler après un ramassage : la liste a changé, le prochain redraw doit en tenir compte. */
  notifyCollectionChanged(): void {
    this.dirty = true;
  }

  /**
   * `inputEnabled=false` pendant que l'écran de fin de run est affiché (`EndRunScreen`) :
   * il réutilise les mêmes clics de thumbstick, il ne faut pas que les deux réagissent
   * au même appui en même temps.
   */
  update(inputEnabled: boolean): void {
    const left = this.controllerRig.left;
    if (left && this.mesh.parent !== left) left.add(this.mesh);

    if (inputEnabled) this.pollButtons();

    if (this.dirty) {
      this.redraw();
      this.dirty = false;
    }
  }

  private pollButtons(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    let rightPressed = false;
    let leftPressed = false;
    for (const source of session.inputSources) {
      const button = source.gamepad?.buttons[STICK_CLICK_BUTTON_INDEX];
      if (!button) continue;
      if (source.handedness === "right") rightPressed = button.pressed;
      else if (source.handedness === "left") leftPressed = button.pressed;
    }

    if (rightPressed && this.pageButtonReady) {
      this.pageButtonReady = false;
      this.page += 1;
      this.dirty = true;
    } else if (!rightPressed) {
      this.pageButtonReady = true;
    }

    if (leftPressed && this.sortButtonReady) {
      this.sortButtonReady = false;
      this.sortMode = this.sortMode === "depth" ? "rarity" : "depth";
      this.page = 0;
      this.dirty = true;
    } else if (!leftPressed) {
      this.sortButtonReady = true;
    }
  }

  private sortedEntries(): CollectionEntry[] {
    const entries = [...this.collection.getAll()];
    if (this.sortMode === "depth") {
      entries.sort((a, b) => b.depth - a.depth || b.collectedAt - a.collectedAt);
    } else {
      entries.sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity] || b.collectedAt - a.collectedAt);
    }
    return entries;
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = "rgba(8, 7, 5, 0.9)";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.strokeStyle = "rgba(255, 242, 176, 0.25)";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_WIDTH - 4, CANVAS_HEIGHT - 4);

    ctx.textBaseline = "top";
    ctx.fillStyle = "#f2f2f2";
    ctx.font = "bold 26px monospace";
    ctx.fillText("COLLECTION", 20, 18);

    const entries = this.sortedEntries();
    const totalPages = Math.max(1, Math.ceil(entries.length / ITEMS_PER_PAGE));
    this.page = ((this.page % totalPages) + totalPages) % totalPages;

    ctx.font = "18px monospace";
    ctx.fillStyle = "#cfcfcf";
    const sortLabel = this.sortMode === "depth" ? "Tri : profondeur" : "Tri : rareté";
    ctx.fillText(sortLabel, 20, 52);
    ctx.fillText(`${entries.length} objet(s) — page ${this.page + 1}/${totalPages}`, 20, 78);

    const pageEntries = entries.slice(this.page * ITEMS_PER_PAGE, this.page * ITEMS_PER_PAGE + ITEMS_PER_PAGE);
    const rowHeight = 128;
    let y = 116;

    if (pageEntries.length === 0) {
      ctx.fillStyle = "#8a8a8a";
      ctx.font = "18px monospace";
      ctx.fillText("Aucun objet trouvé pour l'instant.", 20, y);
    }

    for (const entry of pageEntries) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      ctx.fillRect(14, y, CANVAS_WIDTH - 28, rowHeight - 12);

      ctx.fillStyle = RARITY_COLOR[entry.rarity];
      ctx.beginPath();
      ctx.arc(38, y + 26, 12, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#f2f2f2";
      ctx.font = "bold 20px monospace";
      ctx.fillText(truncate(entry.nameFr, 24), 62, y + 4);

      ctx.font = "14px monospace";
      ctx.fillStyle = "#a8a8a8";
      ctx.fillText(truncate(entry.nameEn, 30), 62, y + 26);

      ctx.fillStyle = RARITY_COLOR[entry.rarity];
      ctx.font = "bold 14px monospace";
      ctx.fillText(`${RARITY_LABEL_FR[entry.rarity]} · Niv. ${entry.depth}`, 62, y + 48);

      ctx.fillStyle = "#8a8a8a";
      ctx.font = "13px monospace";
      wrapText(ctx, entry.descriptionFr, 20, y + 70, CANVAS_WIDTH - 40, 16, 3);

      y += rowHeight;
    }

    this.texture.needsUpdate = true;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): void {
  const words = text.split(" ");
  let line = "";
  let cursorY = y;
  let lines = 0;

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
      lines += 1;
      if (lines >= maxLines) return;
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}
