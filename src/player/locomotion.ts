import * as THREE from "three";
import { PLAYER_MOVE_SPEED } from "../shared/constants";

const MOVE_DEADZONE = 0.15;
const SNAP_TURN_ANGLE = THREE.MathUtils.degToRad(45);
const SNAP_TURN_DEADZONE = 0.6;
const SNAP_TURN_RESET_DEADZONE = 0.3;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Locomotion fluide au joystick gauche (relative au regard, plan horizontal)
 * + snap-turn au joystick droit. Lit directement les gamepads XR à chaque frame.
 */
export class Locomotion {
  private snapTurnReady = true;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly moveDelta = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.Camera,
    private readonly playerRig: THREE.Group,
  ) {}

  /** Retourne l'intensité de déplacement [0..1] de cette frame, utilisée pour la vignette de confort. */
  update(deltaSeconds: number): number {
    const session = this.renderer.xr.getSession();
    if (!session) return 0;

    let moveIntensity = 0;

    for (const source of session.inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad) continue;

      const x = gamepad.axes[2] ?? gamepad.axes[0] ?? 0;
      const y = gamepad.axes[3] ?? gamepad.axes[1] ?? 0;

      if (source.handedness === "left") {
        moveIntensity = this.applySmoothMove(x, y, deltaSeconds);
      } else if (source.handedness === "right") {
        this.applySnapTurn(x);
      }
    }

    return moveIntensity;
  }

  private applySmoothMove(x: number, y: number, deltaSeconds: number): number {
    const magnitude = Math.min(Math.hypot(x, y), 1);
    if (magnitude < MOVE_DEADZONE) return 0;

    this.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.forward.normalize();
    this.right.crossVectors(this.forward, UP).normalize();

    this.moveDelta
      .set(0, 0, 0)
      .addScaledVector(this.right, x)
      .addScaledVector(this.forward, -y);

    if (this.moveDelta.lengthSq() > 1) {
      this.moveDelta.normalize().multiplyScalar(magnitude);
    }

    this.playerRig.position.addScaledVector(this.moveDelta, PLAYER_MOVE_SPEED * deltaSeconds);

    return magnitude;
  }

  private applySnapTurn(x: number): void {
    if (this.snapTurnReady && Math.abs(x) > SNAP_TURN_DEADZONE) {
      this.playerRig.rotateY(-Math.sign(x) * SNAP_TURN_ANGLE);
      this.snapTurnReady = false;
    } else if (!this.snapTurnReady && Math.abs(x) < SNAP_TURN_RESET_DEADZONE) {
      this.snapTurnReady = true;
    }
  }
}
