import * as THREE from "three";
import { loreFragment, onLanguageChange, t, type TranslationKey } from "../i18n";
import { LORE_FRAGMENT_COUNT } from "../shared/lore";
import { drawButton, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import { drawAgedPaper, drawLoreText, HANDWRITING_FONT } from "../world/lorePage";
import type { LoreJournal } from "../world/loreJournal";
import { confirmPairing, startPairing, type PairingRequest } from "../world/playerIdentity";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.44;
const HEIGHT = 0.3;
const PX_PER_M = 2400;
const CANVAS_W = Math.round(WIDTH * PX_PER_M);
const CANVAS_H = Math.round(HEIGHT * PX_PER_M);

const LEFT_PAGE: Rect = { x: 30, y: 30, w: 488, h: 570 };
const RIGHT_PAGE: Rect = { x: CANVAS_W - 30 - 488, y: 30, w: 488, h: 570 };
const TAB_BUTTONS: Record<"tapes" | "record" | "close", Rect> = {
  tapes: { x: 30, y: 624, w: 230, h: 66 },
  record: { x: 272, y: 624, w: 380, h: 66 },
  close: { x: CANVAS_W - 30 - 230, y: 624, w: 230, h: 66 },
};
const INDEX_TOP = 128;
const INDEX_ROW = 29;

/** Carnet tenu en main : devant la paume, décalé du côté opposé à la main, tourné vers les yeux. */
const HAND_UP = 0.1;
const HAND_SIDE = 0.2;
const HAND_TOWARD_HEAD = 0.06;
const FLOAT_DISTANCE = 0.55;

/** Zone "ceinture" (relative à la tête) où la main attrape le journal, comme dans Saints & Sinners. */
const HIP_DROP_MIN = 0.42;
const HIP_DROP_MAX = 0.98;
const HIP_RADIUS = 0.34;
const HIP_MAX_FORWARD = 0.16;

type Tab = "tapes" | "record";
type PairState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "showing"; request: PairingRequest }
  | { kind: "entering"; digits: string }
  | { kind: "confirming" };

const KEYPAD_TOP = 172;
const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"] as const;

const tmpHead = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpOffset = new THREE.Vector3();

/**
 * Journal des bandes perdues : un carnet qu'on prend à la ceinture (grip, main à la hanche) et
 * qu'on garde en main tant que le grip est tenu, ou qu'on ouvre depuis le menu d'inventaire (il
 * flotte alors devant soi). L'autre main tourne les pages au pointeur (gâchette).
 * - Onglet BANDES : l'index des 16 bandes (lues ou encore perdues), et la bande choisie écrite
 *   à la main sur la page de droite.
 * - Onglet ENREGISTREMENT : le code de cassette (retrouver ses bandes et scores ailleurs), les
 *   meilleures runs, et le jumelage façon télé (afficher un code / confirmer celui d'un autre).
 */
export class Journal extends UiPanel {
  private tab: Tab = "tapes";
  private selected = 0;
  private heldBy: Hand | null = null;
  private pair: PairState = { kind: "idle" };
  private status: { key: TranslationKey; good: boolean } | null = null;
  private readonly hovered = new Map<Hand, string | null>();
  private hitRects: Array<{ id: string; rect: Rect }> = [];
  private readonly inHipZone = new Map<Hand, boolean>();

  constructor(
    private readonly camera: THREE.Camera,
    private readonly body: THREE.Object3D,
    private readonly scene: THREE.Scene,
    private readonly lore: LoreJournal,
    private readonly sfx: Sfx,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "journal";
    onLanguageChange(() => this.invalidate());
    lore.onChange(() => this.invalidate());
  }

  /** La main est-elle à la ceinture (zone de prise du journal) ? */
  isAtHip(hand: Hand): boolean {
    this.camera.getWorldPosition(tmpHead);
    const drop = tmpHead.y - hand.palm.y;
    if (drop < HIP_DROP_MIN || drop > HIP_DROP_MAX) return false;
    tmpOffset.subVectors(hand.palm, tmpHead).setY(0);
    if (tmpOffset.length() > HIP_RADIUS) return false;
    this.camera.getWorldDirection(tmpForward).setY(0).normalize();
    return tmpOffset.dot(tmpForward) < HIP_MAX_FORWARD;
  }

  /** Grip à la ceinture : le journal vient dans la main, tant que le grip est tenu. */
  openInHand(hand: Hand): void {
    this.heldBy = hand;
    if (this.group.parent !== this.scene) this.scene.add(this.group);
    this.show();
    hand.pulse(0.4, 40);
    this.placeInHand();
  }

