import * as THREE from "three";
import { onLanguageChange, t, type TranslationKey } from "../i18n";
import { confirmPairing, startPairing, type PairingRequest } from "../world/playerIdentity";
import { drawButton, drawPanelBackground, inRect, UiPanel, wrapText, type PressButton, type Rect } from "../ui/uiPanel";
import type { LoreJournal } from "../world/loreJournal";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

const WIDTH = 0.62;
const HEIGHT = 0.62;
const PX_PER_M = 1500;
const DISTANCE = 0.72;
const CANVAS_W = Math.round(WIDTH * PX_PER_M);
const CANVAS_H = Math.round(HEIGHT * PX_PER_M);

const BUTTONS: Record<"start" | "enter" | "cancel" | "back", Rect> = {
  start: { x: 90, y: 230, w: 750, h: 70 },
  enter: { x: 90, y: 330, w: 750, h: 70 },
  cancel: { x: 90, y: 760, w: 220, h: 62 },
  back: { x: 340, y: 760, w: 500, h: 62 },
};

const KEYPAD_TOP = 405;
const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"] as const;

type PairState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "showing"; request: PairingRequest }
  | { kind: "entering"; digits: string }
  | { kind: "confirming" };

type ButtonId = "start" | "enter" | "cancel" | "back" | `key:${string}`;

export class DeviceMenu extends UiPanel {
  private readonly hovered = new Map<Hand, ButtonId | null>();
  private pair: PairState = { kind: "idle" };
  private status: { key: TranslationKey; good: boolean } | null = null;

  constructor(
    private readonly camera: THREE.Camera,
    parent: THREE.Object3D,
    private readonly lore: LoreJournal,
    private readonly sfx: Sfx,
    private readonly onBack: () => void,
  ) {
    super(WIDTH, HEIGHT, PX_PER_M);
    this.group.name = "device-menu";
    parent.add(this.group);
    onLanguageChange(() => this.invalidate());
    lore.onChange(() => this.invalidate());
  }

  open(): void {
    const head = this.camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.group.position.set(head.x + forward.x * DISTANCE, head.y - 0.04, head.z + forward.z * DISTANCE);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    this.pair = { kind: "idle" };
    this.status = null;
    this.group.visible = true;
    this.invalidate();
    void this.lore.sync();
  }

  close(): void {
    if (this.pair.kind === "showing") this.pair.request.cancel();
    this.pair = { kind: "idle" };
    this.group.visible = false;
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
    this.sfx.play("click", 0.35);
    if (id === "back") {
      this.close();
      this.onBack();
    } else if (id === "start") this.beginShowingCode();
    else if (id === "enter") this.pair = { kind: "entering", digits: "" };
    else if (id === "cancel") {
      if (this.pair.kind === "showing") this.pair.request.cancel();
      this.pair = { kind: "idle" };
      this.status = null;
    }
    else if (id.startsWith("key:") && this.pair.kind === "entering") {
      const key = id.slice(4);
      if (key === "⌫") this.pair.digits = this.pair.digits.slice(0, -1);
      else if (key === "OK") this.submitCode(this.pair.digits);
      else if (this.pair.digits.length < 6) this.pair.digits += key;
    }
    this.invalidate();
    return true;
  }

  private buttonAt(px: number, py: number): ButtonId | null {
    if (this.pair.kind === "idle" || this.pair.kind === "requesting") {
      if (inRect(BUTTONS.start, px, py)) return "start";
      if (inRect(BUTTONS.enter, px, py)) return "enter";
      if (inRect(BUTTONS.back, px, py)) return "back";
    } else if (this.pair.kind === "showing") {
      if (inRect(BUTTONS.cancel, px, py)) return "cancel";
      if (inRect(BUTTONS.back, px, py)) return "back";
    } else if (this.pair.kind === "entering" || this.pair.kind === "confirming") {
      const keyW = 130;
      const keyH = 64;
      for (let index = 0; index < KEYPAD.length; index++) {
        const rect: Rect = { x: 258 + (index % 3) * (keyW + 12), y: KEYPAD_TOP + Math.floor(index / 3) * (keyH + 10), w: keyW, h: keyH };
        if (inRect(rect, px, py)) return `key:${KEYPAD[index]}`;
      }
      if (inRect(BUTTONS.cancel, px, py)) return "cancel";
      if (inRect(BUTTONS.back, px, py)) return "back";
    }
    return null;
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
    drawPanelBackground(ctx, CANVAS_W, CANVAS_H);
    const hovered = new Set(this.hovered.values());
    const code = this.lore.serverProfile?.recoveryCode ?? "K7-····-····";

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff6b5a";
    ctx.font = "bold 42px monospace";
    ctx.fillText(t("devices.title"), CANVAS_W / 2, 54);
    ctx.fillStyle = "#a79d86";
    ctx.font = "20px monospace";
    ctx.fillText(t("devices.code"), CANVAS_W / 2, 112);
    ctx.fillStyle = "#ffe89a";
    ctx.font = "bold 36px monospace";
    ctx.fillText(code, CANVAS_W / 2, 155);

    const pair = this.pair;
    if (pair.kind === "idle" || pair.kind === "requesting") {
      drawButton(ctx, BUTTONS.start, t("pair.start"), { hovered: hovered.has("start"), accent: "#e8a44a" });
      drawButton(ctx, BUTTONS.enter, t("pair.confirm"), { hovered: hovered.has("enter"), accent: "#e8a44a" });
    } else if (pair.kind === "showing") {
      ctx.fillStyle = "#ffe89a";
      ctx.font = "bold 84px monospace";
      ctx.fillText(`${pair.request.code.slice(0, 3)} ${pair.request.code.slice(3)}`, CANVAS_W / 2, 310);
      ctx.fillStyle = "#e8a44a";
      ctx.font = "22px monospace";
      ctx.fillText(t("pair.waiting"), CANVAS_W / 2, 405);
      drawButton(ctx, BUTTONS.cancel, t("pair.cancel"), { hovered: hovered.has("cancel") });
    } else if (pair.kind === "entering" || pair.kind === "confirming") {
      const digits = pair.kind === "entering" ? pair.digits : "······";
      ctx.fillStyle = "#f2e8cf";
      ctx.font = "bold 54px monospace";
      ctx.fillText(digits.padEnd(6, "_").split("").join(" "), CANVAS_W / 2, 305);
      const keyW = 130;
      const keyH = 64;
      KEYPAD.forEach((key, index) => {
        const rect: Rect = { x: 258 + (index % 3) * (keyW + 12), y: KEYPAD_TOP + Math.floor(index / 3) * (keyH + 10), w: keyW, h: keyH };
        drawButton(ctx, rect, key, { hovered: hovered.has(`key:${key}`), accent: key === "OK" ? "#9fe39f" : undefined });
      });
      drawButton(ctx, BUTTONS.cancel, t("pair.cancel"), { hovered: hovered.has("cancel") });
    }
    drawButton(ctx, BUTTONS.back, t("devices.back"), { hovered: hovered.has("back") });

    if (this.status) {
      ctx.textAlign = "left";
      ctx.fillStyle = this.status.good ? "#9fe39f" : "#e06a5a";
      ctx.font = "22px monospace";
      wrapText(ctx, t(this.status.key), 60, 850, CANVAS_W - 120, 26, 2);
    }
  }
}
