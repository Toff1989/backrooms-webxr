import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";

const PHOTO_SIZE = 256;
/** Recul (m) de l'objectif derrière la tête du joueur, et marge gardée devant un mur. */
const BACK_DISTANCE = 2.6;
const WALL_MARGIN = 0.35;

const tmpHead = new THREE.Vector3();
const tmpForward = new THREE.Vector3();

/**
 * Appareil photo des polaroids : photographie la scène depuis quelques pas DERRIÈRE le joueur,
 * dans la direction où il regarde — l'instant où il ramasse la photo, vu par quelqu'un qui le
 * suit. Rendu hors écran en basse définition, lu dans un canvas (une seule fois par photo).
 */
export function createPhotoCapture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, physics: PhysicsWorld): () => HTMLCanvasElement | null {
  const target = new THREE.WebGLRenderTarget(PHOTO_SIZE, PHOTO_SIZE);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const lens = new THREE.PerspectiveCamera(58, 1, 0.05, 40);
  const pixels = new Uint8Array(PHOTO_SIZE * PHOTO_SIZE * 4);

  return () => {
    camera.getWorldPosition(tmpHead);
    camera.getWorldDirection(tmpForward).setY(0);
    if (tmpForward.lengthSq() < 1e-6) tmpForward.set(0, 0, -1);
    tmpForward.normalize();

    // Recul jusqu'au premier mur (ou meuble) derrière le joueur.
    const back = { x: -tmpForward.x, y: 0, z: -tmpForward.z };
    const hit = physics.world.castRay(new RAPIER.Ray(tmpHead, back), BACK_DISTANCE, true, undefined, CollisionGroups.querySight);
    const distance = Math.max(0.2, (hit ? hit.timeOfImpact : BACK_DISTANCE) - WALL_MARGIN);
    lens.position.copy(tmpHead).addScaledVector(tmpForward, -distance);
    lens.position.y = tmpHead.y + 0.12;
    lens.lookAt(tmpHead.x + tmpForward.x * 3, tmpHead.y - 0.25, tmpHead.z + tmpForward.z * 3);
    lens.updateMatrixWorld();

    // Ni HUD, ni vignette, ni grain d'écran : ce qui est accroché à la caméra du joueur est masqué.
    const hidden = camera.children.filter((child) => child.visible);
    for (const child of hidden) child.visible = false;
    // En VR, le rendu remplace la caméra par celle du casque : on le coupe le temps de la photo.
    const xrEnabled = renderer.xr.enabled;
    const previousTarget = renderer.getRenderTarget();
    renderer.xr.enabled = false;
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, lens);
      renderer.readRenderTargetPixels(target, 0, 0, PHOTO_SIZE, PHOTO_SIZE, pixels);
    } catch {
      return null;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.xr.enabled = xrEnabled;
      for (const child of hidden) child.visible = true;
    }

    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(PHOTO_SIZE, PHOTO_SIZE);
    // Les pixels WebGL partent du bas : on retourne l'image.
    const row = PHOTO_SIZE * 4;
    for (let y = 0; y < PHOTO_SIZE; y++) image.data.set(pixels.subarray((PHOTO_SIZE - 1 - y) * row, (PHOTO_SIZE - y) * row), y * row);
    ctx.putImageData(image, 0, 0);
    return canvas;
  };
}
