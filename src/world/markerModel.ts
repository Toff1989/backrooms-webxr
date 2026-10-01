import * as THREE from "three";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Marqueur pour tableau blanc, modélisé en code (pas de modèle libre de droits trouvé) : corps
 * blanc avec une bande noire, nez conique, mine feutre noire, capuchon noir planté à l'arrière
 * avec son clip. Long axe = Y du modèle, mine en haut (+Y), centré sur son milieu — la prise
 * "stylo" de `GrabSystem` dirige +Y vers l'avant de la manette.
 */
/** Demi-longueur (m) à l'échelle 1 : distance du centre à la pointe de la mine. */
export const MARKER_HALF_LENGTH = 0.07;
/** Point de saisie (m, le long de l'axe, à l'échelle 1) : le tiers arrière, la mine dépasse de la main. */
export const MARKER_GRIP_OFFSET = -0.022;

/** Encres du marqueur : écrire en noir, ou effacer. */
export const MARKER_INKS: ReadonlyArray<{ id: "black" | "eraser"; color: string | null }> = [
  { id: "black", color: "#141414" },
  { id: "eraser", color: null },
];

let materials: { body: THREE.Material; band: THREE.Material; nose: THREE.Material; nib: THREE.Material; cap: THREE.Material } | null = null;

function sharedMaterials(): NonNullable<typeof materials> {
  if (!materials) {
    const make = (color: number, roughness: number, metalness = 0.05): THREE.MeshStandardMaterial => {
      const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      applyVhsEffect(material);
      return material;
    };
    materials = {
      body: make(0xf1f0ea, 0.35),
      band: make(0x1b1b1d, 0.4),
      nose: make(0xd9d8d2, 0.4),
      nib: make(0x101012, 0.8),
      cap: make(0x18181a, 0.3, 0.1),
    };
  }
  return materials;
}

/** Solide de révolution autour de Y à partir d'un profil (rayon, hauteur), de bas en haut. */
function lathe(profile: Array<[number, number]>, material: THREE.Material, segments = 20): THREE.Mesh {
  return new THREE.Mesh(new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), segments), material);
}

export function createMarkerModel(): THREE.Group {
  const { body, band, nose, nib, cap } = sharedMaterials();
  const root = new THREE.Group();
  root.name = "marker";
  // Corps : du pied du capuchon (y = -0,044) à la naissance du nez (y = 0,046).
  root.add(lathe([[0, -0.044], [0.0074, -0.044], [0.0078, -0.04], [0.0078, 0.04], [0.0072, 0.046], [0, 0.046]], body));
  // Bande d'étiquette noire (légèrement plus large que le corps).
  root.add(lathe([[0.0079, -0.03], [0.0083, -0.028], [0.0083, 0.016], [0.0079, 0.018]], band, 20));
  // Nez conique blanc cassé jusqu'à la mine.
  root.add(lathe([[0.0066, 0.046], [0.0058, 0.052], [0.0042, 0.0605], [0.0036, 0.0625]], nose, 20));
  // Mine feutre : bout rond, noir mat.
  root.add(lathe([[0.0036, 0.0625], [0.0033, 0.066], [0.0024, 0.0693], [0.0008, 0.07], [0, 0.07]], nib, 16));
  // Capuchon planté à l'arrière : cylindre noir légèrement conique, bout arrondi.
  root.add(lathe([[0, -0.07], [0.0066, -0.0695], [0.0088, -0.064], [0.0094, -0.05], [0.0094, -0.044], [0, -0.044]], cap, 20));
  // Clip du capuchon : fine languette collée au corps.
  const clip = new THREE.Mesh(new THREE.BoxGeometry(0.0022, 0.05, 0.0035), cap);
  clip.position.set(0.0102, -0.025, 0);
  root.add(clip);
  const clipHead = new THREE.Mesh(new THREE.BoxGeometry(0.0032, 0.004, 0.0045), cap);
  clipHead.position.set(0.0098, -0.0485, 0);
  root.add(clipHead);
  return root;
}
