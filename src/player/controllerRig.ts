import * as THREE from "three";

/**
 * Crée les deux Object3D de contrôleur XR (three.js) et les ajoute au rig joueur pour
 * qu'ils suivent sa position/rotation. Piste la "handedness" (gauche/droite) via les
 * évènements `connected`/`disconnected` du WebXR : l'ordre de `getController(0/1)` ne
 * correspond pas forcément à main gauche/droite (dépend de l'ordre de connexion).
 */
export class ControllerRig {
  readonly all: THREE.XRTargetRaySpace[];
  left: THREE.XRTargetRaySpace | null = null;
  right: THREE.XRTargetRaySpace | null = null;

  constructor(renderer: THREE.WebGLRenderer, playerRig: THREE.Group) {
    this.all = [renderer.xr.getController(0), renderer.xr.getController(1)];

    for (const controller of this.all) {
      playerRig.add(controller);
      controller.addEventListener("connected", (event) => {
        if (event.data.handedness === "left") this.left = controller;
        else if (event.data.handedness === "right") this.right = controller;
      });
      controller.addEventListener("disconnected", () => {
        if (this.left === controller) this.left = null;
        if (this.right === controller) this.right = null;
      });
    }
  }
}
