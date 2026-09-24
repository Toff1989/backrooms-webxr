import * as THREE from "three";
import cadreurUrl from "../assets/models/entities/cadreur.glb";
import { spawnCollectibleModel } from "./collectibleLoader";
import { gltfLoader } from "./gltfLoader";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Le Cadreur, monstre : un mannequin (rig Mixamo "X Bot", décimé + Draco) d'un brun presque
 * noir et luisant, plus grand qu'un homme, dont la tête est une vieille caméra 8 mm vissée sur
 * le cou — l'objectif est son visage, la LED "REC" son œil. Bras trop longs qui pendent,
 * doigts crispés, dos voûté.
 *
 * Démarche humanoïde (cycle de marche Mixamo) rendue malsaine : il boite (une jambe traîne),
 * s'arrête net par à-coups puis repart d'un coup, et sa tête-caméra se tord pour rester braquée
 * sur le joueur, avec des tressautements secs. Le déplacement suit exactement l'avancée de
 * l'animation (pas de pieds qui glissent).
 */

/** Taille du monstre (le mannequin mesure 1,81 m). */
const BODY_SCALE = 1.12;
/** Distance parcourue par cycle de marche de l'animation (m, à l'échelle du monstre). */
const STRIDE_LENGTH = 1.35 * BODY_SCALE;
const CAMCORDER_SCALE = 1.9;
/** Allongement des avant-bras. */
const FOREARM_STRETCH = 1.35;
/** Dos voûté, tête rentrée (radians). */
const STOOP = 0.32;
/** Rotation maximale de la tête-caméra par rapport au corps pour suivre le joueur. */
const MAX_HEAD_YAW = THREE.MathUtils.degToRad(80);

export interface CadreurStep {
  /** Distance parcourue pendant la frame (m). */
  distance: number;
  /** Un pied vient de toucher le sol. */
  footstep: boolean;
}

export interface CadreurRig {
  root: THREE.Group;
  led: THREE.Mesh;
  /**
   * Anime une frame. `speed` : vitesse voulue (m/s), 0 = figé (la tête tressaute encore).
   * `lookAt` : point monde que la tête-caméra fixe.
   */
  update(deltaSeconds: number, speed: number, lookAt: THREE.Vector3): CadreurStep;
}

