import * as THREE from "three";
import cadreurUrl from "../assets/models/entities/cadreur.glb";
import { spawnCollectibleModel } from "./collectibleLoader";
import { gltfLoader } from "./gltfLoader";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Silhouette du Cadreur : mannequin sans visage (rig Mixamo "X Bot", décimé + Draco), d'un
 * brun presque noir et légèrement luisant, qui tient devant sa tête une vieille caméra 8 mm
 * (le modèle de collection "caméra vidéo vintage") : l'objectif est son visage. Une LED
 * rouge "REC" clignote sur la caméra — visible même dans le noir complet.
 *
 * Il n'est jamais animé sous les yeux du joueur : chaque fois qu'il se déplace hors de vue,
 * il reprend une pose figée (une phase de marche différente, tête penchée), bras placés par
 * IK à deux os pour tenir la caméra.
 */

/**
 * Caméra devant les yeux (décalage depuis l'os de la tête, repère du personnage face +Z),
 * et poignets autour d'elle : main droite sur la poignée, main gauche sous l'objectif.
 */
const CAMCORDER_FROM_HEAD = new THREE.Vector3(-0.01, 0.05, 0.16);
const RIGHT_WRIST_FROM_CAMCORDER = new THREE.Vector3(-0.1, -0.07, -0.05);
const LEFT_WRIST_FROM_CAMCORDER = new THREE.Vector3(0.07, -0.1, 0.0);
const RIGHT_POLE = new THREE.Vector3(-0.45, 1.1, 0.05);
const LEFT_POLE = new THREE.Vector3(0.45, 1.1, 0.05);
const CAMCORDER_SCALE = 1.25;

export interface CadreurRig {
  root: THREE.Group;
  led: THREE.Mesh;
  /** Pose figée : `walkPhase` 0..1 dans le cycle de marche, `variant` 0..1 (tête, épaules). */
  pose(walkPhase: number, variant: number): void;
}

export async function loadCadreur(): Promise<CadreurRig> {
  const [gltf, camcorder] = await Promise.all([gltfLoader.loadAsync(cadreurUrl), spawnCollectibleModel("videoCamera")]);
  const character = gltf.scene;
  const skin = new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 0.42, metalness: 0.05 });
  const joints = new THREE.MeshStandardMaterial({ color: 0x0c0a08, roughness: 0.6, metalness: 0.05 });
  applyVhsEffect(skin);
  applyVhsEffect(joints);
  character.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) {
      object.material = object.name.includes("Joints") ? joints : skin;
      object.frustumCulled = false;
    }
  });

  const bone = (name: string): THREE.Bone => {
    const found = character.getObjectByName(`mixamorig${name}`);
    if (!(found instanceof THREE.Bone)) throw new Error(`Os ${name} introuvable`);
    return found;
  };
  const right = [bone("RightArm"), bone("RightForeArm"), bone("RightHand")] as const;
  const left = [bone("LeftArm"), bone("LeftForeArm"), bone("LeftHand")] as const;
  const head = bone("Head");
  const neck = bone("Neck");

  const root = new THREE.Group();
  root.add(character);

  const camera = camcorder.model;
  camera.scale.setScalar(CAMCORDER_SCALE);
  // L'objectif du modèle regarde vers +Z, comme le personnage.
  root.add(camera);

  const led = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false, toneMapped: false }));
  led.position.set(0.028, 0.07, 0.015);
  camera.add(led);
  const headLocal = new THREE.Vector3();

  // Pose de référence de tous les os : chaque nouvelle pose repart de là (les rotations de
  // tête et l'IK des bras ne s'accumulent pas d'une pose à l'autre).
  const bones: THREE.Bone[] = [];
  character.traverse((object) => {
    if (object instanceof THREE.Bone) bones.push(object);
  });
  const restPose = bones.map((b) => b.quaternion.clone());

  const mixer = new THREE.AnimationMixer(character);
  const walk = gltf.animations.find((clip) => clip.name === "walk") ?? gltf.animations[0];
  const action = walk ? mixer.clipAction(walk) : null;
  action?.play();

  const toWorld = (local: THREE.Vector3) => root.localToWorld(local.clone());

  return {
    root,
    led,
    pose(walkPhase, variant) {
      bones.forEach((b, i) => b.quaternion.copy(restPose[i]!));
      if (action && walk) {
        action.time = walkPhase * walk.duration;
        mixer.update(0);
      }
      // Tête penchée vers le viseur, un peu de travers : jamais deux fois la même.
      neck.rotation.x += 0.12 + variant * 0.1;
      head.rotation.x += 0.18;
      head.rotation.z += (variant - 0.5) * 0.7;
      root.updateMatrixWorld(true);
      root.worldToLocal(head.getWorldPosition(headLocal));
      camera.position.copy(headLocal).add(CAMCORDER_FROM_HEAD);
      camera.rotation.set(0, (variant - 0.5) * 0.25, (variant - 0.5) * 0.35);
      solveTwoBone(right[0], right[1], right[2], toWorld(camera.position.clone().add(RIGHT_WRIST_FROM_CAMCORDER)), toWorld(RIGHT_POLE));
      solveTwoBone(left[0], left[1], left[2], toWorld(camera.position.clone().add(LEFT_WRIST_FROM_CAMCORDER)), toWorld(LEFT_POLE));
    },
  };
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpPole = new THREE.Vector3();
const tmpElbow = new THREE.Vector3();

