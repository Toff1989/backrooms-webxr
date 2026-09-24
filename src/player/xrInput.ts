import * as THREE from "three";

export type Handedness = "left" | "right";

export class ButtonState {
  pressed = false;
  justPressed = false;
  justReleased = false;
  touched = false;
  value = 0;

  set(button: GamepadButton | undefined): void {
    const pressed = button?.pressed ?? false;
    this.justPressed = pressed && !this.pressed;
    this.justReleased = !pressed && this.pressed;
    this.pressed = pressed;
    this.touched = button?.touched ?? false;
    this.value = button?.value ?? 0;
  }

  reset(): void {
    this.set(undefined);
  }
}

/**
 * Indices du mapping gamepad "xr-standard" des manettes Touch (profils officiels
 * `oculus-touch-v3` / `meta-quest-touch-plus`) : 0 gâchette, 1 grip, 2 pavé tactile
 * (absent, emplacement réservé), 3 clic du stick, 4 A/X, 5 B/Y, 6 repose-pouce. Certains
 * émulateurs omettent l'emplacement réservé : repli sur une disposition compacte.
 */
function buttonIndices(gamepad: Gamepad): { stick: number; primary: number; secondary: number; thumbrest: number } {
  return gamepad.buttons.length >= 7 ? { stick: 3, primary: 4, secondary: 5, thumbrest: 6 } : { stick: 2, primary: 3, secondary: 4, thumbrest: 5 };
}

export class HandInput {
  targetRay: THREE.XRTargetRaySpace | null = null;
  grip: THREE.XRGripSpace | null = null;
  inputSource: XRInputSource | null = null;

  readonly trigger = new ButtonState();
  readonly squeeze = new ButtonState();
  readonly stick = new ButtonState();
  /** A (main droite) / X (main gauche). */
  readonly primary = new ButtonState();
  /** B (main droite) / Y (main gauche). */
  readonly secondary = new ButtonState();
  readonly thumbrest = new ButtonState();
  stickX = 0;
  stickY = 0;

  constructor(readonly handedness: Handedness) {}

  get connected(): boolean {
    return this.inputSource !== null && this.grip !== null;
  }

  /** Le pouce repose sur un bouton/stick : la main virtuelle le replie. */
  get thumbDown(): boolean {
    return this.stick.touched || this.primary.touched || this.secondary.touched || this.thumbrest.touched;
  }

  update(): void {
    const gamepad = this.inputSource?.gamepad;
    if (!gamepad) {
      for (const state of [this.trigger, this.squeeze, this.stick, this.primary, this.secondary, this.thumbrest]) state.reset();
      this.stickX = 0;
      this.stickY = 0;
      return;
    }
    const indices = buttonIndices(gamepad);
    this.trigger.set(gamepad.buttons[0]);
    this.squeeze.set(gamepad.buttons[1]);
    this.stick.set(gamepad.buttons[indices.stick]);
    this.primary.set(gamepad.buttons[indices.primary]);
    this.secondary.set(gamepad.buttons[indices.secondary]);
    this.thumbrest.set(gamepad.buttons[indices.thumbrest]);
    const axesOffset = gamepad.axes.length >= 4 ? 2 : 0;
    this.stickX = gamepad.axes[axesOffset] ?? 0;
    this.stickY = gamepad.axes[axesOffset + 1] ?? 0;
  }
}

/**
 * Entrées XR des deux mains : espaces de visée (target ray, pour pointer) et de préhension
 * (grip, pour tenir), boutons avec fronts montants/descendants. L'ordre de
 * `getController(0/1)` ne correspond pas forcément à gauche/droite : on suit la
 * "handedness" annoncée à la connexion.
 */
export class XrInput {
  readonly left = new HandInput("left");
  readonly right = new HandInput("right");

  constructor(renderer: THREE.WebGLRenderer, parent: THREE.Object3D) {
    for (let index = 0; index < 2; index++) {
      const targetRay = renderer.xr.getController(index);
      const grip = renderer.xr.getControllerGrip(index);
      parent.add(targetRay, grip);

      targetRay.addEventListener("connected", (event) => {
        const source = event.data;
        if (source.handedness !== "left" && source.handedness !== "right") return;
        const hand = this.hand(source.handedness);
        hand.targetRay = targetRay;
        hand.grip = grip;
        hand.inputSource = source;
      });
      targetRay.addEventListener("disconnected", () => {
        for (const hand of this.hands) {
          if (hand.targetRay !== targetRay) continue;
          hand.inputSource = null;
          hand.targetRay = null;
          hand.grip = null;
        }
      });
    }
  }

  get hands(): readonly HandInput[] {
    return [this.left, this.right];
  }

  hand(handedness: Handedness): HandInput {
    return handedness === "left" ? this.left : this.right;
  }

  update(): void {
    this.left.update();
    this.right.update();
  }
}
