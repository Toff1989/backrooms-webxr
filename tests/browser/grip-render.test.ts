/**
 * Rendu de la prise du stylo avec les vrais modèles de main (gants) et de marqueur : une
 * vue par relèvement de la mine (`?tilt=25&side=left`) : côté, dessus et face. Le repère est l'espace grip de la manette.
 * Ouvrir /tests/browser/grip-render.html avec le serveur de dev.
 */
import * as THREE from "three";
import { HandModel } from "../../src/player/handModel";
import { PEN_HOLD_POINT, penGripQuaternion } from "../../src/player/penGrip";
import { createMarkerModel, MARKER_GRIP_OFFSET } from "../../src/world/markerModel";
import { createLogger, createRenderer, createScene } from "./support/harness";

const { log } = createLogger();

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const tilt = THREE.MathUtils.degToRad(Number(params.get("tilt") ?? "25"));
  const side = params.get("side") === "left" ? "left" : "right";
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  canvas.width = 1800;
  canvas.height = 700;
  const { renderer } = createRenderer();
  renderer.autoClear = false;
  const scene = createScene(0x3a362c);
  const cellW = canvas.width / 3;
  const camera = new THREE.PerspectiveCamera(30, cellW / canvas.height, 0.02, 10);
  renderer.setScissorTest(true);
  const hand = await HandModel.load(side);
  hand.setPose(1, 1, 0.9);
  scene.add(hand.root);
  (window as unknown as Record<string, unknown>)["__hand"] = hand;
  const marker = createMarkerModel();
  scene.add(marker);

  renderer.setClearColor(0x3a362c);
  renderer.clear();
  const palm = PEN_HOLD_POINT[side];
  const q = penGripQuaternion(tilt);
  marker.quaternion.copy(q);
  // Point saisi (tiers arrière du stylo) dans la paume.
  marker.position.copy(new THREE.Vector3(0, -MARKER_GRIP_OFFSET, 0).applyQuaternion(q)).add(palm);
  const sign = side === "right" ? -1 : 1;
  const views: Array<[string, THREE.Vector3, THREE.Vector3]> = [
    // Côté paume (le pouce en haut) : la mine monte ou descend par rapport aux doigts.
    ["côté", new THREE.Vector3(sign * 0.4, 0.03, -0.04), new THREE.Vector3(0, 1, 0)],
    // De dessus (avant = haut de l'image).
    ["dessus", new THREE.Vector3(0, 0.4, -0.05), new THREE.Vector3(0, 0, -1)],
    // De face, depuis l'avant de la main (côté mine).
    ["face", new THREE.Vector3(0, 0.03, -0.45), new THREE.Vector3(0, 1, 0)],
  ];
  views.forEach(([, position, up], v) => {
    camera.position.copy(position).add(palm);
    camera.up.copy(up);
    camera.lookAt(palm);
    renderer.setViewport(v * cellW, 0, cellW, canvas.height);
    renderer.setScissor(v * cellW, 0, cellW, canvas.height);
    renderer.render(scene, camera);
  });
  log(`Main ${side}, relèvement ${Math.round(THREE.MathUtils.radToDeg(tilt))}° — vues : côté | dessus | face`);
  (window as unknown as Record<string, boolean>)["__done"] = true;
}

run().catch((error) => log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`));
