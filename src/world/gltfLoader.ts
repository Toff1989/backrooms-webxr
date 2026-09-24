import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Loader glTF/Draco partagé : un seul décodeur Draco chargé pour tout le jeu, réutilisé
 * par le mobilier (`propLoader.ts`) et les objets de collection (`collectibleLoader.ts`).
 */
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/draco/");

export const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

/**
 * Charge un modèle et le prépare comme template : effet VHS sur ses matériaux, et toutes ses
 * pièces fusionnées en un mesh par matériau (une chaise en 12 morceaux = 12 draw calls par
 * chaise avant, 1 ou 2 après). Les transformations des nœuds sont appliquées aux sommets.
 */
export function loadTemplateModel(url: string): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => resolve(mergeByMaterial(gltf.scene)),
      undefined,
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function mergeByMaterial(root: THREE.Object3D): THREE.Object3D {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const geometry = (object.geometry as THREE.BufferGeometry).clone();
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInverse, object.matrixWorld));
    const list = groups.get(object.material) ?? [];
    list.push(geometry);
    groups.set(object.material, list);
  });

  const merged = new THREE.Group();
  for (const [material, geometries] of groups) {
    if (material instanceof THREE.MeshStandardMaterial) applyVhsEffect(material);
    // mergeGeometries exige des géométries toutes indexées (ou toutes non indexées).
    const anyNonIndexed = geometries.some((geometry) => geometry.index === null);
    const normalized = anyNonIndexed ? geometries.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry)) : geometries;
    const combined = normalized.length === 1 ? normalized[0]! : mergeGeometries(normalized, false);
    if (combined) {
      merged.add(new THREE.Mesh(combined, material));
    } else {
      // Attributs incompatibles : on garde les pièces séparées plutôt que de perdre le modèle.
      for (const geometry of normalized) merged.add(new THREE.Mesh(geometry, material));
    }
  }
  return merged;
}
