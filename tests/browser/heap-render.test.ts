/**
 * Rendu du tas de mobilier jeté en vrac (scène « heap » de `shared/props.ts`), avec la vraie
 * physique Rapier et les vrais meubles (`spawnProp` + `GrabbableRegistry.createProp`) : on prend
 * la première cellule dont la mise en scène est un tas, on laisse les meubles retomber, puis on
 * capture la chute et le tas posé (de face et de haut). Log : nombre de meubles, hauteur max,
 * rayon max et corps encore éveillés.
 *
 * Lancer : `node scripts/render-test.mjs heap-render`.
 */
import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../../src/physics/physicsWorld";
import { CELL_SIZE, WALL_HEIGHT } from "../../src/shared/constants";
import { composePropCluster, type PropSlot } from "../../src/shared/props";
import { GrabbableRegistry } from "../../src/world/grabbable";
import { spawnProp } from "../../src/world/propLoader";
import { createLogger, createRenderer, createStageController } from "./support/harness";

const { log } = createLogger();
const stages = createStageController(["FALLING", "SETTLED_FRONT", "SETTLED_TOP", "SETTLED_CORNER"]);
const DT = 1 / 72;

/** Tirage déterministe [0..1) par cellule (même esprit que `coordinateHash01`). */
function hash01(cell: number, salt: number): number {
  let h = (cell * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

async function run(): Promise<void> {
  const { renderer, canvas } = createRenderer();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0805);
  scene.fog = new THREE.FogExp2(0x0a0805, 0.06);
  scene.add(new THREE.HemisphereLight(0xfff3cf, 0x3a3320, 1.4));
  const lamp = new THREE.PointLight(0xfff1d6, 6, 9, 1.4);
  lamp.position.set(0, 2.4, 0);
  scene.add(lamp);

  // Pièce de 2,5 m : sol, murs jaunâtres (physique + rendu), plafond porté par la physique.
  const physics = await PhysicsWorld.create();
  const half = CELL_SIZE / 2;
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xb9a75a, roughness: 0.9, side: THREE.DoubleSide });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(CELL_SIZE * 3, CELL_SIZE * 3), new THREE.MeshStandardMaterial({ color: 0x6b5f3a, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  for (const [x, z, sx, sz] of [
    [0, -half, CELL_SIZE, 0.1],
    [0, half, CELL_SIZE, 0.1],
    [-half, 0, 0.1, CELL_SIZE],
    [half, 0, 0.1, CELL_SIZE],
  ] as const) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, WALL_HEIGHT, sz), wallMaterial);
    wall.position.set(x, WALL_HEIGHT / 2, z);
    // Mur d'avant : physique seulement, pour que la caméra voie le tas de face.
    if (z < half - 0.01) scene.add(wall);
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, WALL_HEIGHT / 2, z));
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, WALL_HEIGHT / 2, sz / 2), body);
  }

  // Première cellule dont la mise en scène est un tas.
  let slots: PropSlot[] = [];
  let rotationY = 0;
  let cell = 0;
  for (; cell < 500; cell++) {
    const cluster = composePropCluster((salt) => hash01(cell, salt));
    if (cluster.slots.some((slot) => slot.heap)) {
      slots = cluster.slots;
      rotationY = cluster.rotationY;
      break;
    }
  }
  log(`Cellule ${cell} : tas de ${slots.length} meubles (${slots.map((s) => s.kind).join(", ")}).`);

  const registry = new GrabbableRegistry(scene, physics);
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  const grabbables = [];
  for (const slot of slots) {
    const { model, template } = await spawnProp(slot.kind);
    const x = slot.dx * cos + slot.dz * sin;
    const z = -slot.dx * sin + slot.dz * cos;
    grabbables.push(registry.createProp(slot.kind, model, template, x, z, rotationY + slot.rotationY, 0, false, slot.heap ?? null));
  }

  const camera = new THREE.PerspectiveCamera(70, canvas.width / canvas.height, 0.03, 40);
  const viewer = new THREE.Vector3(0, 1.6, 0);
  const advance = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      physics.world.timestep = DT;
      physics.world.step();
      registry.sync(viewer);
    }
  };
  const shoot = (position: THREE.Vector3, target: THREE.Vector3): void => {
    camera.position.copy(position);
    camera.lookAt(target);
    renderer.render(scene, camera);
  };

  advance(0.5);
  shoot(new THREE.Vector3(0, 1.5, 2.6), new THREE.Vector3(0, 1.0, 0));
  await stages.enter("FALLING");

  advance(9);
  const awake = grabbables.filter((g) => !g.body.isSleeping()).length;
  let maxY = 0;
  let maxRadius = 0;
  for (const g of grabbables) {
    const t = g.body.translation();
    maxY = Math.max(maxY, t.y);
    maxRadius = Math.max(maxRadius, Math.hypot(t.x, t.z));
  }
  log(`Après 9,5 s : ${awake} corps encore éveillés, hauteur max ${maxY.toFixed(2)} m, rayon max ${maxRadius.toFixed(2)} m.`);

  shoot(new THREE.Vector3(0, 1.5, 2.6), new THREE.Vector3(0, 0.7, 0));
  await stages.enter("SETTLED_FRONT");
  shoot(new THREE.Vector3(0.01, 3.6, 0.01), new THREE.Vector3(0, 0, 0));
  await stages.enter("SETTLED_TOP");
  shoot(new THREE.Vector3(1.9, 1.4, 1.9), new THREE.Vector3(-0.2, 0.6, -0.2));
  await stages.enter("SETTLED_CORNER");
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
