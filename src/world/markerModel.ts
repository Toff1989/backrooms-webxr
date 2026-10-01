import * as THREE from "three";

/**
 * Marqueur : un stylo (modèle CC0 Poly Haven « Stationery Supplies », nœud `pen_fancy`) tenu comme un
 * stylo — la mine pointe toujours vers l'avant de la manette (voir la prise "stylo" de
 * `GrabSystem`). Le modèle est couché le long de X, mine côté -X : on le redresse le long de +Y, mine
 * en haut, centré sur son milieu, pour que `MARKER_HALF_LENGTH` donne la position de la mine.
 */
/** Demi-longueur (m) du stylo à l'échelle 1 : distance du centre à la mine. */
export const MARKER_HALF_LENGTH = 0.0657;
/** Point de saisie (m, le long de l'axe, à l'échelle 1) : le tiers arrière, la mine dépasse de la main. */
export const MARKER_GRIP_OFFSET = -0.022;

/** Encres du marqueur : écrire en noir, ou effacer. */
export const MARKER_INKS: ReadonlyArray<{ id: "black" | "eraser"; color: string | null }> = [
  { id: "black", color: "#141414" },
  { id: "eraser", color: null },
];

export function orientMarkerTemplate(template: THREE.Object3D): THREE.Object3D {
  const inner = new THREE.Group();
  inner.add(template);
  // -X (mine) -> +Y.
  inner.rotation.z = -Math.PI / 2;
  inner.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(inner).getCenter(new THREE.Vector3());
  inner.position.sub(center);
  const root = new THREE.Group();
  root.name = "marker";
  root.add(inner);
  root.updateMatrixWorld(true);
  return root;
}
