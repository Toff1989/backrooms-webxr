/**
 * Simulation physique sans rendu (`npm run test:physics`) : vérifie les interactions que
 * l'on ne peut pas tester sans casque — marcher dans un meuble, saisir/lancer, murs,
 * saisie à distance, rangement, objets trop lourds.
 */
import * as THREE from "three";
import { CollisionGroups, PhysicsWorld, RAPIER } from "../src/physics/physicsWorld";
import { GrabSystem } from "../src/player/grabSystem";
import { Hand } from "../src/player/hand";
import { PlayerController } from "../src/player/playerController";
import { HandInput, XrInput } from "../src/player/xrInput";
import { GrabbableRegistry } from "../src/world/grabbable";

const DT = 1 / 72;
const results: string[] = [];
const check = (label: string, ok: boolean, detail: string) => results.push(`${ok ? "PASS" : "FAIL"} ${label} — ${detail}`);

function boxTemplate(w: number, h: number, d: number): THREE.Object3D {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial());
  mesh.position.y = h / 2;
  root.add(mesh);
  return root;
}

const physics = await PhysicsWorld.create();
const scene = new THREE.Scene();
const registry = new GrabbableRegistry(scene, physics);

// ---------- 1. Le joueur marche dans une chaise : il ne la traverse pas, elle glisse ----------
const camera = new THREE.PerspectiveCamera();
const fakeRenderer = { xr: { isPresenting: false } } as unknown as THREE.WebGLRenderer;
const player = new PlayerController(fakeRenderer, camera, physics);
scene.add(player.rig);
player.teleport(new THREE.Vector3(0, 0, 0));

const chairTemplate = boxTemplate(0.5, 0.9, 0.5);
const chair = registry.createProp("chair", chairTemplate.clone(), chairTemplate, 0, -1.5, 0);

const input = { left: new HandInput("left"), right: new HandInput("right") } as unknown as XrInput;
const pad = (axes: number[], pressed: number[] = []) =>
  ({ buttons: Array.from({ length: 7 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0 })), axes }) as unknown as Gamepad;
(input.left as HandInput).inputSource = { gamepad: pad([0, 0, 0, -1]), handedness: "left" } as unknown as XRInputSource;

let maxPenetration = 0;
for (let i = 0; i < 72 * 3; i++) {
  input.left.update();
  input.right.update();
  player.update(DT, input);
  physics.step(DT, () => {});
  registry.sync(new THREE.Vector3());
  // Distance réelle entre l'axe de la capsule (à mi-hauteur) et la surface de la chaise.
  const probe = { x: player.headWorld.x, y: 0.45, z: player.headWorld.z };
  const projection = chair.collider.projectPoint(probe, true);
  if (!projection) continue;
  const distance = Math.hypot(projection.point.x - probe.x, projection.point.z - probe.z);
  const penetration = projection.isInside ? 0.25 + distance : 0.25 - distance;
  maxPenetration = Math.max(maxPenetration, penetration);
}
// Une seconde sans marcher : la chaise (née endormie, poussée puis basculée) finit de retomber.
for (let i = 0; i < 72; i++) physics.step(DT, () => {});
const chairEnd = chair.body.translation();
check("marche dans la chaise : pas de traversée", maxPenetration < 0.08, `pénétration max ${maxPenetration.toFixed(3)} m`);
check("la chaise est poussée", chairEnd.z < -1.6, `chaise z ${(-1.5).toFixed(2)} → ${chairEnd.z.toFixed(2)}`);
check("la chaise reste au sol", chairEnd.y > -0.02 && chairEnd.y < 0.3, `y=${chairEnd.y.toFixed(3)}`);

// ---------- 2. Saisie, transport et lancer contre un mur ----------
const wallBody = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
physics.world.createCollider(
  RAPIER.ColliderDesc.cuboid(2, 1.35, 0.075).setTranslation(5, 1.35, -6).setCollisionGroups(CollisionGroups.static),
  wallBody,
);

const canTemplate = boxTemplate(0.08, 0.12, 0.08);
const item = { id: "sim-can", kind: "can", rarity: "common", scale: 1, depth: 0, nameFr: "c", nameEn: "c", descriptionFr: "", descriptionEn: "", collectedAt: 0 } as const;
const can = registry.createCollectible({ ...item }, canTemplate.clone(), canTemplate, new THREE.Vector3(5, 0.02, -3), new THREE.Quaternion());

const rightInput = input.right as HandInput;
const grip = new THREE.Group();
scene.add(grip);
rightInput.grip = grip as unknown as THREE.XRGripSpace;
rightInput.targetRay = new THREE.Group() as unknown as THREE.XRTargetRaySpace;
scene.add(rightInput.targetRay);
let squeeze: number[] = [];
const rightPad = () => pad([0, 0, 0, 0], squeeze);
rightInput.inputSource = { get gamepad() { return rightPad(); }, handedness: "right" } as unknown as XRInputSource;

const hand = new Hand(rightInput, physics);
const sfx = { play: () => {} } as never;
const stored: string[] = [];
const grab = new GrabSystem(physics, registry, [hand], sfx, { isOverInventory: () => false, store: (entry) => stored.push(entry.id) });
const pointer = { frame: () => ({ target: null, consumedGrip: false }) } as never;

let time = 0;
function tick(): void {
  time += DT;
  rightInput.update();
  scene.updateMatrixWorld(true);
  hand.update(time);
  grab.update(time, pointer);
  physics.step(DT, (step) => {
    hand.applyKinematicTarget();
    grab.step(step);
  });
  registry.sync(new THREE.Vector3());
}

