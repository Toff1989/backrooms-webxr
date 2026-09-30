import * as THREE from "three";
import cadreurUrl from "../assets/models/entities/cadreur.glb";
import cadreurSuitUrl from "../assets/models/entities/cadreur-suit.glb";
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
const CAMCORDER_SCALE = 3;
/** Relèvement de la tête-caméra sur le corps en costume, pour montrer un cou (m). */
const SUIT_NECK_LIFT = 0.14;
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

export interface LoadCadreurOptions {
  /** Corps d'homme en costume (squelette Mixamo-like, marche transférée depuis le mannequin). */
  suit?: boolean;
}

export async function loadCadreur(options: LoadCadreurOptions = {}): Promise<CadreurRig> {
  const [mannequin, camcorder] = await Promise.all([gltfLoader.loadAsync(cadreurUrl), spawnCollectibleModel("cadreurHead")]);
  let gltf = mannequin;
  if (options.suit) {
    const suit = await gltfLoader.loadAsync(cadreurSuitUrl);
    const clips = retargetWalk(mannequin, suit.scene);
    gltf = { ...suit, animations: clips } as typeof suit;
  }
  const character = gltf.scene;
  if (!options.suit) character.scale.setScalar(BODY_SCALE);
  else character.scale.multiplyScalar(BODY_SCALE * suitHeightRatio(mannequin.scene, character));
  const skin = new THREE.MeshStandardMaterial({ color: 0x15110d, roughness: 0.38, metalness: 0.05 });
  const joints = new THREE.MeshStandardMaterial({ color: 0x0b0907, roughness: 0.55, metalness: 0.05 });
  applyVhsEffect(skin);
  applyVhsEffect(joints);
  character.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) {
      if (options.suit) {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) if (material instanceof THREE.MeshStandardMaterial) applyVhsEffect(material);
      } else {
        object.material = object.name.includes("Joints") ? joints : skin;
      }
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
  camera.position.copy(head.position).add(new THREE.Vector3(0, 0.01 / neckScale, 0.04 / neckScale));
  camera.quaternion.copy(neck.getWorldQuaternion(new THREE.Quaternion()).invert());
  // Corps en costume : la caméra est relevée pour laisser voir un cou entre le col et le boîtier.
  if (options.suit) camera.position.add(new THREE.Vector3(0, SUIT_NECK_LIFT / neckScale, 0).applyQuaternion(camera.quaternion));
  neck.add(camera);

  // Le crâne écrasé emporte le cou du modèle en costume : on lui rend un cou (tronc de cône de
  // peau blafarde) qui monte du col jusque dans le boîtier de la caméra.
  if (options.suit) {
    const neckLength = head.position.length() + (0.09 + SUIT_NECK_LIFT) / neckScale;
    const neckMaterial = new THREE.MeshStandardMaterial({ color: 0x7a6a5c, roughness: 0.7, side: THREE.DoubleSide });
    applyVhsEffect(neckMaterial);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.046 / neckScale, 0.058 / neckScale, neckLength, 12, 1, true), neckMaterial);
    stem.position.set(0, neckLength / 2 - 0.03 / neckScale, 0.005 / neckScale);
    stem.position.applyQuaternion(camera.quaternion);
    stem.quaternion.copy(camera.quaternion);
    stem.name = "cadreurNeck";
    neck.add(stem);
  }

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

/** "Hips_01" -> "mixamorigHips" (Sketchfab suffixe les os d'un _NN). */
const mixamoName = (name: string): string => `mixamorig${name.replace(/_\d+$/, "")}`;

/** Rapport de taille (os Head, monde) entre le mannequin et le corps en costume. */
function suitHeightRatio(mannequin: THREE.Object3D, suit: THREE.Object3D): number {
  mannequin.updateMatrixWorld(true);
  suit.updateMatrixWorld(true);
  const height = (root: THREE.Object3D, name: string): number => {
    const bone = root.getObjectByName(name);
    return bone ? bone.getWorldPosition(new THREE.Vector3()).y : 1;
  };
  const suitHead = [...boneList(suit)].find((b) => mixamoName(b.name) === "mixamorigHead");
  const suitY = suitHead ? suitHead.getWorldPosition(new THREE.Vector3()).y : 1.7;
  return height(mannequin, "mixamorigHead") / suitY;
}

function boneList(root: THREE.Object3D): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Bone) bones.push(o);
  });
  return bones;
}

