import * as THREE from "three";
import { onLanguageChange, t } from "../i18n";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import { ACHIEVEMENTS, type AchievementCategory, type AchievementDefinition } from "../world/achievementDefs";
import type { AchievementTracker } from "../world/achievements";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.72;
const HEIGHT = 0.62;
const PX_PER_M = 1350;
const DISTANCE = 0.85;

const ROWS_PER_PAGE = 5;
const ROW_HEIGHT = 96;
const ROW_GAP = 8;
const ROW_X = 40;
const ROW_Y0 = 150;
const ROW_W = 892;
const NAV_Y = 738;

type ButtonId = "prev" | "next" | "back";

const NAV_BUTTONS: Record<ButtonId, Rect> = {
  prev: { x: ROW_X, y: NAV_Y, w: 90, h: 64 },
  next: { x: ROW_X + 90 + 120, y: NAV_Y, w: 90, h: 64 },
  back: { x: ROW_X + ROW_W - 300, y: NAV_Y, w: 300, h: 64 },
};

const CATEGORY_ORDER: AchievementCategory[] = ["exploration", "survival", "collection", "lore", "mastery", "account", "secret"];

/** Ordre d'affichage stable : par catégorie, puis par difficulté croissante. */
const SORTED_ACHIEVEMENTS: AchievementDefinition[] = [...ACHIEVEMENTS].sort((a, b) => {
  const categoryDelta = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
  return categoryDelta !== 0 ? categoryDelta : a.tier - b.tier;
});
const PAGE_COUNT = Math.ceil(SORTED_ACHIEVEMENTS.length / ROWS_PER_PAGE);

const TIER_COLOR: Record<AchievementDefinition["tier"], string> = { 1: "#b9b2a0", 2: "#7fc4e8", 3: "#e8c34a", 4: "#e06a5a" };

/**
 * Menu des succès : consultation seule (aucune action à choisir, contrairement aux autres
 * panneaux) — liste paginée (voir inventoryMenu.ts pour le même principe de pages), triée par
 * catégorie puis par difficulté. Un succès verrouillé affiche quand même son objectif (pas de
 * secret à deviner), grisé ; débloqué, il affiche son bonus permanent en plus.
 */
export class AchievementsMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();
  private page = 0;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly worldParent: THREE.Object3D,
    private readonly sfx: Sfx,
    private readonly tracker: AchievementTracker,
    private readonly onBack: () => void,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "achievements-menu";
    onLanguageChange(() => this.invalidate());
    this.tracker.onChange(() => this.invalidate());
  }

  open(): void {
    this.worldParent.add(this.group);
    this.page = 0;
    this.placeInFrontOfHead();
    this.group.visible = true;
    this.invalidate();
  }

  close(): void {
    this.group.visible = false;
  }

  private placeInFrontOfHead(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.05, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
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
    if (id === "prev") this.page = (this.page - 1 + PAGE_COUNT) % PAGE_COUNT;
    else if (id === "next") this.page = (this.page + 1) % PAGE_COUNT;
    else if (id === "back") {
      this.close();
      this.onBack();
    }
    this.invalidate();
    return true;
  }

  private buttonAt(px: number, py: number): ButtonId | null {
    for (const [id, rect] of Object.entries(NAV_BUTTONS) as Array<[ButtonId, Rect]>) if (inRect(rect, px, py)) return id;
    return null;
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    const width = this.canvas.width;
    drawPanelBackground(ctx, width, this.canvas.height);
    const hovered = new Set(this.hovered.values());

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff6b5a";
    ctx.font = "bold 40px monospace";
    ctx.fillText(t("achievements.title"), width / 2, 62);
    ctx.font = "22px monospace";
    ctx.fillStyle = "#a79d86";
    ctx.fillText(t("achievements.progress", { count: this.tracker.unlockedCount, total: SORTED_ACHIEVEMENTS.length }), width / 2, 104);

    const start = this.page * ROWS_PER_PAGE;
    const rows = SORTED_ACHIEVEMENTS.slice(start, start + ROWS_PER_PAGE);
    rows.forEach((definition, index) => {
      const y = ROW_Y0 + index * (ROW_HEIGHT + ROW_GAP);
      this.drawRow(ctx, definition, ROW_X, y);
    });

    ctx.font = "22px monospace";
    ctx.fillStyle = "#a79d86";
    ctx.textAlign = "center";
    ctx.fillText(`${this.page + 1} / ${PAGE_COUNT}`, ROW_X + 90 + 60, NAV_Y + 32);

    drawButton(ctx, NAV_BUTTONS.prev, "◀", { hovered: hovered.has("prev") });
    drawButton(ctx, NAV_BUTTONS.next, "▶", { hovered: hovered.has("next") });
    drawButton(ctx, NAV_BUTTONS.back, t("settings.back"), { hovered: hovered.has("back") });
  }

  private drawRow(ctx: CanvasRenderingContext2D, definition: AchievementDefinition, x: number, y: number): void {
    const unlocked = this.tracker.unlockedIds.has(definition.id);
    ctx.fillStyle = unlocked ? "rgba(159, 227, 159, 0.1)" : "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(x, y, ROW_W, ROW_HEIGHT);
    ctx.strokeStyle = unlocked ? "#9fe39f" : "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, ROW_W, ROW_HEIGHT);

    // Puce de difficulté (couleur), à gauche.
    ctx.fillStyle = TIER_COLOR[definition.tier];
    ctx.fillRect(x, y, 10, ROW_HEIGHT);

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "bold 26px monospace";
    ctx.fillStyle = unlocked ? "#ffe89a" : "#8a8272";
    ctx.fillText(`${unlocked ? "✓" : "▢"} ${t(definition.titleKey)}`, x + 30, y + 30);

    ctx.font = "21px monospace";
    ctx.fillStyle = unlocked ? "#e2d8bf" : "#7c7565";
    wrapText(ctx, t(definition.descriptionKey), x + 30, y + 60, ROW_W - 60, 24, 2);

    if (unlocked && definition.perk) {
      ctx.textAlign = "right";
      ctx.font = "18px monospace";
      ctx.fillStyle = "#9fe39f";
      ctx.fillText(this.perkLabel(definition), x + ROW_W - 20, y + 30);
      ctx.textAlign = "left";
    }
  }

  private perkLabel(definition: AchievementDefinition): string {
    const perk = definition.perk;
    if (!perk) return "";
    if (perk.cosmetic) return t("achievements.cosmetic");
    const parts: string[] = [];
    if (perk.batteryCapacity) parts.push(`${t("achievements.perkBattery")} +${Math.round(perk.batteryCapacity * 100)}%`);
    if (perk.sprintRecovery) parts.push(`${t("achievements.perkSprint")} +${Math.round(perk.sprintRecovery * 100)}%`);
    if (perk.corruptionDecay) parts.push(`${t("achievements.perkCorruption")} +${Math.round(perk.corruptionDecay * 100)}%`);
    if (perk.beaconSteadiness) parts.push(`${t("achievements.perkBeacon")} +${Math.round(perk.beaconSteadiness * 100)}%`);
    return parts.join(" · ");
  }
}
