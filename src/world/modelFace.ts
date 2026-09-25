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
 * Triangles d'un modèle en espace local, à plat : ax ay az bx by bz cx cy cz nx ny nz aire.
 * Extraits une seule fois par modèle, quel que soit le nombre de faces demandées (la photo en
 * demande deux) : avant, chaque recherche refaisait l'extraction en créant six vecteurs par
 * triangle — plus de 10 ms au premier spawn d'une loupe ou d'une photo (banc de test).
 */
const TRIANGLE_STRIDE = 13;
const triangleCache = new WeakMap<object, Float64Array>();

function extractTriangles(template: THREE.Object3D): Float64Array {
  template.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const toRoot = new THREE.Matrix4();
  let capacity = 0;
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute("position");
    if (!position) return;
    const index = object.geometry.getIndex();
    capacity += Math.floor((index ? index.count : position.count) / 3);
  });
  const out = new Float64Array(capacity * TRIANGLE_STRIDE);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  let count = 0;
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute("position");
    if (!position) return;
    const index = object.geometry.getIndex();
    toRoot.multiplyMatrices(rootInverse, object.matrixWorld);
    const vertices = index ? index.count : position.count;
    for (let i = 0; i + 2 < vertices; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(toRoot);
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(toRoot);
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(toRoot);
      ab.subVectors(b, a).cross(ac.subVectors(c, a));
      const length = ab.length();
      const area = length / 2;
      if (area < 1e-7) continue;
      const o = count * TRIANGLE_STRIDE;
      out[o] = a.x;
      out[o + 1] = a.y;
      out[o + 2] = a.z;
      out[o + 3] = b.x;
      out[o + 4] = b.y;
      out[o + 5] = b.z;
      out[o + 6] = c.x;
      out[o + 7] = c.y;
      out[o + 8] = c.z;
      out[o + 9] = ab.x / length;
      out[o + 10] = ab.y / length;
      out[o + 11] = ab.z / length;
      out[o + 12] = area;
      count++;
    }
  });
  return out.subarray(0, count * TRIANGLE_STRIDE);
}

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

  let tris = triangleCache.get(cacheOwner);
  if (!tris) {
    tris = extractTriangles(template);
    triangleCache.set(cacheOwner, tris);
  }
  const triangles = tris;
  const triangleCount = triangles.length / TRIANGLE_STRIDE;
  const point = new THREE.Vector3();
  const pointOf = (t: number, corner: number): THREE.Vector3 => {
    const o = t * TRIANGLE_STRIDE + corner * 3;
    return point.set(triangles[o]!, triangles[o + 1]!, triangles[o + 2]!);
  };

  const faceFor = (direction: THREE.Vector3): { face: ModelFace; area: number } | null => {
    const facing: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      const o = t * TRIANGLE_STRIDE;
      if (triangles[o + 9]! * direction.x + triangles[o + 10]! * direction.y + triangles[o + 11]! * direction.z > 0.85) facing.push(t);
    }
    if (facing.length === 0) return null;
    // La tranche de profondeur (4 cm) qui porte la plus grande surface : la toile d'un écran de
    // projection plutôt que les pieds du trépied, l'écran d'une télé plutôt que ses boutons.
    const depth = new Map<number, number>();
    for (const t of facing) {
      const o = t * TRIANGLE_STRIDE;
      depth.set(
        t,
        ((triangles[o]! + triangles[o + 3]! + triangles[o + 6]!) * direction.x +
          (triangles[o + 1]! + triangles[o + 4]! + triangles[o + 7]!) * direction.y +
          (triangles[o + 2]! + triangles[o + 5]! + triangles[o + 8]!) * direction.z) /
          3,
      );
    }
    const depthOf = (t: number): number => depth.get(t)!;
    const areaOf = (t: number): number => triangles[t * TRIANGLE_STRIDE + 12]!;
    const sorted = [...facing].sort((x, y) => depthOf(x) - depthOf(y));
    let bestArea = -1;
    let bestStart = 0;
    let bestEnd = 0;
    let windowArea = 0;
    for (let start = 0, end = 0; start < sorted.length; start++) {
      while (end < sorted.length && depthOf(sorted[end]!) - depthOf(sorted[start]!) <= 0.04) windowArea += areaOf(sorted[end++]!);
      if (windowArea > bestArea) {
        bestArea = windowArea;
        bestStart = start;
        bestEnd = end;
      }
      windowArea -= areaOf(sorted[start]!);
    }
    const kept = sorted.slice(bestStart, bestEnd);
    const normal = new THREE.Vector3();
    const center = new THREE.Vector3();
    let area = 0;
    for (const t of kept) {
      const o = t * TRIANGLE_STRIDE;
      const triArea = areaOf(t);
      normal.x += triangles[o + 9]! * triArea;
      normal.y += triangles[o + 10]! * triArea;
      normal.z += triangles[o + 11]! * triArea;
      center.x += (triangles[o]! + triangles[o + 3]! + triangles[o + 6]!) * (triArea / 3);
      center.y += (triangles[o + 1]! + triangles[o + 4]! + triangles[o + 7]!) * (triArea / 3);
      center.z += (triangles[o + 2]! + triangles[o + 5]! + triangles[o + 8]!) * (triArea / 3);
      area += triArea;
    }
    normal.normalize();
    center.divideScalar(area);
    // Repère du plan : "haut" = l'axe Y du modèle projeté (ou Z pour une face horizontale).
    const reference = Math.abs(normal.y) > 0.8 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const up = reference.sub(normal.clone().multiplyScalar(reference.dot(normal))).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const offset = new THREE.Vector3();
    for (const t of kept) {
      for (let corner = 0; corner < 3; corner++) {
        offset.subVectors(pointOf(t, corner), center);
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
    let forward = -Infinity;
    for (const t of kept) for (let corner = 0; corner < 3; corner++) forward = Math.max(forward, offset.subVectors(pointOf(t, corner), center).dot(normal));
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
