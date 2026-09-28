import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { log } from "../debug/debugLog";
import { renderOffscreen } from "./liveViews";
import { perf } from "./perfStats";

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

    const started = performance.now();
    if (!renderOffscreen(renderer, scene, camera, lens, target)) return null;
    renderer.readRenderTargetPixels(target, 0, 0, PHOTO_SIZE, PHOTO_SIZE, pixels);
    perf?.event("photo");
    log("photo", { ms: Math.round((performance.now() - started) * 10) / 10 });

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

/** Capture dédiée aux cadres photo : isole visuellement un collectible depuis la position du cadre. */
export function createObjectCapture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): (object: THREE.Object3D, origin: THREE.Vector3, hidden: THREE.Object3D | undefined, width: number, height: number) => HTMLCanvasElement | null {
  const lens = new THREE.PerspectiveCamera(42, 1, 0.05, 40);
  const bounds = new THREE.Box3();
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  const direction = new THREE.Vector3();

  return (object, origin, hidden, width, height) => {
    const target = new THREE.WebGLRenderTarget(width, height);
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const pixels = new Uint8Array(width * height * 4);
    lens.aspect = width / height;
    bounds.setFromObject(object);
    bounds.getCenter(center);
    bounds.getSize(size);
    const radius = Math.max(0.12, size.length() * 0.5);
    direction.subVectors(origin, center);
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);
    direction.normalize();
    lens.position.copy(center).addScaledVector(direction, Math.max(0.8, radius * 3.2));
    lens.near = 0.05;
    lens.far = Math.max(10, lens.position.distanceTo(center) + radius * 5);
    lens.updateProjectionMatrix();
    lens.lookAt(center);
    lens.updateMatrixWorld();

    const photoFill = new THREE.HemisphereLight(0xfff1d6, 0x17120f, 1.15);
    const photoKey = new THREE.DirectionalLight(0xffead0, 1.4);
    photoKey.position.copy(lens.position);
    photoKey.target.position.copy(center);
    scene.add(photoFill, photoKey, photoKey.target);
    const rendered = renderOffscreen(renderer, scene, camera, lens, target, hidden ? [hidden] : []);
    scene.remove(photoFill, photoKey, photoKey.target);
    if (!rendered) {
      target.dispose();
      return null;
    }
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      target.dispose();
      return null;
    }
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    ctx.putImageData(image, 0, 0);
    target.dispose();
    return canvas;
  };
}
