import * as THREE from "three";
import { ConvexHull } from "three/addons/math/ConvexHull.js";

export interface ModelShape {
  /** Sommets de l'enveloppe convexe (espace local du modèle), x,y,z à plat. */
  hull: Float32Array;
  /** Boîte englobante locale (dimensions du modèle à l'échelle 1). */
  box: THREE.Box3;
}

/** Quantification pour dédoublonner les sommets avant le calcul d'enveloppe (4 mm). */
const QUANTUM = 0.004;
const MAX_INPUT_POINTS = 6000;
/**
 * Clé numérique d'un sommet quantifié (au lieu d'une chaîne "x,y,z") : 2 à 3 fois plus
 * rapide (mesuré sur 60 000 sommets), mêmes sommets retenus. Exacte tant que chaque coordonnée
 * quantifiée tient dans ±KEY_OFFSET (±262 m) : la clé reste un entier sûr (< 2^53).
 */
const KEY_RANGE = 131072;
const KEY_OFFSET = KEY_RANGE / 2;

function vertexKey(x: number, y: number, z: number): number | string {
  const ix = Math.round(x / QUANTUM);
  const iy = Math.round(y / QUANTUM);
  const iz = Math.round(z / QUANTUM);
  if (Math.abs(ix) >= KEY_OFFSET || Math.abs(iy) >= KEY_OFFSET || Math.abs(iz) >= KEY_OFFSET) return `${ix},${iy},${iz}`;
  return ix + KEY_OFFSET + (iy + KEY_OFFSET) * KEY_RANGE + (iz + KEY_OFFSET) * KEY_RANGE * KEY_RANGE;
}

const cache = new WeakMap<THREE.Object3D, ModelShape>();

/**
 * Enveloppe convexe d'un modèle glTF (calculée une seule fois par template, en espace local) :
 * forme de collision fidèle pour la physique — une canette roule, une clé à molette reste
 * à plat — plutôt qu'une boîte englobante qui ferait basculer tout objet comme un cube.
 */
export function getModelShape(template: THREE.Object3D): ModelShape {
  // Précalculée au démarrage pour tous les modèles (voir `warmup.ts`) : ce calcul (jusqu'à
  // plusieurs dizaines de ms sur Quest) ne tombe plus au premier spawn d'un type d'objet.
  const cached = cache.get(template);
  if (cached) return cached;

  template.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const seen = new Set<number | string>();
  const points: THREE.Vector3[] = [];
  const vertex = new THREE.Vector3();
  const toRoot = new THREE.Matrix4();

  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute("position");
    if (!position) return;
    toRoot.multiplyMatrices(rootInverse, object.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(toRoot);
      const key = vertexKey(vertex.x, vertex.y, vertex.z);
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(vertex.clone());
    }
  });

  const stride = Math.max(1, Math.ceil(points.length / MAX_INPUT_POINTS));
  const sampled = stride === 1 ? points : points.filter((_, index) => index % stride === 0);
  const box = new THREE.Box3().setFromPoints(points);

  const hullPoints: number[] = [];
  const hull = new ConvexHull().setFromPoints(sampled);
  const unique = new Set<THREE.Vector3>();
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      unique.add(edge.head().point);
      edge = edge.next;
    } while (edge !== face.edge);
  }
  for (const point of unique) hullPoints.push(point.x, point.y, point.z);

  const shape: ModelShape = { hull: new Float32Array(hullPoints), box };
  cache.set(template, shape);
  return shape;
}

/** Copie de l'enveloppe mise à l'échelle (objets de collection à échelle variable). */
export function scaledHull(shape: ModelShape, scale: number): Float32Array {
  if (scale === 1) return shape.hull;
  const out = new Float32Array(shape.hull.length);
  for (let i = 0; i < out.length; i++) out[i] = shape.hull[i]! * scale;
  return out;
}