  /** Depuis le menu : le journal flotte devant le joueur. */
  openFloating(): void {
    this.heldBy = null;
    if (this.group.parent !== this.body) this.body.add(this.group);
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * FLOAT_DISTANCE, head.y - 0.12, head.z + forward.z * FLOAT_DISTANCE);
    this.group.rotation.set(-0.2, Math.atan2(-forward.x, -forward.z), 0, "YXZ");
    this.show();
  }

  close(): void {
    if (!this.visible) return;
    this.group.visible = false;
    this.heldBy = null;
    if (this.pair.kind === "showing") this.pair.request.cancel();
    if (this.pair.kind !== "idle") this.pair = { kind: "idle" };
    this.sfx.play("click", 0.25);
  }

  private show(): void {
    this.group.visible = true;
    // Ouvert sur la dernière bande lue (la plus récente), sinon sur la première à trouver.
    this.selected = Math.max(0, Math.min(this.lore.count, LORE_FRAGMENT_COUNT) - 1);
    this.status = null;
    this.sfx.play("take", 0.35);
    this.invalidate();
    void this.lore.sync();
  }

  /** Chaque frame : suit la main qui le tient (et se referme au relâchement), signale la ceinture. */
  update(hands: Hand[], isHandFree: (hand: Hand) => boolean): void {
    for (const hand of hands) {
      const inZone = hand.tracked && hand !== this.heldBy && isHandFree(hand) && this.isAtHip(hand);
      if (inZone && !this.inHipZone.get(hand)) hand.pulse(0.12, 15);
      this.inHipZone.set(hand, inZone);
    }
    if (!this.visible || !this.heldBy) return;
    if (!this.heldBy.tracked || !this.heldBy.input.squeeze.pressed) {
      this.close();
      return;
    }
    this.placeInHand();
  }

  private placeInHand(): void {
    const hand = this.heldBy;
    if (!hand) return;
    this.camera.getWorldPosition(tmpHead);
    this.camera.getWorldDirection(tmpForward);
    tmpRight.crossVectors(tmpForward, THREE.Object3D.DEFAULT_UP).setY(0).normalize();
    const side = hand.input.handedness === "left" ? 1 : -1;
    tmpOffset.subVectors(tmpHead, hand.palm).normalize().multiplyScalar(HAND_TOWARD_HEAD);
    this.group.position.copy(hand.palm).addScaledVector(tmpRight, side * HAND_SIDE).add(tmpOffset);
    this.group.position.y += HAND_UP;
    this.group.lookAt(tmpHead);
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
    if (id === "tab:tapes" || id === "tab:record") {
      this.tab = id === "tab:tapes" ? "tapes" : "record";
      this.status = null;
      return;
    }
    if (id === "tab:close") {
      this.close();
      return;
    }
    if (id.startsWith("tape:")) {
      this.selected = Number(id.slice(5));
      return;
    }
    if (id === "pair:start") this.beginShowingCode();
    else if (id === "pair:enter") {
      this.pair = { kind: "entering", digits: "" };
      this.status = null;
    } else if (id === "pair:cancel") {
      if (this.pair.kind === "showing") this.pair.request.cancel();
      this.pair = { kind: "idle" };
    } else if (id.startsWith("key:") && this.pair.kind === "entering") {
      const key = id.slice(4);
      if (key === "⌫") this.pair.digits = this.pair.digits.slice(0, -1);
      else if (key === "OK") this.submitCode(this.pair.digits);
      else if (this.pair.digits.length < 6) this.pair.digits += key;
    }
  }

  private beginShowingCode(): void {
    this.pair = { kind: "requesting" };
    this.status = null;
    void startPairing((success) => {
      this.pair = { kind: "idle" };
      this.status = success ? { key: "pair.success", good: true } : { key: "pair.failed", good: false };
      if (success) void this.lore.sync();
      this.invalidate();
    }).then((request) => {
      if (this.pair.kind !== "requesting") {
        request?.cancel();
        return;
      }
      if (request) this.pair = { kind: "showing", request };
      else {
        this.pair = { kind: "idle" };
        this.status = { key: "pair.unavailable", good: false };
      }
      this.invalidate();
    });
  }

  private submitCode(digits: string): void {
    if (digits.length !== 6) return;
    this.pair = { kind: "confirming" };
    void confirmPairing(digits).then((ok) => {
      this.pair = { kind: "idle" };
      this.status = ok ? { key: "pair.confirmed", good: true } : { key: "pair.badCode", good: false };
      if (ok) void this.lore.sync();
      this.invalidate();
    });
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    this.hitRects = [];
    this.drawCover(ctx);
    drawAgedPaper(ctx, LEFT_PAGE.x, LEFT_PAGE.y, LEFT_PAGE.w, LEFT_PAGE.h, 101, false);
    drawAgedPaper(ctx, RIGHT_PAGE.x, RIGHT_PAGE.y, RIGHT_PAGE.w, RIGHT_PAGE.h, 202 + this.selected, this.tab === "tapes");
    this.drawGutter(ctx);
    if (this.tab === "tapes") this.drawTapes(ctx);
    else this.drawRecord(ctx);

    const hovered = new Set(this.hovered.values());
    for (const [id, rect] of Object.entries(TAB_BUTTONS)) {
      const key = `tab:${id}`;
      const label = id === "tapes" ? t("journal.tapesTab") : id === "record" ? t("journal.recordTab") : t("journal.close");
      drawButton(ctx, rect, label, { hovered: hovered.has(key), accent: id === this.tab ? "#e8c34a" : undefined });
      this.hitRects.push({ id: key, rect });
    }
  }

  private drawCover(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.beginPath();
    ctx.roundRect(4, 4, CANVAS_W - 8, CANVAS_H - 8, 22);
    ctx.fillStyle = "#2a1c13";
    ctx.fill();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(214, 170, 110, 0.5)";
    ctx.beginPath();
    ctx.roundRect(14, 14, CANVAS_W - 28, CANVAS_H - 28, 16);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawGutter(ctx: CanvasRenderingContext2D): void {
    const middle = CANVAS_W / 2;
    const shadow = ctx.createLinearGradient(middle - 24, 0, middle + 24, 0);
    shadow.addColorStop(0, "rgba(0, 0, 0, 0)");
    shadow.addColorStop(0.5, "rgba(0, 0, 0, 0.45)");
    shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = shadow;
    ctx.fillRect(middle - 24, LEFT_PAGE.y, 48, LEFT_PAGE.h);
  }

  private heading(ctx: CanvasRenderingContext2D, page: Rect, text: string): void {
    ctx.fillStyle = "#3a2f22";
    ctx.font = `bold 30px "Courier New", monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, page.x + 30, page.y + 56);
  }

  private drawTapes(ctx: CanvasRenderingContext2D): void {
    const count = this.lore.count;
    this.heading(ctx, LEFT_PAGE, t("journal.title"));
    ctx.font = `22px "Courier New", monospace`;
    ctx.textAlign = "right";
    ctx.fillText(t("journal.progress", { count, total: LORE_FRAGMENT_COUNT }), LEFT_PAGE.x + LEFT_PAGE.w - 26, LEFT_PAGE.y + 56);

    const hovered = new Set(this.hovered.values());
    for (let index = 0; index < LORE_FRAGMENT_COUNT; index++) {
      const rect: Rect = { x: LEFT_PAGE.x + 20, y: LEFT_PAGE.y + INDEX_TOP + index * INDEX_ROW - 22, w: LEFT_PAGE.w - 40, h: INDEX_ROW };
      const known = index < count;
      if (index === this.selected) {
        ctx.fillStyle = "rgba(232, 195, 74, 0.45)";
        ctx.fillRect(rect.x, rect.y + 2, rect.w, rect.h - 2);
      } else if (hovered.has(`tape:${index}`)) {
        ctx.fillStyle = "rgba(232, 195, 74, 0.2)";
        ctx.fillRect(rect.x, rect.y + 2, rect.w, rect.h - 2);
      }
      ctx.textAlign = "left";
      ctx.fillStyle = known ? "#3a2f22" : "rgba(58, 47, 34, 0.4)";
      ctx.font = `bold 20px "Courier New", monospace`;
      const label = `n°${String(index + 1).padStart(2, "0")}`;
      ctx.fillText(label, rect.x + 8, rect.y + 21);
      ctx.font = known ? `20px ${HANDWRITING_FONT}` : `20px "Courier New", monospace`;
      ctx.fillStyle = known ? "#1c2753" : "rgba(58, 47, 34, 0.35)";
      const text = known ? (loreFragment(index) ?? "") : "— — — — — —";
      ctx.fillText(ellipsize(ctx, text, rect.w - 90), rect.x + 78, rect.y + 21);
      this.hitRects.push({ id: `tape:${index}`, rect });
    }

    if (this.selected < count) {
      drawLoreText(ctx, RIGHT_PAGE.x, RIGHT_PAGE.y, RIGHT_PAGE.w, this.selected, 34);
      if (count >= LORE_FRAGMENT_COUNT && this.selected === LORE_FRAGMENT_COUNT - 1) this.note(ctx, RIGHT_PAGE, t("lore.end"), 480);
    } else {
      this.heading(ctx, RIGHT_PAGE, t("lore.title", { n: this.selected + 1 }));
      this.note(ctx, RIGHT_PAGE, count === 0 ? t("journal.none") : t("journal.locked"), 200);
    }
  }

  private note(ctx: CanvasRenderingContext2D, page: Rect, text: string, y: number, color = "#5a4a36", size = 24): void {
    ctx.fillStyle = color;
    ctx.font = `${size}px "Courier New", monospace`;
    ctx.textAlign = "left";
    wrapText(ctx, text, page.x + 34, page.y + y, page.w - 68, Math.round(size * 1.3), 6);
  }

  private drawRecord(ctx: CanvasRenderingContext2D): void {
    const profile = this.lore.serverProfile;
    this.heading(ctx, LEFT_PAGE, t("journal.codeTitle"));

    // Étiquette de cassette : le code de récupération, bien lisible.
    const label: Rect = { x: LEFT_PAGE.x + 30, y: LEFT_PAGE.y + 84, w: LEFT_PAGE.w - 60, h: 110 };
    ctx.fillStyle = "#f3ecd8";
    ctx.fillRect(label.x, label.y, label.w, label.h);
    ctx.fillStyle = "#c0392b";
    ctx.fillRect(label.x, label.y + 12, label.w, 10);
    ctx.fillRect(label.x, label.y + label.h - 22, label.w, 10);
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `bold 50px "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.fillText(profile?.recoveryCode ?? "K7-····-····", label.x + label.w / 2, label.y + 76);
    this.note(ctx, LEFT_PAGE, profile ? t("journal.codeHelp") : t("journal.offline"), 234, undefined, 21);

    this.heading(ctx, { ...LEFT_PAGE, y: LEFT_PAGE.y + 392 }, t("journal.best"));
    ctx.font = `22px "Courier New", monospace`;
    ctx.textAlign = "left";
    ctx.fillStyle = "#3a2f22";
    const runs = profile?.bestRuns ?? [];
    if (runs.length === 0) ctx.fillText(t("journal.noRuns"), LEFT_PAGE.x + 34, LEFT_PAGE.y + 490);
    runs.slice(0, 4).forEach((run, index) => {
      const y = LEFT_PAGE.y + 490 + index * 26;
      ctx.textAlign = "left";
      ctx.fillText(`${index + 1}. ${run.pseudo}`, LEFT_PAGE.x + 34, y);
      ctx.textAlign = "right";
      ctx.fillText(t("end.levelShort", { n: run.depth }), LEFT_PAGE.x + LEFT_PAGE.w - 34, y);
    });

    this.drawPairing(ctx);
  }

  private drawPairing(ctx: CanvasRenderingContext2D): void {
    const page = RIGHT_PAGE;
    this.heading(ctx, page, t("journal.otherDevice"));
    const hovered = new Set(this.hovered.values());
    const button = (id: string, rect: Rect, label: string, accent?: string): void => {
      drawButton(ctx, rect, label, { hovered: hovered.has(id), accent: accent ?? "#8a5a2b" });
      this.hitRects.push({ id, rect });
    };
    const wide = (y: number): Rect => ({ x: page.x + 30, y: page.y + y, w: page.w - 60, h: 62 });

    const pair = this.pair;
    if (pair.kind === "idle" || pair.kind === "requesting") {
      button("pair:start", wide(88), t("pair.start"));
      this.note(ctx, page, t("pair.startHelp"), 186);
      button("pair:enter", wide(290), t("pair.confirm"));
      this.note(ctx, page, t("pair.confirmHelp"), 388);
    } else if (pair.kind === "showing") {
      ctx.fillStyle = "#1a1a1a";
      ctx.font = `bold 84px "Courier New", monospace`;
      ctx.textAlign = "center";
      ctx.fillText(`${pair.request.code.slice(0, 3)} ${pair.request.code.slice(3)}`, page.x + page.w / 2, page.y + 170);
      this.note(ctx, page, t("pair.showHelp"), 226);
      this.note(ctx, page, t("pair.waiting"), 400, "#8a5a2b");
      button("pair:cancel", wide(470), t("pair.cancel"));
    } else if (pair.kind === "entering" || pair.kind === "confirming") {
      const digits = pair.kind === "entering" ? pair.digits : "······";
      ctx.fillStyle = "#1a1a1a";
      ctx.font = `bold 54px "Courier New", monospace`;
      ctx.textAlign = "center";
      ctx.fillText(digits.padEnd(6, "_").split("").join(" "), page.x + page.w / 2, page.y + 128);
      const keyW = 118;
      const keyH = 64;
      KEYPAD.forEach((key, index) => {
        const rect: Rect = { x: page.x + 40 + (index % 3) * (keyW + 12), y: page.y + KEYPAD_TOP + Math.floor(index / 3) * (keyH + 10), w: keyW, h: keyH };
        button(`key:${key}`, rect, key, key === "OK" ? "#3f8a3f" : undefined);
      });
      button("pair:cancel", { x: page.x + 40, y: page.y + KEYPAD_TOP + 4 * (keyH + 10), w: keyW * 3 + 24, h: 56 }, t("pair.cancel"));
    }
    if (this.status) this.note(ctx, page, t(this.status.key), 530, this.status.good ? "#2f6b2f" : "#9a2f22");
  }
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