// Main posée sur la canette (paume = grip + décalage), puis grip.
grip.position.set(5 + 0.035, 0.08, -3 + 0.01);
for (let i = 0; i < 10; i++) tick();
squeeze = [1];
tick();
check("saisie de la canette au contact", hand.holding === can, `holding=${hand.holding ? "canette" : "rien"}`);

// Soulève la main de 1 m en 0,5 s : la canette suit.
for (let i = 0; i < 36; i++) {
  grip.position.y += 1 / 36;
  tick();
}
const lifted = can.body.translation();
check("la canette suit la main", Math.abs(lifted.y - (grip.position.y - 0.005)) < 0.12, `canette y=${lifted.y.toFixed(2)}, main y=${grip.position.y.toFixed(2)}`);

// Lancer vers le mur (-Z) : geste rapide puis relâché.
for (let i = 0; i < 6; i++) {
  grip.position.z -= 0.12;
  tick();
}
squeeze = [];
tick();
const releaseVel = can.body.linvel();
check("lancer : vitesse transmise", releaseVel.z < -4, `vz=${releaseVel.z.toFixed(2)} m/s`);
for (let i = 0; i < 72 * 3; i++) tick();
const landed = can.body.translation();
check("la canette ne traverse pas le mur", landed.z > -6 + 0.075 - 0.01, `z=${landed.z.toFixed(2)} (mur à z=-6)`);
check("la canette retombe au sol sans le traverser", landed.y > -0.01 && landed.y < 0.3, `y=${landed.y.toFixed(3)}`);

// ---------- 3. Saisie à distance : viser + grip, l'objet vient dans la main ----------
const book = registry.createCollectible({ ...item, id: "sim-book" }, canTemplate.clone(), canTemplate, new THREE.Vector3(5, 0.02, -1), new THREE.Quaternion());
grip.position.set(5, 1.2, 1);
rightInput.targetRay.position.copy(grip.position);
// lookAt oriente +Z vers la cible ; le rayon de visée suit -Z : on regarde le point opposé.
rightInput.targetRay.lookAt(grip.position.clone().multiplyScalar(2).sub(new THREE.Vector3(5, 0.08, -1)));
for (let i = 0; i < 5; i++) tick();
squeeze = [1];
for (let i = 0; i < 72; i++) tick();
check("saisie à distance", hand.holding === book, `holding=${hand.holding === book ? "objet visé" : hand.holding ? "autre" : "rien"}`);

// ---------- 4. A/X range l'objet tenu dans l'inventaire ----------
squeeze = [1, 4];
tick();
check("A range l'objet tenu", stored.includes("sim-book") && hand.holding === null && !registry.all.has(book), `rangés=${stored.join(",")}`);

// ---------- 5. Objet tenu poussé à travers un mur : il est bloqué, puis lâché ----------
const brick = registry.createCollectible({ ...item, id: "sim-brick" }, canTemplate.clone(), canTemplate, new THREE.Vector3(5, 0.02, -4.5), new THREE.Quaternion());
squeeze = [];
tick();
grip.position.set(5 + 0.035, 0.08, -4.5 + 0.01);
for (let i = 0; i < 5; i++) tick();
squeeze = [1];
tick();
const grabbedBrick = hand.holding === brick;
let minBrickZ = 0;
for (let i = 0; i < 72; i++) {
  grip.position.z = Math.max(-8, grip.position.z - 0.06);
  grip.position.y = 1;
  tick();
  if (registry.all.has(brick)) minBrickZ = Math.min(minBrickZ, brick.body.translation().z);
}
check("objet tenu bloqué par le mur", grabbedBrick && minBrickZ > -5.93 - 0.02, `z min=${minBrickZ.toFixed(2)} (face du mur -5.93)`);
check("lâché quand la main passe trop loin derrière le mur", hand.holding === null, `holding=${hand.holding ? "encore" : "lâché"}`);

// ---------- 6. Meuble trop lourd : on ne peut que le pousser ----------
squeeze = [];
tick();
const cabinetTemplate = boxTemplate(0.9, 1.8, 0.5);
const cabinet = registry.createProp("cabinet", cabinetTemplate.clone(), cabinetTemplate, -3, 3, 0);
grip.position.set(-3 + 0.035, 1.0, 3 + 0.3);
for (let i = 0; i < 5; i++) tick();
squeeze = [1];
tick();
check("armoire (45 kg) non soulevable", hand.holding !== cabinet && !cabinet.liftable, `holding=${hand.holding === cabinet ? "armoire" : "rien"}`);

// ---------- 7. Le joueur ne traverse pas un mur, même en se penchant physiquement ----------
squeeze = [];
tick();
const wall2 = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
physics.world.createCollider(RAPIER.ColliderDesc.cuboid(3, 1.35, 0.075).setTranslation(20, 1.35, -2).setCollisionGroups(CollisionGroups.static), wall2);
player.teleport(new THREE.Vector3(20, 0, 0));
(input.left as HandInput).inputSource = { gamepad: pad([0, 0, 0, 0]), handedness: "left" } as unknown as XRInputSource;
let minHeadZ = 0;
for (let i = 0; i < 72 * 2; i++) {
  // Penché/déplacé physiquement vers le mur : la caméra avance dans l'espace du rig.
  (fakeRenderer.xr as { isPresenting: boolean }).isPresenting = true;
  camera.position.set(0, 1.6, -Math.min(4, i * 0.03));
  input.left.update();
  player.update(DT, input);
  physics.step(DT, () => {});
  minHeadZ = Math.min(minHeadZ, player.headWorld.z);
}
check("pas de traversée de mur en se penchant", minHeadZ > -2 + 0.075 + 0.25 - 0.03, `tête z min=${minHeadZ.toFixed(2)} (face du mur -1.925)`);

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
