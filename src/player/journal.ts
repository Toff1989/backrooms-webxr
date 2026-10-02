import * as THREE from "three";
import { log } from "../debug/debugLog";
import { onLanguageChange, t } from "../i18n";
import { getModelShape } from "../physics/modelShape";
import { LORE_FRAGMENT_COUNT, loreFormat, type LoreFormat } from "../shared/lore";
import { drawButton, drawPanelBackground, inRect, UiPanel, type PressButton, type Rect } from "../ui/uiPanel";
import { onLorePhotoChange } from "../world/loreArt";
import { createLoreObject, playLoreTape, type LoreObject } from "../world/lorePage";
import { applyVhsEffect } from "../world/vhsMaterial";
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

/** Vitrine de l'archive sur la page de droite : centre (px du panneau), taille (m) et avancée devant le panneau. */
const DISPLAY_CENTER = { x: RIGHT_PAGE.x + RIGHT_PAGE.w / 2, y: 300 };
const DISPLAY_SIZE = 0.14;
const DISPLAY_DEPTH = 0.05;
/** Zone de la vitrine (px du panneau) : viser dedans + grip ou gâchette prend l'objet. */
const DISPLAY_RECT: Rect = { x: DISPLAY_CENTER.x - 190, y: DISPLAY_CENTER.y - 190, w: 380, h: 380 };
/** Main tendue vers l'objet (sans viser) + grip : on le prend aussi directement. */
const REACH_RADIUS = 0.14;
/** Objet visé ou main tendue : il grossit un peu, comme une case d'inventaire survolée. */
const HOVER_SCALE = 1.2;
/** Lumière d'appoint de la vitrine : lointaine et douce, sinon le papier blanc brûle et le texte devient illisible. */
const DISPLAY_LIGHT_DEPTH = 0.3;
const DISPLAY_LIGHT_INTENSITY = 0.2;
/** Papier et photo ont déjà leur texture en émission : en vitrine, on la baisse pour qu'ils ne brûlent pas. */
const DISPLAY_PRINT_EMISSIVE = 0.12;
/** Vitesse de rattrapage (position, rotation, taille) : l'objet vole vers la main, puis revient dans sa vitrine. */
const FOLLOW_LAMBDA = 16;

