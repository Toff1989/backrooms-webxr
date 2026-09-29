import * as THREE from "three";
import { log } from "../debug/debugLog";
import { loreFragment, onLanguageChange, t } from "../i18n";
import { LORE_FRAGMENT_COUNT, loreFormat, type LoreFormat } from "../shared/lore";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import { playLoreTape } from "../world/lorePage";
import type { LoreJournal } from "../world/loreJournal";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.44;
const HEIGHT = 0.3;
const PX_PER_M = 2400;
const CANVAS_W = Math.round(WIDTH * PX_PER_M);
const CANVAS_H = Math.round(HEIGHT * PX_PER_M);

const LEFT_PAGE: Rect = { x: 30, y: 30, w: 488, h: 570 };
const RIGHT_PAGE: Rect = { x: CANVAS_W - 30 - 488, y: 30, w: 488, h: 570 };
const CLOSE_BUTTON: Rect = { x: CANVAS_W / 2 - 115, y: 624, w: 230, h: 66 };
const INDEX_TOP = 118;
const INDEX_ROW = 29;
/** Couleur de l'étiquette de forme dans l'index (note, fiche, photo, audio). */
const FORMAT_COLOR: Record<LoreFormat, string> = { journal: "#7fa6e8", fiche: "#e06a5a", polaroid: "#7fd07f", audio: "#e8a44a" };
const PLAY_BUTTON: Rect = { x: CANVAS_W - 30 - 488 + 30, y: 30 + 570 - 84, w: 250, h: 58 };

const FLOAT_DISTANCE = 0.55;


/**
 * Journal des archives perdues : un carnet qu'on ouvre depuis le menu d'inventaire (bouton
 * JOURNAL), qui flotte alors devant soi. L'autre main tourne les pages au pointeur (gâchette).
 * - Onglet ARCHIVES : l'index des 16 archives (lues ou encore perdues), et l'archive choisie
 *   écrite à la main sur la page de droite.
 * - Onglet ENREGISTREMENT : le code de cassette et les meilleures runs ; le jumelage se trouve
 *   dans le menu APPAREILS du menu principal.
 */
