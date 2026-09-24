import * as THREE from "three";
import { getModelShape } from "../physics/modelShape";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import { spawnCollectibleModel } from "../world/collectibleLoader";
import type { CollectionEntry, CollectionStore } from "../world/collection";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.64;
const HEIGHT = 0.44;
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

type ButtonId = "prev" | "next" | "height" | "stop" | "close";

const BUTTONS: Record<ButtonId, Rect> = {
  prev: { x: 40, y: 556, w: 90, h: 64 },
  next: { x: 140, y: 556, w: 90, h: 64 },
  height: { x: 250, y: 556, w: 300, h: 64 },
  stop: { x: 570, y: 556, w: 220, h: 64 },
  close: { x: 810, y: 556, w: 174, h: 64 },
};

const RARITY_LABEL: Record<CollectionEntry["rarity"], string> = { common: "Commun", rare: "Rare", legendary: "Légendaire" };
const RARITY_COLOR: Record<CollectionEntry["rarity"], string> = { common: "#b9b2a0", rare: "#7fc4e8", legendary: "#e8c34a" };

interface Miniature {
  entryId: string;
  pivot: THREE.Group;
}

export interface InventoryMenuActions {
  takeOut(hand: Hand, entry: CollectionEntry): void;
  recalibrateHeight(): void;
  stopRec(): void;
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
      this.takeSlot(hand, slot);
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
        this.showStatus("Hauteur recalée sur votre position actuelle.");
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
    const all = [...this.store.getAll()].sort((a, b) => b.collectedAt - a.collectedAt);
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
    ctx.fillText("INVENTAIRE", 40, 42);
    ctx.textAlign = "right";
    ctx.font = "26px monospace";
    ctx.fillStyle = "#b9ae93";
    ctx.fillText(`${this.store.count} objet(s) · page ${this.page + 1}/${this.pageCount}`, width - 40, 42);

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
      ctx.lineWidth = hovered ? 5 : 2;
      ctx.strokeStyle = entry ? RARITY_COLOR[entry.rarity] : "rgba(255, 244, 214, 0.15)";
      ctx.globalAlpha = entry ? 1 : 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const focus = [...hoveredSlots].map((slot) => entries[slot]).find((entry) => entry !== undefined);
    ctx.textAlign = "left";
    if (focus) {
      ctx.font = "bold 32px monospace";
      ctx.fillStyle = "#f2e8cf";
      ctx.fillText(focus.nameFr, 40, 462);
      ctx.font = "22px monospace";
      ctx.fillStyle = RARITY_COLOR[focus.rarity];
      ctx.fillText(`${RARITY_LABEL[focus.rarity]} · trouvé au niveau ${focus.depth} · ${focus.nameEn}`, 40, 496);
      ctx.fillStyle = "#a79d86";
      ctx.font = "21px monospace";
      wrapText(ctx, focus.descriptionFr, 40, 526, width - 80, 24, 1);
    } else if (this.statusUntil) {
      ctx.font = "26px monospace";
      ctx.fillStyle = "#9fe39f";
      ctx.fillText(this.statusMessage, 40, 480);
    } else {
      ctx.font = "24px monospace";
      ctx.fillStyle = "#a79d86";
      ctx.fillText(this.store.count === 0 ? "Inventaire vide — ramassez des objets et relâchez-les ici." : "Visez un objet pour le détailler, grip pour le prendre en main.", 40, 480);
      ctx.fillText("Relâchez un objet tenu sur ce menu (ou A/X) pour le ranger.", 40, 514);
    }

    const hoveredButtons = new Set(this.hoverButton.values());
    drawButton(ctx, BUTTONS.prev, "◀", { hovered: hoveredButtons.has("prev"), disabled: this.pageCount < 2 });
    drawButton(ctx, BUTTONS.next, "▶", { hovered: hoveredButtons.has("next"), disabled: this.pageCount < 2 });
    drawButton(ctx, BUTTONS.height, "RECALER HAUTEUR", { hovered: hoveredButtons.has("height") });
    drawButton(ctx, BUTTONS.stop, this.stopArmedUntil ? "CONFIRMER ?" : "■ STOP REC", {
      hovered: hoveredButtons.has("stop"),
      accent: "#ff6b5a",
    });
    drawButton(ctx, BUTTONS.close, "FERMER", { hovered: hoveredButtons.has("close") });

    ctx.textAlign = "center";
    ctx.font = "20px monospace";
    ctx.fillStyle = "#7d7563";
    ctx.fillText("Y : ouvrir/fermer · gâchette : cliquer · grip : prendre un objet", width / 2, 662);
  }
}