/** Face vers le lecteur, haut du contenu vers le haut (le recto des objets est +Y, son haut -Z). */
const FACE_FORWARD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/** Archive exposée dans la vitrine : l'objet ramassé, que la main peut saisir puis qui y revient toujours. */
interface Display {
  fragment: number;
  object: LoreObject;
  pivot: THREE.Group;
  /** Orientation de repos : le recto (face de lecture) vers le lecteur, haut du contenu vers le haut. */
  restOrientation: THREE.Quaternion;
  /** Feuille/photo (recto +Y, haut -Z) ou objet debout comme la cassette (face +Z, haut +Y). */
  flat: boolean;
  restScale: number;
  materials: THREE.Material[];
}


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
  private display: Display | null = null;
  private displayToken = 0;
  private heldBy: Hand | null = null;
  /** Touche qui tient l'objet (il est lâché quand elle l'est). */
  private heldWith: "grip" | "trigger" = "grip";
  private heldOffset = new THREE.Quaternion();
  private time = 0;
  private readonly displayLight = new THREE.PointLight(0xffe6bd, DISPLAY_LIGHT_INTENSITY, 1.2, 2);
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchGroupQuaternion = new THREE.Quaternion();
  private readonly scratchUp = new THREE.Vector3();
  private readonly scratchTop = new THREE.Vector3();
  private readonly scratchSide = new THREE.Vector3();
  private readonly scratchMatrix = new THREE.Matrix4();

  constructor(
    private readonly camera: THREE.Camera,
    private readonly body: THREE.Object3D,
    private readonly lore: LoreJournal,
    private readonly sfx: Sfx,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "journal";
    onLanguageChange(() => this.invalidate());
    lore.onChange(() => {
      this.invalidate();
      this.refreshDisplay();
    });
    onLorePhotoChange(() => {
      if (loreFormat(this.display?.fragment ?? 0) === "polaroid") this.refreshDisplay(true);
    });
    this.displayLight.position.set(...this.displayPoint(DISPLAY_LIGHT_DEPTH));
    this.group.add(this.displayLight);
  }

  /** Point de la vitrine dans le repère du panneau (m). */
  private displayPoint(depth: number): [number, number, number] {
    return [(DISPLAY_CENTER.x / CANVAS_W - 0.5) * WIDTH, HEIGHT / 2 - (DISPLAY_CENTER.y / CANVAS_H) * HEIGHT, depth];
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
    this.heldBy = null;
    this.group.visible = false;
    this.sfx.play("click", 0.25);
  }

  private show(): void {
    log("journal", { action: "open" });
    this.group.visible = true;
    // Ouvert sur la dernière archive lue (la plus récente), sinon sur la première à trouver.
    this.selected = Math.max(0, Math.min(this.lore.count, LORE_FRAGMENT_COUNT) - 1);
    this.refreshDisplay();
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

  onPress(hand: Hand, px: number, py: number, button: PressButton): boolean {
    // Grip ou gâchette sur la vitrine : l'objet vient dans la main.
    if (this.display && inRect(DISPLAY_RECT, px, py)) {
      this.grab(hand, button);
      return true;
    }
    if (button !== "trigger") return true;
    const id = this.hitAt(px, py);
    if (!id) return true;
    this.sfx.play("click", 0.35);
    this.activate(id);
    this.invalidate();
    return true;
  }

  /**
   * Met en vitrine l'objet de l'archive choisie (feuille, polaroïd, cassette), à la manière d'une
   * case d'inventaire. Sans effet si c'est déjà lui ; `force` le recrée (photo qui vient d'arriver).
   */
  private refreshDisplay(force = false): void {
    const known = Math.min(this.lore.count, LORE_FRAGMENT_COUNT);
    const wanted = this.visible && this.selected < known ? this.selected : null;
    if (!force && (this.display?.fragment ?? null) === wanted) return;
    const token = ++this.displayToken;
    this.clearDisplay();
    if (wanted === null) return;
    createLoreObject(wanted)
      .then((object) => {
        if (token !== this.displayToken) object.dispose();
        else this.mountDisplay(wanted, object);
      })
      .catch(() => {});
  }

  private clearDisplay(): void {
    const display = this.display;
    if (!display) return;
    this.heldBy = null;
    this.display = null;
    display.pivot.removeFromParent();
    for (const material of display.materials) material.dispose();
    display.object.dispose();
  }

  private mountDisplay(fragment: number, object: LoreObject): void {
    const shape = getModelShape(object.template);
    const size = shape.box.getSize(new THREE.Vector3());
    const center = shape.box.getCenter(new THREE.Vector3());
    const materials: THREE.Material[] = [];
    // Même traitement que les miniatures de l'inventaire : lisible quelle que soit la lumière de la zone.
    object.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const source = Array.isArray(child.material) ? child.material : [child.material];
      const clones = source.map((material: THREE.Material) => {
        const clone = material.clone();
        if (clone instanceof THREE.MeshStandardMaterial) {
          clone.emissiveIntensity = clone.emissiveMap ? Math.min(clone.emissiveIntensity, DISPLAY_PRINT_EMISSIVE) : Math.max(clone.emissiveIntensity, 0.08);
          applyVhsEffect(clone, { zoneLighting: false });
        }
        materials.push(clone);
        return clone;
      });
      child.material = Array.isArray(child.material) ? clones : clones[0]!;
    });
    object.model.position.copy(center).negate();
    const pivot = new THREE.Group();
    pivot.add(object.model);
    const restScale = DISPLAY_SIZE / Math.max(size.x, size.y, size.z, 0.01);
    pivot.position.set(...this.displayPoint(DISPLAY_DEPTH));
    pivot.scale.setScalar(restScale);
    // Face de lecture = l'axe le plus fin de l'objet : Y pour une feuille couchée, Z pour la cassette debout.
    const flat = size.y <= size.z;
    const restOrientation = flat ? FACE_FORWARD : new THREE.Quaternion();
    pivot.quaternion.copy(restOrientation);
    this.group.add(pivot);
    this.display = { fragment, object, pivot, restOrientation, flat, restScale, materials };
  }

  /** Saisie de l'objet de la vitrine : il vient dans la main (sans physique : il ne peut jamais tomber). */
  private grab(hand: Hand, button: PressButton): void {
    const display = this.display;
    if (!display || this.heldBy || hand.holding || !hand.tracked) return;
    // Pose de lecture : le recto face à la tête, le haut du contenu vers le haut ; elle suit ensuite le poignet.
    this.camera.getWorldPosition(this.scratchPosition);
    const normal = this.scratchPosition.sub(hand.palm).normalize();
    const up = this.scratchUp.set(0, 1, 0).addScaledVector(normal, -normal.y);
    if (up.lengthSq() < 1e-4) up.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    up.normalize();
    const side = this.scratchSide.crossVectors(up, normal);
    // Feuille : recto = Y du modèle, haut = -Z. Objet debout : face = Z du modèle, haut = Y.
    if (display.flat) this.scratchMatrix.makeBasis(side, normal, this.scratchTop.copy(up).negate());
    else this.scratchMatrix.makeBasis(side, up, normal);
    this.scratchQuaternion.setFromRotationMatrix(this.scratchMatrix);
    this.heldOffset.copy(hand.quaternion).invert().multiply(this.scratchQuaternion);
    this.heldWith = button === "trigger" ? "trigger" : "grip";
    this.heldBy = hand;
    hand.pulse(0.35, 30);
    this.sfx.play("grab", 0.35);
    log("journal", { action: "grab", fragment: display.fragment });
    if (loreFormat(display.fragment) === "audio") playLoreTape(display.fragment);
  }

  /**
   * Chaque frame : l'objet balance doucement dans sa vitrine ; saisi, il suit la main à taille réelle
   * (pour le lire, le retourner) ; lâché — ou main perdue — il revient toujours dans sa vitrine.
   */
  update(deltaSeconds: number, hands: Hand[]): void {
    this.time += deltaSeconds;
    const display = this.display;
    if (!this.visible || !display) return;
    this.group.updateWorldMatrix(true, false);
    const pivot = display.pivot;

    let hot = [...this.hovered.values()].includes("display");
    if (!this.heldBy) {
      pivot.getWorldPosition(this.scratchPosition);
      for (const hand of hands) {
        if (!hand.tracked || hand.holding) continue;
        const near = this.scratchPosition.distanceTo(hand.palm) < REACH_RADIUS;
        if (near) hot = true;
        if (near && hand.input.squeeze.justPressed) {
          this.grab(hand, "grip");
          break;
        }
      }
    }
    const held = this.heldBy;
    if (held && (!held.tracked || !(this.heldWith === "trigger" ? held.input.trigger.pressed : held.input.squeeze.pressed))) {
      this.heldBy = null;
      this.sfx.play("click", 0.2);
    }

    const blend = 1 - Math.exp(-FOLLOW_LAMBDA * deltaSeconds);
    if (this.heldBy) {
      this.group.getWorldQuaternion(this.scratchGroupQuaternion);
      this.scratchQuaternion.copy(this.heldBy.quaternion).multiply(this.heldOffset);
      this.scratchPosition.copy(this.heldBy.palm);
      this.group.worldToLocal(this.scratchPosition);
      this.scratchQuaternion.premultiply(this.scratchGroupQuaternion.invert());
      pivot.position.lerp(this.scratchPosition, blend);
      pivot.quaternion.slerp(this.scratchQuaternion, blend);
      pivot.scale.setScalar(THREE.MathUtils.lerp(pivot.scale.x, 1, blend));
    } else {
      const sway = Math.sin(this.time * (hot ? 2.2 : 0.9)) * (hot ? 0.35 : 0.5);
      this.scratchQuaternion.setFromAxisAngle(AXIS_Y, sway).multiply(display.restOrientation);
      this.scratchPosition.set(...this.displayPoint(DISPLAY_DEPTH));
      pivot.position.lerp(this.scratchPosition, blend);
      pivot.quaternion.slerp(this.scratchQuaternion, blend);
      pivot.scale.setScalar(THREE.MathUtils.lerp(pivot.scale.x, display.restScale * (hot ? HOVER_SCALE : 1), blend));
    }
  }

  private hitAt(px: number, py: number): string | null {
    return this.hitRects.find((hit) => inRect(hit.rect, px, py))?.id ?? (this.display && inRect(DISPLAY_RECT, px, py) ? "display" : null);
  }

  private activate(id: string): void {
    if (id === "tab:close") {
      this.close();
      return;
    }
    if (id.startsWith("tape:")) {
      this.selected = Number(id.slice(5));
      this.refreshDisplay();
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
      // L'archive elle-même est l'objet en vitrine (voir `mountDisplay`) : rien à écrire ici.
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
}
