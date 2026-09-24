import * as THREE from "three";
import { getLanguage, loreFragment, onLanguageChange, setLanguage, t } from "../i18n";
import { getModelShape } from "../physics/modelShape";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import { spawnCollectibleModel } from "../world/collectibleLoader";
import { SORT_MODES, type CollectionEntry, type CollectionStore } from "../world/collection";
import { computePerks } from "../world/collectionPerks";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.64;
const HEIGHT = 0.49;
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

type ButtonId = "prev" | "next" | "sort" | "height" | "lang" | "vignette" | "stop" | "close";

/** Rangée 1 : inventaire et fin de run. Rangée 2 : options du jeu (langue, confort, hauteur). */
const BUTTONS: Record<ButtonId, Rect> = {
  prev: { x: 40, y: 556, w: 70, h: 64 },
  next: { x: 120, y: 556, w: 70, h: 64 },
  sort: { x: 200, y: 556, w: 190, h: 64 },
  stop: { x: 400, y: 556, w: 300, h: 64 },
  close: { x: 710, y: 556, w: 274, h: 64 },
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
  /** Vignette de confort : état courant, et bascule (renvoie le nouvel état). */
  vignetteEnabled(): boolean;
  toggleVignette(): boolean;
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
  private readonly hoverButton = new Map<Hand, ButtonId | null>();
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
      if (button && this.hoverButton.get(hand) !== button) hand.pulse(0.08, 10);
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
    if (id && button === "trigger") this.activate(id);
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
        if (this.stopArmedUntil) {
          this.stopArmedUntil = 0;
          this.close();
          this.actions.stopRec();
          return;
        }
        this.stopArmedUntil = this.time + STOP_CONFIRM_SECONDS;
        break;
      case "close":
        this.close();
        return;
    }
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

  private buttonAt(px: number, py: number): ButtonId | null {
    for (const [id, rect] of Object.entries(BUTTONS) as Array<[ButtonId, Rect]>) if (inRect(rect, px, py)) return id;
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
    drawPanelBackground(ctx, width, this.canvas.height);

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#f2e8cf";
    ctx.font = "bold 38px monospace";
    ctx.fillText(t("inv.title"), 40, 42);
    ctx.textAlign = "right";
    ctx.font = "26px monospace";
    ctx.fillStyle = "#b9ae93";
    ctx.fillText(t("inv.count", { count: this.store.count, page: this.page + 1, pages: this.pageCount }), width - 40, 42);

    const entries = this.entriesOnPage();
    const hoveredSlots = new Set([...this.hoverSlot.values()].filter((slot): slot is number => slot !== null));
    for (let slot = 0; slot < SLOTS_PER_PAGE; slot++) {
      const rect = this.slotRect(slot);
      const entry = entries[slot];
      const hovered = hoveredSlots.has(slot) && entry !== undefined;
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 16);
      ctx.fillStyle = hovered ? "rgba(255, 232, 170, 0.16)" : "rgba(255, 244, 214, 0.05)";
      ctx.fill();
      const picked = this.picked === this.page * SLOTS_PER_PAGE + slot;
      ctx.lineWidth = picked ? 8 : hovered ? 5 : 2;
      ctx.strokeStyle = picked ? "#9fe39f" : entry ? RARITY_COLOR[entry.rarity] : "rgba(255, 244, 214, 0.15)";
      ctx.globalAlpha = entry ? 1 : 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const focus = [...hoveredSlots].map((slot) => entries[slot]).find((entry) => entry !== undefined);
    ctx.textAlign = "left";
    if (focus) {
      ctx.font = "bold 32px monospace";
      ctx.fillStyle = "#f2e8cf";
      const french = getLanguage() === "fr";
      ctx.fillText(french ? focus.nameFr : focus.nameEn, 40, 462);
      ctx.font = "22px monospace";
      ctx.fillStyle = RARITY_COLOR[focus.rarity];
      ctx.fillText(t("inv.found", { rarity: rarityLabel(focus.rarity), depth: focus.depth }), 40, 496);
      ctx.font = "21px monospace";
      // Objet porteur d'un fragment du récit : la bande perdue remplace la description.
      const fragment = focus.fragment !== undefined ? loreFragment(focus.fragment) : null;
      if (fragment) {
        ctx.fillStyle = "#e8c34a";
        wrapText(ctx, `${t("lore.title", { n: (focus.fragment ?? 0) + 1 })} — « ${fragment} »`, 40, 526, width - 80, 24, 1);
      } else {
        ctx.fillStyle = "#a79d86";
        wrapText(ctx, french ? focus.descriptionFr : focus.descriptionEn, 40, 526, width - 80, 24, 1);
      }
    } else if (this.statusUntil) {
      ctx.font = "26px monospace";
      ctx.fillStyle = "#9fe39f";
      ctx.fillText(this.statusMessage, 40, 480);
    } else {
      ctx.font = "21px monospace";
      ctx.fillStyle = "#a79d86";
      ctx.fillText(this.store.count === 0 ? t("inv.empty") : t("inv.aim"), 40, 480);
      ctx.fillText(t("inv.store"), 40, 514);
    }

    const hoveredButtons = new Set(this.hoverButton.values());
    drawButton(ctx, BUTTONS.prev, "◀", { hovered: hoveredButtons.has("prev"), disabled: this.pageCount < 2 });
    drawButton(ctx, BUTTONS.next, "▶", { hovered: hoveredButtons.has("next"), disabled: this.pageCount < 2 });
    drawButton(ctx, BUTTONS.sort, t("inv.sort"), { hovered: hoveredButtons.has("sort") });
    drawButton(ctx, BUTTONS.height, t("inv.height"), { hovered: hoveredButtons.has("height") });
    drawButton(ctx, BUTTONS.lang, t("inv.lang"), { hovered: hoveredButtons.has("lang") });
    drawButton(ctx, BUTTONS.vignette, this.actions.vignetteEnabled() ? t("inv.vignetteOn") : t("inv.vignetteOff"), {
      hovered: hoveredButtons.has("vignette"),
    });
    drawButton(ctx, BUTTONS.stop, this.stopArmedUntil ? t("inv.confirm") : t("inv.stop"), {
      hovered: hoveredButtons.has("stop"),
      accent: "#ff6b5a",
    });
    drawButton(ctx, BUTTONS.close, t("inv.close"), { hovered: hoveredButtons.has("close") });

    ctx.textAlign = "center";
    ctx.font = "20px monospace";
    ctx.fillStyle = "#c9b98a";
    const perks = computePerks(this.store.getAll());
    const battery = Math.round((perks.batteryCapacity - 1) * 100);
    const decay = Math.round((perks.corruptionDecay - 1) * 100);
    ctx.fillText(
      battery === 0 && decay === 0 && perks.beaconSteadiness === 0
        ? t("perks.none")
        : t("perks.line", { battery, decay, compass: perks.beaconSteadiness > 0 ? t("perks.compass") : "" }),
      width / 2,
      720,
    );
    ctx.fillStyle = "#7d7563";
    ctx.fillText(t("inv.footer"), width / 2, 752);
    ctx.textAlign = "right";
    ctx.font = "15px monospace";
    ctx.fillText(`build ${__BUILD_ID__}`, width - 20, 774);
  }
}
