import * as THREE from "three";

/** Surface plane d'un modèle (écran, tableau, cadran), en espace local du modèle. */
export interface ModelFace {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  /** Axe "haut" de la surface (dans son plan). */
  up: THREE.Vector3;
  width: number;
  height: number;
}

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

const cache = new WeakMap<object, Map<string, ModelFace | null>>();

/**
 * Trouve la face avant d'un modèle orientée vers `axis` (ou, sans axe, la plus grande face
 * plane parmi les six directions) : triangles tournés vers cet axe et proches de l'avant du
 * modèle, pondérés par leur aire. Sert à poser un écran, un message à la craie ou un cadran
 * par-dessus un modèle CC0 dont les pièces sont fusionnées (voir `gltfLoader`).
 */
export function findModelFace(template: THREE.Object3D, axis?: THREE.Vector3, candidates: readonly THREE.Vector3[] = AXES): ModelFace | null {
  const key = axis ? `${axis.x},${axis.y},${axis.z}` : `auto:${candidates.map((c) => `${c.x}${c.y}${c.z}`).join("|")}`;
  // Cache partagé par toutes les copies d'un modèle (elles partagent leur géométrie).
  let cacheOwner: object = template;
  template.traverse((object) => {
    if (cacheOwner === template && object instanceof THREE.Mesh) cacheOwner = object.geometry;
  });
  let perTemplate = cache.get(cacheOwner);
  if (!perTemplate) {
    perTemplate = new Map();
    cache.set(cacheOwner, perTemplate);
  }
  if (perTemplate.has(key)) return perTemplate.get(key)!;

  template.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const triangles: Array<{ a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; normal: THREE.Vector3; area: number }> = [];
  const toRoot = new THREE.Matrix4();
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute("position");
    if (!position) return;
    const index = object.geometry.getIndex();
    toRoot.multiplyMatrices(rootInverse, object.matrixWorld);
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const [ia, ib, ic] = index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2];
      const a = new THREE.Vector3().fromBufferAttribute(position, ia).applyMatrix4(toRoot);
      const b = new THREE.Vector3().fromBufferAttribute(position, ib).applyMatrix4(toRoot);
      const c = new THREE.Vector3().fromBufferAttribute(position, ic).applyMatrix4(toRoot);
      const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = cross.length() / 2;
      if (area < 1e-7) continue;
      triangles.push({ a, b, c, normal: cross.normalize(), area });
    }
  });

  const faceFor = (direction: THREE.Vector3): { face: ModelFace; area: number } | null => {
    const facing = triangles.filter((tri) => tri.normal.dot(direction) > 0.85);
    if (facing.length === 0) return null;
    // La tranche de profondeur (4 cm) qui porte la plus grande surface : la toile d'un écran de
    // projection plutôt que les pieds du trépied, l'écran d'une télé plutôt que ses boutons.
    const depthOf = (tri: (typeof facing)[number]): number => (tri.a.dot(direction) + tri.b.dot(direction) + tri.c.dot(direction)) / 3;
    const sorted = [...facing].sort((x, y) => depthOf(x) - depthOf(y));
    let bestArea = -1;
    let bestStart = 0;
    let bestEnd = 0;
    let windowArea = 0;
    for (let start = 0, end = 0; start < sorted.length; start++) {
      while (end < sorted.length && depthOf(sorted[end]!) - depthOf(sorted[start]!) <= 0.04) windowArea += sorted[end++]!.area;
      if (windowArea > bestArea) {
        bestArea = windowArea;
        bestStart = start;
        bestEnd = end;
      }
      windowArea -= sorted[start]!.area;
    }
    const kept = sorted.slice(bestStart, bestEnd);
    const normal = new THREE.Vector3();
    const center = new THREE.Vector3();
    let area = 0;
    for (const tri of kept) {
      normal.addScaledVector(tri.normal, tri.area);
      center.add(new THREE.Vector3().add(tri.a).add(tri.b).add(tri.c).multiplyScalar(tri.area / 3));
      area += tri.area;
    }
    normal.normalize();
    center.divideScalar(area);
    // Repère du plan : "haut" = l'axe Y du modèle projeté (ou Z pour une face horizontale).
    const reference = Math.abs(normal.y) > 0.8 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const up = reference.sub(normal.clone().multiplyScalar(reference.dot(normal))).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const offset = new THREE.Vector3();
    for (const tri of kept) {
      for (const point of [tri.a, tri.b, tri.c]) {
        offset.subVectors(point, center);
        const u = offset.dot(right);
        const v = offset.dot(up);
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
    center.addScaledVector(right, (minU + maxU) / 2).addScaledVector(up, (minV + maxV) / 2);
    // Posée juste devant la surface la plus avancée.
    const forward = Math.max(...kept.flatMap((tri) => [tri.a, tri.b, tri.c].map((p) => p.clone().sub(center).dot(normal))));
    center.addScaledVector(normal, forward + 0.002);
    return { face: { center, normal, up, width: maxU - minU, height: maxV - minV }, area };
  };

  let result: ModelFace | null = null;
  if (axis) result = faceFor(axis)?.face ?? null;
  else {
    let best = 0;
    for (const direction of candidates) {
      const found = faceFor(direction);
      if (found && found.area > best) {
        best = found.area;
        result = found.face;
      }
    }
  }
  perTemplate.set(key, result);
  return result;
}

/**
 * Plan texturé posé sur une face (écran, cadran...) : à ajouter comme enfant du modèle.
 * `shrink` réduit la surface (l'écran d'une télé est plus petit que sa façade).
 */
export function createFacePlane(face: ModelFace, material: THREE.Material, shrink = 1, aspect?: number): THREE.Mesh {
  let width = face.width * shrink;
  let height = face.height * shrink;
  if (aspect) {
    if (width / height > aspect) width = height * aspect;
    else height = width / aspect;
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  const right = new THREE.Vector3().crossVectors(face.up, face.normal).normalize();
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, face.up, face.normal));
  mesh.position.copy(face.center);
  return mesh;
}
