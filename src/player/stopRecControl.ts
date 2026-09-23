import * as THREE from "three";

const HOLD_DURATION_SECONDS = 1.4;
/** Gâchette (index 0 du mapping gamepad, voir aussi `wristMenu.ts` pour le thumbstick). */
const TRIGGER_BUTTON_INDEX = 0;

/**
 * "STOP REC" (fiche projet : "Le joueur arrête quand il veut : action 'STOP REC' sur le
 * menu poignet"). Pas de bouton 3D pointable (pas de raycaster UI dans ce projet) : on
 * maintient la gâchette droite ~1,4s — assez long pour ne jamais arrêter une run par un
 * appui accidentel (contrairement au ramassage, qui est un geste volontaire ponctuel).
 */
export class StopRecControl {
  enabled = true;

  private holdSeconds = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly onConfirmed: () => void,
  ) {}

  update(deltaSeconds: number): void {
    if (!this.enabled) {
      this.holdSeconds = 0;
      return;
    }

    const session = this.renderer.xr.getSession();
    if (!session) {
      this.holdSeconds = 0;
      return;
    }

    let pressed = false;
    for (const source of session.inputSources) {
      if (source.handedness !== "right") continue;
      pressed = source.gamepad?.buttons[TRIGGER_BUTTON_INDEX]?.pressed ?? false;
    }

    if (!pressed) {
      this.holdSeconds = 0;
      return;
    }

    this.holdSeconds += deltaSeconds;
    if (this.holdSeconds >= HOLD_DURATION_SECONDS) {
      this.holdSeconds = 0;
      this.onConfirmed();
    }
  }
}
