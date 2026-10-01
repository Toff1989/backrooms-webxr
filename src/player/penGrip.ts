import * as THREE from "three";
import { GRIP_ROTATION_X } from "./handModel";
import type { Handedness } from "./xrInput";

/**
 * Prise "stylo" : orientation du marqueur dans l'espace grip de la manette, fixée une fois pour
 * toutes (et non plus déduite de la façon dont le stylo gisait ou de la visée à l'instant de la
 * saisie) : la mine pointe toujours du même côté de la main, quelle que soit la façon dont il
 * a été attrapé, et à l'identique pour les deux mains (rotation autour de X, symétrique).
 *
 * Point de départ : la visée (doigts tendus de la main modèle, voir `GRIP_ROTATION_X`) ; on
 * tourne ensuite la mine de `PEN_TILT` autour de l'axe de la paume : à 0, le stylo prolonge les
 * doigts comme une baguette ; à 90°, il est perpendiculaire aux doigts, mine côté pouce ;
 * à 270°, mine côté auriculaire (couteau en piolet). Réglé à 250° : presque perpendiculaire,
 * mine vers le bas et légèrement vers le poignet.
 */
export const PEN_TILT = THREE.MathUtils.degToRad(250);

/**
 * Où le stylo traverse la main, dans l'espace grip : le creux du poing de la main modèle
 * (au milieu des doigts repliés, entre la paume et les pulpes), pas le point "paume" utilisé
 * pour saisir les autres objets — le stylo y était posé à côté du poing au lieu d'être serré dedans.
 * Main gauche : même point, symétrique en X.
 */
export const PEN_HOLD_POINT: Record<Handedness, THREE.Vector3> = {
  right: new THREE.Vector3(0.003, 0.034, -0.016),
  left: new THREE.Vector3(-0.003, 0.034, -0.016),
};

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Direction de la mine dans l'espace grip pour un relèvement donné. */
export function penTipDirection(tilt = PEN_TILT, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(0, -1, 0).applyAxisAngle(X_AXIS, GRIP_ROTATION_X + tilt);
}

/** Rotation du modèle (mine = +Y) vers l'espace grip : `main.quaternion × résultat` donne l'orientation monde du stylo. */
export function penGripQuaternion(tilt = PEN_TILT, target = new THREE.Quaternion()): THREE.Quaternion {
  return target.setFromUnitVectors(Y_AXIS, penTipDirection(tilt));
}