export async function loadCadreur(): Promise<CadreurRig> {
  const [gltf, camcorder] = await Promise.all([gltfLoader.loadAsync(cadreurUrl), spawnCollectibleModel("videoCamera")]);
  const character = gltf.scene;
  character.scale.setScalar(BODY_SCALE);
  const skin = new THREE.MeshStandardMaterial({ color: 0x15110d, roughness: 0.38, metalness: 0.05 });
  const joints = new THREE.MeshStandardMaterial({ color: 0x0b0907, roughness: 0.55, metalness: 0.05 });
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
  const head = bone("Head");
  const neck = bone("Neck");
  const spine = bone("Spine1");
  const arms = (["Left", "Right"] as const).map((side) => ({
    side: side === "Left" ? 1 : -1,
    upper: bone(`${side}Arm`),
    lower: bone(`${side}ForeArm`),
    hand: bone(`${side}Hand`),
    fingers: ["Index", "Middle", "Ring", "Pinky"].flatMap((finger) => [1, 2, 3].map((n) => bone(`${side}Hand${finger}${n}`))),
  }));

  const root = new THREE.Group();
  root.add(character);
  root.updateMatrixWorld(true);

  // Plus de tête : le crâne est écrasé (voir `applyMonsterScales`), la caméra prend sa place sur le cou.
  const camera = camcorder.model;
  const neckScale = neck.getWorldScale(new THREE.Vector3()).x;
  camera.scale.setScalar(CAMCORDER_SCALE / neckScale);
  // Position : là où était la tête (repère du cou), un peu plus haut ; orientation : objectif
  // vers l'avant du corps en pose de référence, puis la caméra suit le cou.
  camera.position.copy(head.position).add(new THREE.Vector3(0, -0.05 / neckScale, 0.03 / neckScale));
  camera.quaternion.copy(neck.getWorldQuaternion(new THREE.Quaternion()).invert());
  neck.add(camera);

  const led = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false, toneMapped: false }));
  led.position.set(0.028, 0.07, 0.015);
  camera.add(led);

  // Échelles réappliquées après l'animation (le clip contient des pistes d'échelle) : crâne
  // écrasé, avant-bras trop longs (la main garde ses proportions).
  const applyMonsterScales = (): void => {
    head.scale.setScalar(0.001);
    for (const arm of arms) {
      arm.lower.scale.set(1, FOREARM_STRETCH, 1);
      arm.hand.scale.set(1, 1 / FOREARM_STRETCH, 1);
    }
  };

  // Pose de référence : chaque frame repart de là (voûte, bras, cou ne s'accumulent pas).
  const bones: THREE.Bone[] = [];
  character.traverse((object) => {
    if (object instanceof THREE.Bone) bones.push(object);
  });
  const restPose = bones.map((b) => b.quaternion.clone());

  const mixer = new THREE.AnimationMixer(character);
  const walk = gltf.animations.find((clip) => clip.name === "walk") ?? gltf.animations[0]!;
  const action = mixer.clipAction(walk);
  action.play();

  let time = Math.random() * walk.duration;
  let hitch = 0;
  let lurch = 0;
  let nextHitch = 1 + Math.random() * 2;
  let twitch = 0;
  let nextTwitch = 0.5;
  const twitchAxis = new THREE.Vector3();
  let twitchAngle = 0;
  let yaw = 0;

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    root,
    led,
    update(deltaSeconds, speed, lookAt) {
      let distance = 0;
      let footstep = false;
      if (speed > 0) {
        // À-coups : il s'arrête net une fraction de seconde, puis repart en titubant plus vite.
        nextHitch -= deltaSeconds;
        if (nextHitch <= 0) {
          hitch = 0.15 + Math.random() * 0.35;
          lurch = 0.35;
          nextHitch = 0.9 + Math.random() * 2.2;
        }
        let rate = speed / STRIDE_LENGTH;
        if (hitch > 0) {
          hitch -= deltaSeconds;
          rate = 0;
        } else if (lurch > 0) {
          lurch -= deltaSeconds;
          rate *= 1.7;
        }
        // Boiterie : la moitié du cycle (jambe blessée) est bien plus lente.
        const phase = time / walk.duration;
        const limp = phase % 1 < 0.5 ? 0.55 : 1.45;
        const before = Math.floor(phase * 2);
        const advance = rate * limp * deltaSeconds;
        time += advance * walk.duration;
        distance = advance * STRIDE_LENGTH;
        footstep = Math.floor((time / walk.duration) * 2) !== before;
      }
      bones.forEach((b, i) => b.quaternion.copy(restPose[i]!));
      action.time = time % walk.duration;
      mixer.update(0);
      applyMonsterScales();

      // Dos voûté, bras ballants : le cycle de marche ne garde qu'un léger balancement.
      spine.rotation.x += STOOP;
      neck.rotation.x += 0.15;
      root.updateMatrixWorld(true);
      const swing = Math.sin((time / walk.duration) * Math.PI * 2);
      for (const arm of arms) {
        arm.upper.getWorldPosition(tmpA);
        tmpB.set(arm.side * 0.12, -0.55, 0.08 + swing * arm.side * 0.06).applyQuaternion(root.quaternion).add(tmpA);
        aimBone(arm.upper, arm.lower, tmpB);
        arm.lower.getWorldPosition(tmpA);
        tmpB.set(arm.side * 0.02, -0.5, 0.14).applyQuaternion(root.quaternion).add(tmpA);
        aimBone(arm.lower, arm.hand, tmpB);
        for (const finger of arm.fingers) finger.rotation.z += arm.side * 0.55;
      }

      // Tête-caméra braquée sur le joueur (dans la limite du cou), avec tressautements secs.
      tmpA.subVectors(lookAt, root.position);
      const wanted = THREE.MathUtils.clamp(
        THREE.MathUtils.euclideanModulo(Math.atan2(tmpA.x, tmpA.z) - root.rotation.y + Math.PI, Math.PI * 2) - Math.PI,
        -MAX_HEAD_YAW,
        MAX_HEAD_YAW,
      );
      yaw = THREE.MathUtils.damp(yaw, wanted, 6, deltaSeconds);
      nextTwitch -= deltaSeconds;
      if (nextTwitch <= 0) {
        twitch = 0.08 + Math.random() * 0.2;
        twitchAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        twitchAngle = 0.25 + Math.random() * 0.45;
        nextTwitch = speed > 0 ? 0.8 + Math.random() * 2.5 : 0.3 + Math.random() * 1.2;
      }
      neck.getWorldQuaternion(tmpQ);
      tmpQ.premultiply(turn.setFromAxisAngle(up, yaw));
      if (twitch > 0) {
        twitch -= deltaSeconds;
        tmpQ.premultiply(turn.setFromAxisAngle(twitchAxis, twitchAngle));
      }
      setWorldQuaternion(neck, tmpQ);
      return { distance, footstep };
    },
  };
}

const aimOrigin = new THREE.Vector3();
const aimFrom = new THREE.Vector3();
const aimTo = new THREE.Vector3();
const aimRotation = new THREE.Quaternion();
const boneWorld = new THREE.Quaternion();

/** Tourne `bone` pour que son os enfant `child` pointe vers `target` (monde). */
function aimBone(bone: THREE.Bone, child: THREE.Object3D, target: THREE.Vector3): void {
  bone.getWorldPosition(aimOrigin);
  child.getWorldPosition(aimFrom).sub(aimOrigin).normalize();
  aimTo.subVectors(target, aimOrigin).normalize();
  aimRotation.setFromUnitVectors(aimFrom, aimTo);
  bone.getWorldQuaternion(boneWorld);
  setWorldQuaternion(bone, aimRotation.multiply(boneWorld));
}

const parentWorld = new THREE.Quaternion();

function setWorldQuaternion(object: THREE.Object3D, world: THREE.Quaternion): void {
  object.parent!.getWorldQuaternion(parentWorld);
  object.quaternion.copy(parentWorld.invert().multiply(world));
  object.updateMatrixWorld(true);
}