export class Journal extends UiPanel {
  private selected = 0;
  private readonly hovered = new Map<Hand, string | null>();
  private hitRects: Array<{ id: string; rect: Rect }> = [];
  private hasInitialPlacement = false;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly body: THREE.Object3D,
    private readonly lore: LoreJournal,
    private readonly sfx: Sfx,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "journal";
    onLanguageChange(() => this.invalidate());
    lore.onChange(() => this.invalidate());
  }

  /** Depuis le menu : le journal flotte devant le joueur. */
  openFloating(): void {
    if (this.group.parent !== this.body) this.body.add(this.group);
    if (!this.hasInitialPlacement) {
      const head = this.camera.position;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      this.group.position.set(head.x + forward.x * FLOAT_DISTANCE, head.y - 0.12, head.z + forward.z * FLOAT_DISTANCE);
      this.group.rotation.set(-0.2, Math.atan2(-forward.x, -forward.z), 0, "YXZ");
      this.hasInitialPlacement = true;
    }
    this.show();
  }

  close(): void {
    if (!this.visible) return;
    this.group.visible = false;
    this.sfx.play("click", 0.25);
  }

  private show(): void {
    log("journal", { action: "open" });
    this.group.visible = true;
    // Ouvert sur la dernière archive lue (la plus récente), sinon sur la première à trouver.
    this.selected = Math.max(0, Math.min(this.lore.count, LORE_FRAGMENT_COUNT) - 1);
    this.sfx.play("take", 0.35);
    this.invalidate();
    void this.lore.sync();
  }

  onHover(hand: Hand, px: number | null, py: number | null): void {
    const id = px === null || py === null ? null : this.hitAt(px, py);
    if (this.hovered.get(hand) === id) return;
    if (id) hand.pulse(0.06, 8);
    this.hovered.set(hand, id);
    this.invalidate();
  }

  onPress(_hand: Hand, px: number, py: number, button: PressButton): boolean {
    if (button !== "trigger") return true;
    const id = this.hitAt(px, py);
    if (!id) return true;
    this.sfx.play("click", 0.35);
    this.activate(id);
    this.invalidate();
    return true;
  }

  private hitAt(px: number, py: number): string | null {
    return this.hitRects.find((hit) => inRect(hit.rect, px, py))?.id ?? null;
  }

  private activate(id: string): void {
    if (id === "tab:close") {
      this.close();
      return;
    }
    if (id.startsWith("tape:")) {
      this.selected = Number(id.slice(5));
      return;
    }
    if (id === "audio:play") {
      playLoreTape(this.selected);
      return;
    }
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    this.hitRects = [];
    drawPanelBackground(ctx, CANVAS_W, CANVAS_H);
    this.drawPagePanel(ctx, LEFT_PAGE);
    this.drawPagePanel(ctx, RIGHT_PAGE);
    this.drawTapes(ctx);

    const hovered = new Set(this.hovered.values());
    drawButton(ctx, CLOSE_BUTTON, t("journal.close"), { hovered: hovered.has("tab:close") });
    this.hitRects.push({ id: "tab:close", rect: CLOSE_BUTTON });
  }

  /** Fond simple d'une colonne (même esprit que les autres menus, pas de texture). */
  private drawPagePanel(ctx: CanvasRenderingContext2D, page: Rect): void {
    ctx.beginPath();
    ctx.roundRect(page.x, page.y, page.w, page.h, 12);
    ctx.fillStyle = "rgba(255, 244, 214, 0.05)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 244, 214, 0.15)";
    ctx.stroke();
  }

  private heading(ctx: CanvasRenderingContext2D, page: Rect, text: string): void {
    ctx.fillStyle = "#f2e8cf";
    ctx.font = "bold 30px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, page.x + 30, page.y + 56);
  }

  private drawTapes(ctx: CanvasRenderingContext2D): void {
    const count = this.lore.count;
    this.heading(ctx, LEFT_PAGE, t("journal.title"));
    ctx.font = "22px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "#b9ae93";
    ctx.fillText(t("journal.progress", { count, total: LORE_FRAGMENT_COUNT }), LEFT_PAGE.x + LEFT_PAGE.w - 26, LEFT_PAGE.y + 56);

    const hovered = new Set(this.hovered.values());
    for (let index = 0; index < LORE_FRAGMENT_COUNT; index++) {
      const rect: Rect = { x: LEFT_PAGE.x + 20, y: LEFT_PAGE.y + INDEX_TOP + index * INDEX_ROW - 22, w: LEFT_PAGE.w - 40, h: INDEX_ROW };
      const known = index < count;
      if (index === this.selected) {
        ctx.fillStyle = "rgba(232, 195, 74, 0.3)";
        ctx.fillRect(rect.x, rect.y + 2, rect.w, rect.h - 2);
      } else if (hovered.has(`tape:${index}`)) {
        ctx.fillStyle = "rgba(232, 195, 74, 0.14)";
        ctx.fillRect(rect.x, rect.y + 2, rect.w, rect.h - 2);
      }
      ctx.textAlign = "left";
      ctx.fillStyle = known ? "#f2e8cf" : "rgba(255, 244, 214, 0.3)";
      ctx.font = "bold 20px monospace";
      const label = `n°${String(index + 1).padStart(2, "0")}`;
      ctx.fillText(label, rect.x + 8, rect.y + 21);
      if (known) {
        const format = loreFormat(index);
        ctx.font = "bold 17px monospace";
        ctx.fillStyle = FORMAT_COLOR[format];
        ctx.fillText(t(`lore.format.${format}`), rect.x + 80, rect.y + 21);
      }
      // Pas d'extrait du texte dans l'index (il ne tiendrait jamais sans être rogné) : la page de droite
      // affiche l'archive en entier dès qu'on la sélectionne.
      if (!known) {
        ctx.font = "20px monospace";
        ctx.fillStyle = "rgba(255, 244, 214, 0.25)";
        ctx.fillText("— — — — — —", rect.x + 80, rect.y + 21);
      }
      this.hitRects.push({ id: `tape:${index}`, rect });
    }

    if (this.selected < count) {
      this.heading(ctx, RIGHT_PAGE, t("lore.title", { n: this.selected + 1 }));
      this.note(ctx, RIGHT_PAGE, loreFragment(this.selected) ?? "", 100, "#d8cfb6", 22);
      if (loreFormat(this.selected) === "audio") {
        drawButton(ctx, PLAY_BUTTON, t("audio.play"), { hovered: hovered.has("audio:play"), accent: "#e8a44a" });
        this.hitRects.push({ id: "audio:play", rect: PLAY_BUTTON });
      }
    } else {
      this.heading(ctx, RIGHT_PAGE, t("lore.title", { n: this.selected + 1 }));
      ctx.fillStyle = "#a79d86";
      ctx.font = "22px monospace";
      ctx.textAlign = "left";
      ctx.fillText(t("journal.empty"), RIGHT_PAGE.x + 34, RIGHT_PAGE.y + 110);
    }
  }

  private note(ctx: CanvasRenderingContext2D, page: Rect, text: string, y: number, color = "#a79d86", size = 21): void {
    ctx.fillStyle = color;
    ctx.font = `${size}px monospace`;
    ctx.textAlign = "left";
    wrapText(ctx, text, page.x + 34, page.y + y, page.w - 68, Math.round(size * 1.3), 12);
  }
}
