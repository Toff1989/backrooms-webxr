import * as THREE from "three";
import cabinetUrl from "../assets/models/cabinet.glb";
import chairUrl from "../assets/models/chair.glb";
import officeDeskUrl from "../assets/models/officedesk.glb";
import schoolDeskUrl from "../assets/models/schooldesk.glb";
import type { PropKind } from "../shared/props";
import { gltfLoader } from "./gltfLoader";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Mobilier décoratif (fiche étape 6, décor inspiré des images de référence) : modèles
 * CC0 (Poly Haven), décimés + compressés Draco + textures WebP via gltf-transform.
 * Un seul chargement par type de meuble (`loadTemplate`), toutes les instances
 * suivantes clonent la hiérarchie en partageant géométrie/matériaux (pas de recopie
 * GPU par meuble placé).
 */
const PROP_URLS: Record<PropKind, string> = {
  chair: chairUrl,
  schoolDesk: schoolDeskUrl,
  officeDesk: officeDeskUrl,
  cabinet: cabinetUrl,
};

const templateCache = new Map<PropKind, Promise<THREE.Object3D>>();

function loadTemplate(kind: PropKind): Promise<THREE.Object3D> {
  let cached = templateCache.get(kind);
  if (cached) return cached;

  cached = new Promise((resolve, reject) => {
    gltfLoader.load(
      PROP_URLS[kind],
      (gltf) => {
        const root = gltf.scene;
        root.traverse((object) => {
          if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
            applyVhsEffect(object.material);
          }
        });
        resolve(root);
      },
      undefined,
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
  templateCache.set(kind, cached);
  return cached;
}

/** Instancie un meuble ; géométrie et matériaux restent partagés avec le template (retourné pour la forme physique). */
export async function spawnProp(kind: PropKind): Promise<{ model: THREE.Object3D; template: THREE.Object3D }> {
  const template = await loadTemplate(kind);
  return { model: template.clone(true), template };
}
