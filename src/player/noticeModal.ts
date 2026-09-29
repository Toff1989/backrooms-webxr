import * as THREE from "three";
import { t, type TranslationKey } from "../i18n";
import { fitFont } from "../ui/uiPanel";
import type { Sfx } from "./sfx";

export type NoticeKind = "achievement" | "lore";

// Compact et sous le bandeau du HUD caméscope (qui occupe le haut du champ, voir camcorderHud.ts).
const WIDTH_METERS = 0.32;
const HEIGHT_METERS = 0.118;
const CANVAS_W = 920;
const CANVAS_H = Math.round((CANVAS_W * HEIGHT_METERS) / WIDTH_METERS);
const POSITION = new THREE.Vector3(0, 0.02, -0.55);

/** Pop-in élastique bref, tenu, puis fondu — jamais un simple "apparaît/disparaît". */
const POP_SECONDS = 0.22;
const HOLD_SECONDS = 3.2;
const FADE_SECONDS = 0.6;
const TOTAL_SECONDS = POP_SECONDS + HOLD_SECONDS + FADE_SECONDS;

interface NoticeStyle {
  accent: string;
  icon: string;
  labelKey: TranslationKey;
  sound: "unlock" | "discovery";
}
const STYLES: Record<NoticeKind, NoticeStyle> = {
  achievement: { accent: "#ffd76a", icon: "★", labelKey: "notice.achievementLabel", sound: "unlock" },
  lore: { accent: "#7fc4e8", icon: "▣", labelKey: "notice.loreLabel", sound: "discovery" },
};

/** Amorti élastique (overshoot léger) : un pop-in qui a du corps plutôt qu'un fondu linéaire. */
function easeOutBack(p: number): number {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/**
 * Bandeau de notification bien visible (succès débloqué, archive trouvée), distinct du HUD
 * discret : plaque dédiée collée à la caméra, pop-in/fondu, son procédural (voir sfx.ts). Les
 * cassettes ont leur propre modal persistant (voir tapeSignalModal.ts) — celui-ci ne fait
 * qu'annoncer la trouvaille, pas la lecture.
 */
export class NoticeModal {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private timer = TOTAL_SECONDS;
  private kind: NoticeKind = "lore";
  private title = "";
  private subtitle = "";

  constructor(camera: THREE.Camera, private readonly sfx: Sfx) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Contexte 2D indisponible pour le bandeau de notification");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH_METERS, HEIGHT_METERS), this.material);
    this.mesh.position.copy(POSITION);
    // Au-dessus du HUD (997/998) : une notification ne doit jamais se retrouver masquée derrière.
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    camera.add(this.mesh);
  }

  /** Annonce une trouvaille/un succès ; interrompt et remplace toute notification déjà affichée. */
  show(kind: NoticeKind, title: string, subtitle = ""): void {
    this.kind = kind;
    this.title = title;
    this.subtitle = subtitle;
    this.timer = 0;
    this.mesh.visible = true;
    this.sfx.play(STYLES[kind].sound, 0.65);
    this.redraw();
  }

  update(deltaSeconds: number): void {
    if (!this.mesh.visible) return;
    this.timer += deltaSeconds;
    if (this.timer >= TOTAL_SECONDS) {
      this.mesh.visible = false;
      return;
    }
    let scale = 1;
    let opacity = 1;
    if (this.timer < POP_SECONDS) {
      const p = this.timer / POP_SECONDS;
      scale = 0.7 + 0.3 * easeOutBack(p);
      opacity = p;
    } else if (this.timer > POP_SECONDS + HOLD_SECONDS) {
      opacity = 1 - (this.timer - POP_SECONDS - HOLD_SECONDS) / FADE_SECONDS;
    }
    this.mesh.scale.setScalar(Math.max(0, scale));
    this.material.opacity = THREE.MathUtils.clamp(opacity, 0, 1);
  }

  private redraw(): void {
    const ctx = this.ctx;
    const style = STYLES[this.kind];
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.roundRect(4, 4, width - 8, height - 8, 26);
    ctx.fillStyle = "rgba(10, 9, 6, 0.92)";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = style.accent;
    ctx.stroke();

    ctx.textBaseline = "middle";
    ctx.font = "56px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = style.accent;
    ctx.fillText(style.icon, 84, height / 2);

    ctx.textAlign = "left";
    ctx.fillStyle = style.accent;
    fitFont(ctx, t(style.labelKey), width - 160 - 36, 26, 16, "bold ");
    ctx.fillText(t(style.labelKey), 160, height * 0.32);
    const textWidth = width - 160 - 36;
    ctx.fillStyle = "#f4f1e8";
    fitFont(ctx, this.title, textWidth, 34, 20, "bold ");
    ctx.fillText(this.title, 160, height * 0.62);
    if (this.subtitle) {
      ctx.fillStyle = "#c9c0aa";
      fitFont(ctx, this.subtitle, textWidth, 22, 16);
      ctx.fillText(this.subtitle, 160, height * 0.86);
    }

    this.texture.needsUpdate = true;
  }
}
