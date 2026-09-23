import * as THREE from "three";
import type { CollectibleInstance } from "../world/collectible";
import type { ControllerRig } from "./controllerRig";
import { triggerHapticPulse } from "./haptics";

const GRAB_HAPTIC_INTENSITY = 0.5;
const GRAB_HAPTIC_DURATION_MS = 70;
const RELEASE_HAPTIC_INTENSITY = 0.25;
const RELEASE_HAPTIC_DURATION_MS = 40;

export interface GrabCallbacks {
  /** Cherche un objet à portée de `worldPosition` et, si trouvé, le passe en main (voir `CollectibleInstance.beginHold`). */
  onGrabAttempt: (controller: THREE.Object3D, worldPosition: THREE.Vector3) => CollectibleInstance | null;
  /** Relâchement : l'appelant décide ramassage définitif vs. simple dépose (voir `main.ts`). */
  onRelease: (controller: THREE.Object3D, instance: CollectibleInstance) => void;
}

/**
 * Saisie au grip (fiche projet étape 6, étendue : manipuler l'objet en main avant — et,
 * pour un objet déjà collecté, après — de le ramasser). Les deux mains peuvent saisir :
 * au `squeezestart`, tente d'attraper l'objet le plus proche à portée ; tant que le grip
 * reste enfoncé, l'objet suit la main (reparentage, voir `CollectibleInstance.beginHold`) ;
 * au relâchement (`squeezeend`), l'appelant décide de la suite.
 */
export class GrabInteraction {
  private readonly held = new Map<THREE.Object3D, CollectibleInstance>();

  constructor(renderer: THREE.WebGLRenderer, controllerRig: ControllerRig, callbacks: GrabCallbacks) {
    const grabPoint = new THREE.Vector3();

    for (const controller of controllerRig.all) {
      controller.addEventListener("squeezestart", () => {
        if (this.held.has(controller)) return;
        controller.getWorldPosition(grabPoint);
        const instance = callbacks.onGrabAttempt(controller, grabPoint);
        if (instance) {
          this.held.set(controller, instance);
          triggerHapticPulse(renderer, GRAB_HAPTIC_INTENSITY, GRAB_HAPTIC_DURATION_MS);
        }
      });

      controller.addEventListener("squeezeend", () => {
        const instance = this.held.get(controller);
        if (!instance) return;
        this.held.delete(controller);
        callbacks.onRelease(controller, instance);
        triggerHapticPulse(renderer, RELEASE_HAPTIC_INTENSITY, RELEASE_HAPTIC_DURATION_MS);
      });
    }
  }
}
