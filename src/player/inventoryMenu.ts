import * as THREE from "three";
import { DEBUG_ENABLED } from "../debug/debugLog";
import { getLanguage, onLanguageChange, setLanguage, t } from "../i18n";
import { getModelShape } from "../physics/modelShape";
import { inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import { spawnCollectibleModel } from "../world/collectibleLoader";
import { SORT_MODES, type CollectionEntry, type CollectionStore } from "../world/collection";
import { drawAgedPaper, HANDWRITING_FONT } from "../world/loreArt";
import { computePerks } from "../world/collectionPerks";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.64;
/** Mode debug (`?debug=1`) : une rangée de boutons de test en plus. */
const DEBUG_ROW = DEBUG_ENABLED ? 72 : 0;
const HEIGHT = 0.49 + DEBUG_ROW / 1600;
const PX_PER_M = 1600;

const COLUMNS = 5;
const ROWS = 2;
const SLOTS_PER_PAGE = COLUMNS * ROWS;
const SLOT_SIZE = 170;
const SLOT_GAP = 12;
const GRID_X = (WIDTH * PX_PER_M - (COLUMNS * SLOT_SIZE + (COLUMNS - 1) * SLOT_GAP)) / 2;
const GRID_Y = 78;

/** Taille (m) de la miniature 3D dans sa case, et son avancée devant le panneau. */
const MINIATURE_SIZE = 0.078;
const MINIATURE_DEPTH = 0.045;
const SPIN_SPEED = 0.6;
const HOVER_SPIN_SPEED = 2.2;
/** Main tendue dans une case (sans viser) : on peut aussi y prendre l'objet directement. */
const REACH_RADIUS = 0.08;

const MENU_DISTANCE = 0.6;
const MENU_DROP = 0.14;
const MENU_TILT = THREE.MathUtils.degToRad(14);
const STOP_CONFIRM_SECONDS = 3;

type ButtonId = "prev" | "next" | "sort" | "height" | "lang" | "vignette" | "stop" | "journal" | "close";

/** Rangée 1 : inventaire et fin de run. Rangée 2 : options du jeu (langue, confort, hauteur). */
const BUTTONS: Record<ButtonId, Rect> = {
  prev: { x: 40, y: 556, w: 70, h: 64 },
  next: { x: 120, y: 556, w: 70, h: 64 },
  sort: { x: 200, y: 556, w: 190, h: 64 },
  stop: { x: 400, y: 556, w: 250, h: 64 },
  journal: { x: 660, y: 556, w: 180, h: 64 },
  close: { x: 850, y: 556, w: 134, h: 64 },
  lang: { x: 40, y: 632, w: 330, h: 60 },
  vignette: { x: 380, y: 632, w: 330, h: 60 },
  height: { x: 720, y: 632, w: 264, h: 60 },
};

const rarityLabel = (rarity: CollectionEntry["rarity"]): string => t(`rarity.${rarity}`);
const RARITY_COLOR: Record<CollectionEntry["rarity"], string> = { common: "#b9b2a0", rare: "#7fc4e8", legendary: "#e8c34a" };

interface Miniature {
  entryId: string;
  pivot: THREE.Group;
}

export interface InventoryMenuActions {
  takeOut(hand: Hand, entry: CollectionEntry): void;
  recalibrateHeight(): void;
  stopRec(): void;
  /** Ouvre le journal des bandes perdues (il flotte devant le joueur). */
  openJournal(): void;
  /** Salle de montage (intro) en cours : STOP REC devient « passer l'intro » (après la première fois). */
  introActive?(): boolean;
  canSkipIntro?(): boolean;
  skipIntro?(): void;
  /** Vignette de confort : état courant, et bascule (renvoie le nouvel état). */
  vignetteEnabled(): boolean;
  toggleVignette(): boolean;
  /** Boutons de test (mode debug seulement) : libellé courant, action (renvoie un message). */
  debug?: DebugAction[];
}

export interface DebugAction {
  label(): string;
  run(): string;
}

const DEBUG_Y = 708;
function debugRect(index: number, count: number): Rect {
  const gap = 10;
  const w = (944 - gap * (count - 1)) / count;
  return { x: 40 + index * (w + gap), y: DEBUG_Y, w, h: 60 };
}

/**
 * Menu d'inventaire (Y pour ouvrir/fermer) : chaque objet rangé apparaît en miniature 3D qui
 * tourne dans sa case ; viser une case (ou y tendre la main) + grip/gâchette le sort à taille
 * réelle dans la main. Relâcher un objet tenu sur le menu (ou A/X) le range. Le menu suit le
 * joueur (attaché à son corps) et regroupe aussi les actions système (hauteur, STOP REC).
 */
export class InventoryMenu extends UiPanel {
  private page = 0;
  private readonly hoverSlot = new Map<Hand, number | null>();
  private readonly hoverButton = new Map<Hand, ButtonId | number | null>();
  private readonly miniatures = new Map<number, Miniature>();
  private stopArmedUntil = 0;
  /** Objet sélectionné pour être déplacé (index global dans l'inventaire), ou null. */
  private picked: number | null = null;
  private sortIndex = 0;
  private statusMessage = "";
  private statusUntil = 0;
  private time = 0;
  private buildToken = 0;

  constructor(
    private readonly store: CollectionStore,
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly actions: InventoryMenuActions,
    private readonly sfx: Sfx,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "inventory-menu";
    parent.add(this.group);
    store.onChange(() => {
      this.clampPage();
      this.rebuildMiniatures();
      this.invalidate();
    });
    onLanguageChange(() => this.invalidate());
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  open(): void {
    this.placeInFrontOfHead();
    this.group.visible = true;
    this.stopArmedUntil = 0;
    this.rebuildMiniatures();
    this.invalidate();
    this.sfx.play("click", 0.35);
  }

  close(): void {
    this.group.visible = false;
    this.picked = null;
    this.sfx.play("click", 0.25);
  }

  update(deltaSeconds: number, hands: Hand[], isPointerOnMenu: (hand: Hand) => boolean): void {
    this.time += deltaSeconds;
    if (!this.visible) return;
    if (this.stopArmedUntil && this.time > this.stopArmedUntil) {
      this.stopArmedUntil = 0;
      this.invalidate();
    }
    if (this.statusUntil && this.time > this.statusUntil) {
      this.statusUntil = 0;
      this.invalidate();
    }

    const hovered = new Set<number>();
    for (const slot of this.hoverSlot.values()) if (slot !== null) hovered.add(slot);
    for (const [slot, miniature] of this.miniatures) {
      const active = hovered.has(slot);
      miniature.pivot.rotation.y += deltaSeconds * (active ? HOVER_SPIN_SPEED : SPIN_SPEED);
      const scale = THREE.MathUtils.damp(miniature.pivot.scale.x, active ? 1.25 : 1, 12, deltaSeconds);
      miniature.pivot.scale.setScalar(scale);
    }

    // Prise directe : main tendue dans une case + grip, sans passer par le pointeur.
    for (const hand of hands) {
      if (!hand.tracked || hand.holding || !hand.input.squeeze.justPressed || isPointerOnMenu(hand)) continue;
      for (const [slot, miniature] of this.miniatures) {
        const world = miniature.pivot.getWorldPosition(new THREE.Vector3());
        if (world.distanceTo(hand.palm) < REACH_RADIUS) {
          this.takeSlot(hand, slot);
          break;
        }
      }
    }
  }

  onHover(hand: Hand, px: number | null, py: number | null): void {
    const slot = px === null || py === null ? null : this.slotAt(px, py);
    const button = px === null || py === null ? null : this.buttonAt(px, py);
    if (this.hoverSlot.get(hand) !== slot || this.hoverButton.get(hand) !== button) {
      if (button !== null && this.hoverButton.get(hand) !== button) hand.pulse(0.08, 10);
      this.hoverSlot.set(hand, slot);
      this.hoverButton.set(hand, button);
      this.invalidate();
    }
  }

  onPress(hand: Hand, px: number, py: number, button: PressButton): boolean {
    const slot = this.slotAt(px, py);
    if (slot !== null) {
      if (button === "grip") this.takeSlot(hand, slot);
      else this.pickOrDrop(slot);
      return true;
    }
    const id = this.buttonAt(px, py);
    if (id !== null && button === "trigger") {
      if (typeof id === "number") this.runDebug(id);
      else this.activate(id);
    }
    return true;
  }

  private activate(id: ButtonId): void {
    this.sfx.play("click", 0.4);
    switch (id) {
      case "prev":
        this.page -= 1;
        this.clampPage();
        this.rebuildMiniatures();
        break;
      case "next":
        this.page += 1;
        this.clampPage();
        this.rebuildMiniatures();
        break;
      case "height":
        this.actions.recalibrateHeight();
        this.showStatus(t("inv.heightStatus"));
        break;
      case "sort": {
        this.sortIndex = (this.sortIndex + 1) % SORT_MODES.length;
        const mode = SORT_MODES[this.sortIndex]!;
        this.picked = null;
        this.store.sort(mode);
        this.showStatus(t("inv.sortStatus", { mode: t(`sort.${mode}`) }));
        break;
      }
      case "lang":
        setLanguage(getLanguage() === "fr" ? "en" : "fr");
        this.showStatus(t("inv.langStatus"));
        break;
      case "vignette":
        this.showStatus(this.actions.toggleVignette() ? t("inv.vignetteOnStatus") : t("inv.vignetteOffStatus"));
        break;
      case "stop":
        if (this.actions.introActive?.()) {
          if (!this.actions.canSkipIntro?.()) return;
          this.close();
          this.actions.skipIntro?.();
          return;
        }
        if (this.stopArmedUntil) {
          this.stopArmedUntil = 0;
          this.close();
          this.actions.stopRec();
          return;
        }
        this.stopArmedUntil = this.time + STOP_CONFIRM_SECONDS;
        break;
      case "journal":
        this.close();
        this.actions.openJournal();
        return;
      case "close":
        this.close();
        return;
    }
    this.invalidate();
  }

  private runDebug(index: number): void {
    const action = this.actions.debug?.[index];
    if (!action) return;
    this.sfx.play("click", 0.4);
    this.showStatus(action.run());
    this.invalidate();
  }

  /** Gâchette sur une case : sélectionne l'objet, puis gâchette sur une autre case : l'y place. */
  private pickOrDrop(slot: number): void {
    const index = this.page * SLOTS_PER_PAGE + slot;
    this.sfx.play("click", 0.35);
    if (this.picked === null) {
      if (index >= this.store.count) return;
      this.picked = index;
      this.showStatus(t("inv.picked"));
    } else {
      const from = this.picked;
      this.picked = null;
      if (from !== index) {
        this.store.move(from, Math.min(index, this.store.count - 1));
        this.showStatus(t("inv.moved"));
      } else this.statusUntil = 0;
    }
    this.invalidate();
  }

  /**
   * Case d'inventaire (index global) visée par le pointeur de cette main, ou touchée par sa
   * paume : un objet lâché là y est rangé (réorganisation par glisser-déposer).
   */
  slotIndexFor(hand: Hand): number | null {
    let slot = this.hoverSlot.get(hand) ?? null;
    if (slot === null && this.containsPoint(hand.palm)) {
      const local = this.mesh.worldToLocal(hand.palm.clone());
      const px = (local.x / this.widthMeters + 0.5) * this.canvas.width;
      const py = (0.5 - local.y / this.heightMeters) * this.canvas.height;
      slot = this.slotAt(px, py);
    }
    return slot === null ? null : this.page * SLOTS_PER_PAGE + slot;
  }

  private takeSlot(hand: Hand, slot: number): void {
    const entry = this.entriesOnPage()[slot];
    if (!entry || hand.holding) return;
    this.actions.takeOut(hand, entry);
  }

  private showStatus(message: string): void {
    this.statusMessage = message;
    this.statusUntil = this.time + 3;
  }

  private get pageCount(): number {
    return Math.max(1, Math.ceil(this.store.count / SLOTS_PER_PAGE));
  }

  private clampPage(): void {
    this.page = ((this.page % this.pageCount) + this.pageCount) % this.pageCount;
  }

  private entriesOnPage(): readonly CollectionEntry[] {
    const all = this.store.getAll();
    return all.slice(this.page * SLOTS_PER_PAGE, this.page * SLOTS_PER_PAGE + SLOTS_PER_PAGE);
  }

  private slotRect(slot: number): Rect {
    const column = slot % COLUMNS;
    const row = Math.floor(slot / COLUMNS);
    return { x: GRID_X + column * (SLOT_SIZE + SLOT_GAP), y: GRID_Y + row * (SLOT_SIZE + SLOT_GAP), w: SLOT_SIZE, h: SLOT_SIZE };
  }

  private slotAt(px: number, py: number): number | null {
    for (let slot = 0; slot < SLOTS_PER_PAGE; slot++) if (inRect(this.slotRect(slot), px, py)) return slot;
    return null;
  }

  /** Bouton sous le pointeur : identifiant, ou index d'un bouton de debug. */
  private buttonAt(px: number, py: number): ButtonId | number | null {
    for (const [id, rect] of Object.entries(BUTTONS) as Array<[ButtonId, Rect]>) if (inRect(rect, px, py)) return id;
    const debug = DEBUG_ENABLED ? (this.actions.debug ?? []) : [];
    for (let i = 0; i < debug.length; i++) if (inRect(debugRect(i, debug.length), px, py)) return i;
    return null;
  }

  private placeInFrontOfHead(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * MENU_DISTANCE, head.y - MENU_DROP, head.z + forward.z * MENU_DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0, "YXZ");
    this.group.rotateX(-MENU_TILT);
  }

  private rebuildMiniatures(): void {
    const token = ++this.buildToken;
    for (const miniature of this.miniatures.values()) miniature.pivot.removeFromParent();
    this.miniatures.clear();
    if (!this.visible) return;

    this.entriesOnPage().forEach((entry, slot) => {
      spawnCollectibleModel(entry.kind)
        .then(({ model, template }) => {
          if (token !== this.buildToken) return;
          const shape = getModelShape(template);
          const size = shape.box.getSize(new THREE.Vector3());
          const scale = MINIATURE_SIZE / Math.max(size.x, size.y, size.z, 0.01);
          const center = shape.box.getCenter(new THREE.Vector3());
          model.scale.setScalar(scale);
          model.position.copy(center).multiplyScalar(-scale);

          const pivot = new THREE.Group();
          pivot.add(model);
          const rect = this.slotRect(slot);
          pivot.position.set(
            ((rect.x + rect.w / 2) / this.canvas.width) * this.widthMeters - this.widthMeters / 2,
            this.heightMeters / 2 - ((rect.y + rect.h / 2 - 8) / this.canvas.height) * this.heightMeters,
            MINIATURE_DEPTH,
          );
          pivot.rotation.x = 0.35;
          this.group.add(pivot);
          this.miniatures.set(slot, { entryId: entry.id, pivot });
        })
        .catch(() => {});
    });
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    drawCase(ctx, width, height);

    // Étiquette en ruban de masquage, écrite au feutre, et compteur pochoir sur le métal.
    drawTape(ctx, { x: 44, y: 16, w: 300, h: 50 }, -0.02, "#e8dfc2");
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#1d1f22";
    ctx.font = `bold 34px ${HANDWRITING_FONT}`;
    ctx.fillText(t("inv.title"), 64, 42);
    ctx.textAlign = "right";
    ctx.font = "bold 24px monospace";
    ctx.fillStyle = "#d9dcd6";
    ctx.fillText(t("inv.count", { count: this.store.count, page: this.page + 1, pages: this.pageCount }), width - 48, 42);

    drawFoam(ctx, { x: GRID_X - 22, y: GRID_Y - 14, w: width - 2 * (GRID_X - 22), h: 2 * SLOT_SIZE + SLOT_GAP + 28 });
    const entries = this.entriesOnPage();
    const hoveredSlots = new Set([...this.hoverSlot.values()].filter((slot): slot is number => slot !== null));
    for (let slot = 0; slot < SLOTS_PER_PAGE; slot++) {
      const rect = this.slotRect(slot);
      const entry = entries[slot];
      const picked = this.picked === this.page * SLOTS_PER_PAGE + slot;
      drawCutout(ctx, rect, { filled: entry !== undefined, hovered: hoveredSlots.has(slot) && entry !== undefined, picked });
      if (entry) drawTape(ctx, { x: rect.x + 8, y: rect.y + 8, w: 54, h: 16 }, -0.06, RARITY_COLOR[entry.rarity]);
    }

    // Fiche de l'objet survolé : même papier que le journal et les bandes perdues.
    const card: Rect = { x: 44, y: 446, w: width - 88, h: 96 };
    const focus = [...hoveredSlots].map((slot) => entries[slot]).find((entry) => entry !== undefined);
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#cdb98f";
    ctx.fillRect(card.x, card.y, card.w, card.h);
    ctx.restore();
    drawAgedPaper(ctx, card.x, card.y, card.w, card.h, 404, false);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (focus) {
      const french = getLanguage() === "fr";
      ctx.fillStyle = "#1c2753";
      ctx.font = `bold 30px ${HANDWRITING_FONT}`;
      ctx.fillText(french ? focus.nameFr : focus.nameEn, card.x + 20, card.y + 26);
      ctx.textAlign = "right";
      ctx.font = `bold 19px "Courier New", monospace`;
      ctx.fillStyle = "#3a2f22";
      ctx.fillText(t("inv.found", { rarity: rarityLabel(focus.rarity), depth: focus.depth }), card.x + card.w - 20, card.y + 26);
      ctx.textAlign = "left";
      ctx.font = `19px "Courier New", monospace`;
      ctx.fillStyle = "#4a3d2c";
      wrapText(ctx, french ? focus.descriptionFr : focus.descriptionEn, card.x + 20, card.y + 64, card.w - 40, 22, 2);
    } else if (this.statusUntil) {
      ctx.font = `bold 22px "Courier New", monospace`;
      ctx.fillStyle = "#2f6b2f";
      ctx.fillText(this.statusMessage, card.x + 20, card.y + card.h / 2);
    } else {
      ctx.font = `19px "Courier New", monospace`;
      ctx.fillStyle = "#4a3d2c";
      ctx.fillText(this.store.count === 0 ? t("inv.empty") : t("inv.aim"), card.x + 20, card.y + 32);
      ctx.fillText(t("inv.store"), card.x + 20, card.y + 64);
    }

    const hoveredButtons = new Set(this.hoverButton.values());
    drawPlate(ctx, BUTTONS.prev, "◀", { hovered: hoveredButtons.has("prev"), disabled: this.pageCount < 2 });
    drawPlate(ctx, BUTTONS.next, "▶", { hovered: hoveredButtons.has("next"), disabled: this.pageCount < 2 });
    drawPlate(ctx, BUTTONS.sort, t("inv.sort"), { hovered: hoveredButtons.has("sort") });
    drawPlate(ctx, BUTTONS.height, t("inv.height"), { hovered: hoveredButtons.has("height") });
    drawPlate(ctx, BUTTONS.lang, t("inv.lang"), { hovered: hoveredButtons.has("lang") });
    drawPlate(ctx, BUTTONS.vignette, this.actions.vignetteEnabled() ? t("inv.vignetteOn") : t("inv.vignetteOff"), { hovered: hoveredButtons.has("vignette") });
    if (this.actions.introActive?.()) {
      drawPlate(ctx, BUTTONS.stop, t("inv.skipIntro"), { hovered: hoveredButtons.has("stop"), accent: "#4f93c9", disabled: !this.actions.canSkipIntro?.() });
    } else drawPlate(ctx, BUTTONS.stop, this.stopArmedUntil ? t("inv.confirm") : t("inv.stop"), { hovered: hoveredButtons.has("stop"), accent: "#d23b2f" });
    drawPlate(ctx, BUTTONS.journal, t("inv.journal"), { hovered: hoveredButtons.has("journal"), accent: "#e3b12a" });
    drawPlate(ctx, BUTTONS.close, t("inv.close"), { hovered: hoveredButtons.has("close") });
    if (DEBUG_ENABLED) {
      const debug = this.actions.debug ?? [];
      debug.forEach((action, i) => drawPlate(ctx, debugRect(i, debug.length), action.label(), { hovered: hoveredButtons.has(i), accent: "#4f93c9" }));
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 19px monospace";
    ctx.fillStyle = "#e3d6a8";
    const perks = computePerks(this.store.getAll());
    const battery = Math.round((perks.batteryCapacity - 1) * 100);
    const decay = Math.round((perks.corruptionDecay - 1) * 100);
    ctx.fillText(
      battery === 0 && decay === 0 && perks.beaconSteadiness === 0
        ? t("perks.none")
        : t("perks.line", { battery, decay, compass: perks.beaconSteadiness > 0 ? t("perks.compass") : "" }),
      width / 2,
      720 + DEBUG_ROW,
    );
    ctx.font = "18px monospace";
    ctx.fillStyle = "#a9aea8";
    ctx.fillText(t("inv.footer"), width / 2, 750 + DEBUG_ROW);
    ctx.textAlign = "right";
    ctx.font = "14px monospace";
    ctx.fillStyle = "#7c827d";
    ctx.fillText(`build ${__BUILD_ID__}`, width - 96, 772 + DEBUG_ROW);
  }
}

/** Mallette de tournage (flight case) : aluminium brossé, cornières noires rivetées. */
function drawCase(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  ctx.roundRect(4, 4, width - 8, height - 8, 18);
  const metal = ctx.createLinearGradient(0, 0, 0, height);
  metal.addColorStop(0, "#6e7479");
  metal.addColorStop(0.5, "#50565b");
  metal.addColorStop(1, "#3b4044");
  ctx.fillStyle = metal;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Brossage horizontal de l'aluminium.
  for (let y = 6; y < height; y += 3) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.02 + ((y * 7919) % 13) / 400})`;
    ctx.fillRect(0, y, width, 1);
  }
  ctx.restore();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#24272a";
  ctx.stroke();
  // Profilé intérieur (arête de la mallette).
  ctx.beginPath();
  ctx.roundRect(22, 22, width - 44, height - 44, 10);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.stroke();
  for (const [cx, cy, sx, sy] of [
    [4, 4, 1, 1],
    [width - 4, 4, -1, 1],
    [4, height - 4, 1, -1],
    [width - 4, height - 4, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + sy * 70);
    ctx.lineTo(cx, cy + sy * 16);
    ctx.quadraticCurveTo(cx, cy, cx + sx * 16, cy);
    ctx.lineTo(cx + sx * 70, cy);
    ctx.lineTo(cx + sx * 70, cy + sy * 26);
    ctx.lineTo(cx + sx * 26, cy + sy * 26);
    ctx.lineTo(cx + sx * 26, cy + sy * 70);
    ctx.closePath();
    ctx.fillStyle = "#16181a";
    ctx.fill();
    for (const [rx, ry] of [
      [cx + sx * 14, cy + sy * 50],
      [cx + sx * 50, cy + sy * 14],
    ] as Array<[number, number]>) {
      ctx.beginPath();
      ctx.arc(rx, ry, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "#8d9398";
      ctx.fill();
    }
  }
}

/** Mousse alvéolée noire dans laquelle les objets sont calés. */
function drawFoam(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 10);
  ctx.fillStyle = "#1c1e21";
  ctx.fill();
  ctx.clip();
  for (let y = rect.y + 6; y < rect.y + rect.h; y += 14) {
    for (let x = rect.x + ((y / 14) % 2 ? 6 : 13); x < rect.x + rect.w; x += 14) {
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.035)";
      ctx.fill();
    }
  }
  const shade = ctx.createLinearGradient(0, rect.y, 0, rect.y + 24);
  shade.addColorStop(0, "rgba(0, 0, 0, 0.55)");
  shade.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = shade;
  ctx.fillRect(rect.x, rect.y, rect.w, 24);
  ctx.restore();
}

/** Découpe dans la mousse : creuse (ombre intérieure), éclairée au survol, cerclée si sélectionnée. */
function drawCutout(ctx: CanvasRenderingContext2D, rect: Rect, state: { filled: boolean; hovered: boolean; picked: boolean }): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(rect.x + 6, rect.y + 6, rect.w - 12, rect.h - 12, 18);
  ctx.fillStyle = state.hovered ? "#2d2a22" : state.filled ? "#0e0f10" : "#141517";
  ctx.fill();
  ctx.clip();
  const inner = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
  inner.addColorStop(0, "rgba(0, 0, 0, 0.7)");
  inner.addColorStop(0.35, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = inner;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  if (state.hovered) {
    const glow = ctx.createRadialGradient(rect.x + rect.w / 2, rect.y + rect.h / 2, 10, rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w * 0.6);
    glow.addColorStop(0, "rgba(255, 214, 130, 0.28)");
    glow.addColorStop(1, "rgba(255, 214, 130, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.roundRect(rect.x + 6, rect.y + 6, rect.w - 12, rect.h - 12, 18);
  if (!state.filled) ctx.setLineDash([8, 7]);
  ctx.lineWidth = state.picked ? 6 : state.hovered ? 3 : 2;
  ctx.strokeStyle = state.picked ? "#9fe39f" : state.hovered ? "#ffd98a" : "rgba(255, 255, 255, 0.1)";
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Morceau de ruban adhésif (bords déchirés), légèrement de travers. */
function drawTape(ctx: CanvasRenderingContext2D, rect: Rect, angle: number, color: string): void {
  ctx.save();
  ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.rotate(angle);
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  ctx.beginPath();
  ctx.moveTo(-halfW, -halfH);
  ctx.lineTo(halfW, -halfH);
  for (let i = 0; i <= 6; i++) ctx.lineTo(halfW + (i % 2 ? -4 : 0), -halfH + (rect.h * i) / 6);
  ctx.lineTo(-halfW, halfH);
  for (let i = 6; i >= 0; i--) ctx.lineTo(-halfW + (i % 2 ? 4 : 0), -halfH + (rect.h * i) / 6);
  ctx.closePath();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.93;
  ctx.fill();
  ctx.restore();
}

/** Plaque métallique gravée (bouton) ; un ruban de couleur la distingue (STOP, journal, debug). */
function drawPlate(ctx: CanvasRenderingContext2D, rect: Rect, label: string, state: { hovered: boolean; accent?: string; disabled?: boolean }): void {
  ctx.save();
  ctx.globalAlpha = state.disabled ? 0.4 : 1;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8);
  const plate = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
  if (state.hovered) {
    plate.addColorStop(0, "#ffe3a1");
    plate.addColorStop(1, "#e2b75a");
  } else {
    plate.addColorStop(0, "#d6d9d4");
    plate.addColorStop(1, "#9ba09b");
  }
  ctx.fillStyle = plate;
  ctx.shadowColor = state.hovered ? "rgba(255, 200, 100, 0.55)" : "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = state.hovered ? 14 : 6;
  ctx.shadowOffsetY = state.hovered ? 0 : 3;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#2c3034";
  ctx.stroke();
  if (state.accent) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = state.accent;
    ctx.fillRect(rect.x, rect.y, 12, rect.h);
    ctx.restore();
  }
  for (const [x, y] of [
    [rect.x + 8 + (state.accent ? 10 : 0), rect.y + 8],
    [rect.x + rect.w - 8, rect.y + 8],
    [rect.x + 8 + (state.accent ? 10 : 0), rect.y + rect.h - 8],
    [rect.x + rect.w - 8, rect.y + rect.h - 8],
  ] as Array<[number, number]>) {
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(40, 44, 48, 0.55)";
    ctx.fill();
  }
  // Texte gravé : ombre claire décalée sous le texte sombre.
  ctx.font = "bold 27px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = rect.x + rect.w / 2 + (state.accent ? 6 : 0);
  const cy = rect.y + rect.h / 2 + 1;
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.fillText(label, cx, cy + 1.5);
  ctx.fillStyle = "#23272b";
  ctx.fillText(label, cx, cy);
  ctx.restore();
}