/**
 * Transfère le clip "walk" du mannequin vers le squelette du costume : renomme les os en
 * `mixamorig*`, puis rejoue la marche en monde (delta d'orientation par rapport à la pose de
 * repos) pour tenir compte des poses de repos différentes.
 */
function retargetWalk(source: { scene: THREE.Group; animations: THREE.AnimationClip[] }, target: THREE.Group): THREE.AnimationClip[] {
  const targetBones = boneList(target);
  for (const b of targetBones) b.name = mixamoName(b.name);
  const srcBones = boneList(source.scene);
  const clip = source.animations.find((c) => c.name === "walk") ?? source.animations[0]!;

  source.scene.updateMatrixWorld(true);
  target.updateMatrixWorld(true);
  const srcByName = new Map(srcBones.map((b) => [b.name, b]));
  const pairs = targetBones.flatMap((t) => {
    const s = srcByName.get(t.name);
    return s ? [{ s, t }] : [];
  });
  const q = () => new THREE.Quaternion();
  const restSrc = new Map(pairs.map(({ s }) => [s, s.getWorldQuaternion(q())]));
  const restDst = new Map(pairs.map(({ t }) => [t, t.getWorldQuaternion(q())]));
  const hipsSrc = srcByName.get("mixamorigHips")!;
  const hipsDst = targetBones.find((b) => b.name === "mixamorigHips")!;
  const hipsSrcRest = hipsSrc.getWorldPosition(new THREE.Vector3());
  const hipsDstRest = hipsDst.getWorldPosition(new THREE.Vector3());
  const ratio = hipsDstRest.y / hipsSrcRest.y;

  const fps = 30;
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = Array.from({ length: frames }, (_, i) => (i / (frames - 1)) * clip.duration);
  const quatValues = new Map(pairs.map(({ t }) => [t, new Float32Array(frames * 4)]));
  const hipsValues = new Float32Array(frames * 3);

  const mixer = new THREE.AnimationMixer(source.scene);
  mixer.clipAction(clip).play();
  const delta = q();
  const world = q();
  const parentWorld = q();
  const local = q();
  const tmp = new THREE.Vector3();
  const rest = new Map(pairs.map(({ t }) => [t, t.quaternion.clone()]));
  for (let f = 0; f < frames; f++) {
    mixer.setTime(times[f]!);
    source.scene.updateMatrixWorld(true);
    // Les os sont traités parents d'abord (ordre du parcours) : on compose les mondes cibles.
    const dstWorld = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const t of targetBones) {
      const pair = pairs.find((p) => p.t === t);
      const parent = t.parent;
      const parentQ = parent && dstWorld.has(parent) ? dstWorld.get(parent)! : parent ? parent.getWorldQuaternion(parentWorld.clone()) : q();
      if (pair) {
        pair.s.getWorldQuaternion(delta).multiply(restSrc.get(pair.s)!.clone().invert());
        world.copy(delta).multiply(restDst.get(t)!);
        local.copy(parentQ).invert().multiply(world);
        dstWorld.set(t, world.clone());
        local.toArray(quatValues.get(t)!, f * 4);
      } else {
        // Os sans équivalent (jumelles d'avant-bras...) : reste en pose de repos locale.
        const r = rest.get(t) ?? t.quaternion;
        dstWorld.set(t, parentQ.clone().multiply(r));
      }
    }
    hipsSrc.getWorldPosition(tmp).sub(hipsSrcRest).multiplyScalar(ratio);
    tmp.toArray(hipsValues, f * 3);
  }
  const tracks: THREE.KeyframeTrack[] = pairs.map(({ t }) => new THREE.QuaternionKeyframeTrack(`${t.name}.quaternion`, times, quatValues.get(t)!));
  const hipsBase = hipsDst.position;
  const hipsTrack = new Float32Array(hipsValues.length);
  for (let f = 0; f < frames; f++) {
    hipsTrack[f * 3] = hipsBase.x + hipsValues[f * 3]! / character_scale(target);
    hipsTrack[f * 3 + 1] = hipsBase.y + hipsValues[f * 3 + 1]! / character_scale(target);
    hipsTrack[f * 3 + 2] = hipsBase.z + hipsValues[f * 3 + 2]! / character_scale(target);
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${hipsDst.name}.position`, times, hipsTrack));
  return [new THREE.AnimationClip("walk", clip.duration, tracks)];
}

const character_scale = (target: THREE.Object3D): number => (target.getWorldScale(new THREE.Vector3()).y || 1);
