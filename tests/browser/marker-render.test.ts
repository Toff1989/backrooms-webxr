/**
 * Rendu visuel du dessin au marqueur (sol, mur, plafond : tuiles canvas de `MarkerSurfaces`, avec
 * une physique factice réduite à un mur plan) et du gros plan de la tête du Cadreur (sursaut de
 * capture, voir `endSequence.ts`).
 *
 * Lancer en headless : `node scripts/render-test.mjs marker-render`.
 */
import * as THREE from "three";
import { MarkerSurfaces } from "../../src/world/markerSurfaces";
import { MARKER_INKS } from "../../src/world/markerModel";
import { spawnCollectibleModel } from "../../src/world/collectibleLoader";
import { CollisionGroups, PhysicsWorld, RAPIER } from "../../src/physics/physicsWorld";
import { createLogger, createRenderer, createScene, createStageController } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["SURFACES", "ERASED", "ORPHAN", "HEAD"]);

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  const scene = createScene(0x444038);
  const camera = new THREE.PerspectiveCamera(60, canvas.width / canvas.height, 0.02, 40);
  // Pièce témoin : sol, mur en x = 3 et plafond, pour voir où tombent les traits.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ color: 0x8a7f5a }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(1.5, 0, 1.5);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 2.7), new THREE.MeshStandardMaterial({ color: 0xb8ad84, side: THREE.DoubleSide }));
  wall.rotation.y = -Math.PI / 2;
  wall.position.set(3, 1.35, 1.5);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ color: 0xcfc7a3 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(1.5, 2.7, 1.5);
  scene.add(floor, wall, ceiling);

  // Vraie physique : un mur plein sur le plan x = 3 (face tournée vers -x), comme les murs du jeu.
  const physics = await PhysicsWorld.create();
  const wallBody = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const wallCollider = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.075, 1.35, 4).setTranslation(3.075, 1.35, 1.5).setCollisionGroups(CollisionGroups.static), wallBody);
  physics.step(0.02, () => {});
  const surfaces = new MarkerSurfaces(scene, physics);
  const { model: marker } = await spawnCollectibleModel("marker");
  marker.position.set(1.4, 0.2, 0.2);
  marker.rotation.set(0, 0, 0.4);
  scene.add(marker);
  const mb = new THREE.Box3().setFromObject(marker).getSize(new THREE.Vector3());
  log(`Marqueur : ${mb.x.toFixed(3)} x ${mb.y.toFixed(3)} x ${mb.z.toFixed(3)} m`);

  const path = (points: Array<[number, number, number]>, color: string | null): void => {
    let pen = null;
    for (const [x, y, z] of points) {
      const tip = new THREE.Vector3(x, y, z);
      const contact = surfaces.probe(tip);
      if (!contact) continue;
      pen = surfaces.draw(contact, pen, color);
    }
  };
  const lerp = (a: [number, number, number], b: [number, number, number], steps: number): Array<[number, number, number]> =>
    Array.from({ length: steps + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps, a[2] + ((b[2] - a[2]) * i) / steps]);

  // Sol : un cercle (3 couleurs) qui traverse la frontière de tuile x = 2,5.
  const circle: Array<[number, number, number]> = Array.from({ length: 60 }, (_, i) => [2.3 + Math.cos((i / 59) * Math.PI * 2) * 0.5, 0.01, 1.2 + Math.sin((i / 59) * Math.PI * 2) * 0.5]);
  path(circle, "#c0281d");
  path(lerp([0.6, 0.01, 0.6], [2.7, 0.01, 2.0], 40), "#254a9c");
  // Mur : une flèche et une croix à hauteur d'yeux (mine à 1 cm du plan x = 3).
  path(lerp([2.99, 1.2, 0.4], [2.99, 1.5, 1.4], 30), MARKER_INKS[0]!.color);
  path(lerp([2.99, 1.5, 1.4], [2.99, 1.4, 1.2], 8), MARKER_INKS[0]!.color);
  path(lerp([2.99, 1.2, 1.6], [2.99, 1.8, 2.2], 30), "#2d7f45");
  path(lerp([2.99, 1.8, 1.6], [2.99, 1.2, 2.2], 30), "#2d7f45");
  // Hors contact : jamais de trait en l'air, derrière ou à travers la surface.
  path(lerp([2.9, 1.0, 0.2], [2.9, 1.0, 1.0], 10), "#ff00ff");
  path(lerp([3.1, 1.0, 0.2], [3.1, 1.0, 1.0], 10), "#ff00ff");
  path(lerp([2.5, -0.05, 0.2], [2.5, -0.05, 1.0], 10), "#ff00ff");
  path(lerp([2.5, 0.05, 0.2], [2.5, 0.05, 1.0], 10), "#ff00ff");
  // Plafond : un trait.
  path(lerp([0.5, 2.69, 0.5], [2.2, 2.69, 1.6], 30), "#c0281d");
  surfaces.update(0.016, new THREE.Vector3(1.5, 1.6, 1.5));
  log(`Tuiles allouées : ${surfaces.tileCount}`);

  camera.position.set(0.2, 1.6, 0.0);
  camera.lookAt(2.6, 1.0, 1.4);
  renderer.render(scene, camera);
  await stages.enter("SURFACES");

  // Gomme sur le sol (efface une partie du cercle) et le mur.
  path(lerp([1.9, 0.01, 1.0], [2.8, 0.01, 1.4], 20), null);
  path(lerp([2.99, 1.1, 0.6], [2.99, 1.6, 1.0], 20), null);
  surfaces.update(0.016, new THREE.Vector3(1.5, 1.6, 1.5));
  renderer.render(scene, camera);
  await stages.enter("ERASED");

  // Le labyrinthe change : le mur disparaît (chunk régénéré). Les traits qui y étaient sont effacés, ceux du sol restent.
  physics.world.removeCollider(wallCollider, true);
  physics.step(0.02, () => {});
  surfaces.queueRevalidate(new THREE.Box3(new THREE.Vector3(0, 0, -2), new THREE.Vector3(8, 2.7, 5)));
  surfaces.update(0.016, new THREE.Vector3(1.5, 1.6, 1.5));
  log(`Tuiles après disparition du mur : ${surfaces.tileCount}`);
  scene.remove(wall);
  renderer.render(scene, camera);
  await stages.enter("ORPHAN");

  // Gros plan de la tête du Cadreur, comme dans la séquence de capture (objectif vers l'œil).
  scene.remove(floor, wall, ceiling, marker);
  const { model } = await spawnCollectibleModel("cadreurHead");
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = 0.5 / Math.max(size.x, size.y, size.z, 0.01);
  model.scale.setScalar(scale);
  model.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
  const glow = document.createElement("canvas");
  glow.width = glow.height = 64;
  const gctx = glow.getContext("2d")!;
  const gradient = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.9)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  gctx.fillStyle = gradient;
  gctx.fillRect(0, 0, 64, 64);
  const led = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glow), color: 0xff2a1a, depthTest: false, blending: THREE.AdditiveBlending }));
  led.scale.setScalar(0.1);
  led.position.set(0.1, 0.17, 0.05);
  const holder = new THREE.Group();
  holder.add(model, led);
  holder.position.set(0, 0, -0.55);
  camera.add(holder);
  scene.add(camera);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  renderer.render(scene, camera);
  await stages.enter("HEAD");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
