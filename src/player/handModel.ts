import * as THREE from "three";
import leftHandUrl from "../assets/models/hands/left.glb";
import rightHandUrl from "../assets/models/hands/right.glb";
import { gltfLoader } from "../world/gltfLoader";
import { applyVhsEffect } from "../world/vhsMaterial";
import type { Handedness } from "./xrInput";

/**
 * Chaîne d'articulations d'un doigt : les os du modèle (profil WebXR "generic-hand", MIT)
 * sont tous enfants directs de l'armature — aucune hiérarchie — donc la flexion se fait
 * en cinématique directe : chaque articulation pliée fait tourner tout ce qui la suit.
 */
interface FingerChain {
  bones: THREE.Object3D[];
  bindPositions: THREE.Vector3[];
  bindQuaternions: THREE.Quaternion[];
  /** Angle de flexion max (rad) par articulation (0 = rigide), appliqué × l'intensité de la pose. */
  maxAngles: number[];
}

const deg = THREE.MathUtils.degToRad;

/** Flexion vers la paume = rotation négative autour de l'axe X local de l'articulation (-Z suit l'os, +Y = dos de la main). */
const FINGER_ANGLES = [0, deg(-72), deg(-88), deg(-55), 0];
const THUMB_ANGLES = [deg(-18), deg(-32), deg(-38), 0];

const FINGER_JOINTS = (finger: string): string[] => [
  `${finger}-finger-metacarpal`,
  `${finger}-finger-phalanx-proximal`,
  `${finger}-finger-phalanx-intermediate`,
  `${finger}-finger-phalanx-distal`,
  `${finger}-finger-tip`,
];
const THUMB_JOINTS = ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"];

/**
 * Position de l'armature dans l'espace "grip" WebXR (origine au centre des doigts repliés,
 * -Z vers le pouce le long de la manette, +X = dos de la main droite / -X gauche) : les axes
 * du modèle coïncident déjà avec ceux du grip, seul un décalage place la paume sur la manette.
 */
const GRIP_OFFSET: Record<Handedness, THREE.Vector3> = {
  right: new THREE.Vector3(-0.008, 0.045, -0.012),
  left: new THREE.Vector3(0.008, 0.045, -0.012),
};

const GLOVE_COLOR = 0x2c2622;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const tmpQuat = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();
const tmpStep = new THREE.Quaternion();
const tmpOffset = new THREE.Vector3();

export class HandModel {
  readonly root: THREE.Object3D;
  private readonly index: FingerChain;
  private readonly grip: FingerChain[];
  private readonly thumb: FingerChain;
  private readonly indexTip: THREE.Object3D;

  private constructor(root: THREE.Object3D, handedness: Handedness) {
    this.root = root;
    root.position.copy(GRIP_OFFSET[handedness]);

    const byName = new Map<string, THREE.Object3D>();
    root.traverse((object) => {
      byName.set(object.name, object);
      if (object instanceof THREE.SkinnedMesh) {
        const material = new THREE.MeshStandardMaterial({ color: GLOVE_COLOR, roughness: 0.78, metalness: 0.02 });
        applyVhsEffect(material);
        object.material = material;
        object.frustumCulled = false;
      }
    });

    const chain = (names: string[], angles: number[]): FingerChain => {
      const bones = names.map((name) => {
        const bone = byName.get(name);
        if (!bone) throw new Error(`Articulation "${name}" absente du modèle de main`);
        return bone;
      });
      return {
        bones,
        bindPositions: bones.map((bone) => bone.position.clone()),
        bindQuaternions: bones.map((bone) => bone.quaternion.clone()),
        maxAngles: angles,
      };
    };

    this.index = chain(FINGER_JOINTS("index"), FINGER_ANGLES);
    this.grip = ["middle", "ring", "pinky"].map((finger) => chain(FINGER_JOINTS(finger), FINGER_ANGLES));
    this.thumb = chain(THUMB_JOINTS, THUMB_ANGLES);
    this.indexTip = this.index.bones[this.index.bones.length - 1]!;
  }

  static async load(handedness: Handedness): Promise<HandModel> {
    const gltf = await gltfLoader.loadAsync(handedness === "left" ? leftHandUrl : rightHandUrl);
    return new HandModel(gltf.scene, handedness);
  }

  /** Pose des doigts : index (gâchette), majeur/annulaire/auriculaire (grip), pouce, chacun de 0 (ouvert) à 1 (replié). */
  setPose(index: number, grip: number, thumb: number): void {
    applyChain(this.index, index);
    for (const finger of this.grip) applyChain(finger, grip);
    applyChain(this.thumb, thumb);
  }

  getIndexTipWorld(target: THREE.Vector3): THREE.Vector3 {
    return this.indexTip.getWorldPosition(target);
  }
}

function applyChain(chain: FingerChain, curl: number): void {
  const rotation = tmpQuat.identity();
  const position = tmpOffset.copy(chain.bindPositions[0]!);
  const next = new THREE.Vector3();

  for (let k = 0; k < chain.bones.length; k++) {
    const bindQuat = chain.bindQuaternions[k]!;
    const angle = chain.maxAngles[k]! * curl;
    if (angle !== 0) {
      // Axe de flexion = X local de l'articulation, dans sa pose déjà pliée par les précédentes.
      tmpAxis.copy(X_AXIS).applyQuaternion(tmpStep.multiplyQuaternions(rotation, bindQuat)).normalize();
      tmpStep.setFromAxisAngle(tmpAxis, angle);
      rotation.premultiply(tmpStep);
    }
    const bone = chain.bones[k]!;
    bone.position.copy(position);
    bone.quaternion.multiplyQuaternions(rotation, bindQuat);

    const nextBind = chain.bindPositions[k + 1];
    if (nextBind) {
      next.subVectors(nextBind, chain.bindPositions[k]!).applyQuaternion(rotation);
      position.add(next);
    }
  }
}