/** IK analytique à deux os (épaule-coude-poignet) : coude dans le plan de `pole`. */
function solveTwoBone(upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3): void {
  upper.getWorldPosition(tmpA);
  lower.getWorldPosition(tmpB);
  end.getWorldPosition(tmpC);
  const upperLength = tmpA.distanceTo(tmpB);
  const lowerLength = tmpB.distanceTo(tmpC);
  const distance = THREE.MathUtils.clamp(tmpA.distanceTo(target), 0.02, upperLength + lowerLength - 0.001);
  const cosAngle = THREE.MathUtils.clamp((upperLength ** 2 + distance ** 2 - lowerLength ** 2) / (2 * upperLength * distance), -1, 1);
  tmpDir.subVectors(target, tmpA).normalize();
  tmpPole.subVectors(pole, tmpA);
  tmpPole.addScaledVector(tmpDir, -tmpPole.dot(tmpDir)).normalize();
  tmpElbow
    .copy(tmpA)
    .addScaledVector(tmpDir, cosAngle * upperLength)
    .addScaledVector(tmpPole, Math.sqrt(1 - cosAngle * cosAngle) * upperLength);
  aimBone(upper, tmpB, tmpElbow);
  lower.getWorldPosition(tmpB);
  end.getWorldPosition(tmpC);
  aimBone(lower, tmpC, target);
}

const aimFrom = new THREE.Vector3();
const aimTo = new THREE.Vector3();
const aimOrigin = new THREE.Vector3();
const aimRotation = new THREE.Quaternion();
const boneWorld = new THREE.Quaternion();
const parentWorld = new THREE.Quaternion();

/** Tourne `bone` pour que son enfant (actuellement en `childPosition`) pointe vers `target`. */
function aimBone(bone: THREE.Bone, childPosition: THREE.Vector3, target: THREE.Vector3): void {
  bone.getWorldPosition(aimOrigin);
  aimFrom.subVectors(childPosition, aimOrigin).normalize();
  aimTo.subVectors(target, aimOrigin).normalize();
  aimRotation.setFromUnitVectors(aimFrom, aimTo);
  bone.getWorldQuaternion(boneWorld);
  bone.parent!.getWorldQuaternion(parentWorld);
  bone.quaternion.copy(parentWorld.invert().multiply(aimRotation.multiply(boneWorld)));
  bone.updateMatrixWorld(true);
}
