import * as THREE from "three";
import { applyVhsEffect } from "./vhsMaterial";

/** Longueur totale (m) du marqueur : mine à +Y, capuchon à -Y dans l'espace local du modèle. */
export const MARKER_LENGTH = 0.15;
export const MARKER_HALF_LENGTH = MARKER_LENGTH / 2;
const BODY_RADIUS = 0.0095;
const BODY_LENGTH = 0.11;

/** Couleurs d'encre du marqueur ; `null` = la gomme (efface les traits). */
export const MARKER_INKS: ReadonlyArray<{ id: string; color: string | null }> = [
  { id: "black", color: "#141414" },
  { id: "red", color: "#c0281d" },
  { id: "blue", color: "#254a9c" },
  { id: "green", color: "#2d7f45" },
  { id: "eraser", color: null },
];

let inkMaterial: THREE.MeshStandardMaterial | null = null;

function sharedInkMaterial(): THREE.MeshStandardMaterial {
  if (!inkMaterial) {
    inkMaterial = new THREE.MeshStandardMaterial({ color: MARKER_INKS[0]!.color!, roughness: 0.4, metalness: 0.05, emissive: 0x000000 });
    applyVhsEffect(inkMaterial);
  }
  return inkMaterial;
}

/**
 * Couleur du capuchon et de la mine, partagée par toutes les instances (le modèle est cloné
 * avec ses matériaux : la miniature de l'inventaire suit donc l'encre choisie). La gomme est blanche.
 */
export function setMarkerInk(color: string | null): void {
  sharedInkMaterial().color.set(color ?? "#e8e4d8");
}

/**
 * Marqueur de tableau (procédural, pas de modèle glTF) : corps gris, capuchon coloré à un bout,
 * mine feutre de l'autre. Le groupe `markerInner` est retourné de 180° quand la mine tenue
 * par la main n'est pas celle du modèle (voir `interactions.ts`) : on écrit toujours avec le
 * bout qui dépasse de la main.
 */
export function createMarkerModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = "marker";
  const inner = new THREE.Group();
  inner.name = "markerInner";
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xcfcab8, roughness: 0.55, metalness: 0.05 });
  applyVhsEffect(bodyMaterial);
  const ink = sharedInkMaterial();

  const body = new THREE.Mesh(new THREE.CylinderGeometry(BODY_RADIUS, BODY_RADIUS, BODY_LENGTH, 14), bodyMaterial);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0065, 0.022, 12), ink);
  tip.position.y = BODY_LENGTH / 2 + 0.011;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(BODY_RADIUS * 1.12, BODY_RADIUS * 1.12, 0.032, 14), ink);
  cap.position.y = -BODY_LENGTH / 2 - 0.016;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(BODY_RADIUS * 1.04, BODY_RADIUS * 1.04, 0.026, 14), ink);
  band.position.y = 0.012;
  inner.add(body, tip, cap, band);
  root.add(inner);
  return root;
}
