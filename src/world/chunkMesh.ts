import * as THREE from "three";
import { PILLAR_SIZE, WALL_HEIGHT, WALL_THICKNESS } from "../shared/constants";
import type { ChunkLayout } from "../shared/chunkLayout";
import { getPillarMaterial, getWallMaterial } from "./materials";

/**
 * Construit le groupe THREE d'un chunk à partir de sa disposition (murs/piliers).
 * Les murs sont fusionnés en une seule géométrie (1 draw call) pour tenir le budget
 * de la fiche projet (<100 draw calls) même avec plusieurs dizaines de chunks chargés.
 * Sol et plafond ne sont pas par chunk : un seul plan chacun suit le joueur (voir
 * `floorCeiling.ts`).
 */
export function buildChunkGroup(layout: ChunkLayout): THREE.Group {
  const group = new THREE.Group();
  group.name = `chunk-${layout.chunkX}-${layout.chunkZ}`;

  const walls = buildWalls(layout);
  if (walls) group.add(walls);

  const pillars = buildPillars(layout);
  if (pillars) group.add(pillars);

  freezeMatrices(group);
  return group;
}

/**
 * Décor immobile : matrices calculées une fois, plus recomposées à chaque frame par
 * `updateMatrixWorld` (des centaines d'objets statiques dans les 25 chunks chargés). À rappeler
 * pour tout objet statique ajouté ensuite au groupe (piles, voir chunkStreamer.ts).
 */
export function freezeMatrices(root: THREE.Object3D): void {
  root.traverse((object) => {
    object.updateMatrix();
    object.matrixAutoUpdate = false;
  });
}

// Segments des murs/piliers : sans subdivision, le displacementMap (voir materials.ts) ne
// déplace que les sommets des coins et gondole tout le quad au lieu de créer un relief. Le
// relief (échelle 0,035 m) reste net avec une grille modeste — inutile de payer plus de
// sommets par mur : leur géométrie est reconstruite à chaque chargement de chunk (voir
// `buildWalls`), en plein milieu de la boucle de jeu.
const WALL_SEGMENTS_LENGTH = 5;
const WALL_SEGMENTS_HEIGHT = 3;
const PILLAR_SEGMENTS = 3;

/** Boîte modèle d'un mur (1 m de long), partagée : ses sommets sont recopiés transformés. */
let wallTemplate: THREE.BufferGeometry | null = null;
// Tableaux bruts du gabarit, extraits une seule fois : indexer un Float32Array/Uint16Array
// directement dans la boucle chaude (jusqu'à ~50 murs × ~90 sommets par chunk) coûte nettement
// moins cher que 6 appels BufferAttribute.getX/Y/Z par sommet — mesuré ~9 ms de pic par chunk
// avec les accesseurs, sur un profil de murs dense (voir tests/perf-probe, retiré après usage).
let wallSrcPosition: ArrayLike<number> | null = null;
let wallSrcNormal: ArrayLike<number> | null = null;
let wallSrcUv: ArrayLike<number> | null = null;
let wallSrcIndex: ArrayLike<number> | null = null;
let wallVertexCount = 0;
let wallIndexCount = 0;

function buildWalls(layout: ChunkLayout): THREE.Mesh | null {
  const segments = layout.wallSegments;
  if (segments.length === 0) return null;

  // Boîte (pas un plan) : le mur a une vraie épaisseur, cohérente avec la boîte de collision.
  // Écriture directe dans un seul buffer (pas de clone + fusion de 30 géométries : ~4 ms par
  // chunk sur PC, un à-coup visible sur Quest à chaque changement de chunk).
  if (!wallTemplate) {
    wallTemplate = withoutTopAndBottom(new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS, WALL_SEGMENTS_LENGTH, WALL_SEGMENTS_HEIGHT, 1));
    const srcPosition = wallTemplate.getAttribute("position") as THREE.BufferAttribute;
    const srcNormal = wallTemplate.getAttribute("normal") as THREE.BufferAttribute;
    const srcUv = wallTemplate.getAttribute("uv") as THREE.BufferAttribute;
    const srcIndex = wallTemplate.getIndex()!;
    wallSrcPosition = srcPosition.array as ArrayLike<number>;
    wallSrcNormal = srcNormal.array as ArrayLike<number>;
    wallSrcUv = srcUv.array as ArrayLike<number>;
    wallSrcIndex = srcIndex.array as ArrayLike<number>;
    wallVertexCount = srcPosition.count;
    wallIndexCount = srcIndex.count;
  }
  const srcPosition = wallSrcPosition!;
  const srcNormal = wallSrcNormal!;
  const srcUv = wallSrcUv!;
  const srcIndex = wallSrcIndex!;
  const vertexCount = wallVertexCount;
  const indexCount = wallIndexCount;

  const positions = new Float32Array(segments.length * vertexCount * 3);
  const normals = new Float32Array(segments.length * vertexCount * 3);
  const uvs = new Float32Array(segments.length * vertexCount * 2);
  const indices = new Uint32Array(segments.length * indexCount);

  segments.forEach((segment, s) => {
    const width = segment.maxX - segment.minX;
    const depth = segment.maxZ - segment.minZ;
    const alongX = width >= depth;
    const length = alongX ? width : depth;
    const centerX = (segment.minX + segment.maxX) / 2;
    const centerZ = (segment.minZ + segment.maxZ) / 2;
    const base = s * vertexCount;
    for (let i = 0; i < vertexCount; i++) {
      const pi = i * 3;
      const x = srcPosition[pi]! * length;
      const y = srcPosition[pi + 1]! + WALL_HEIGHT / 2;
      const z = srcPosition[pi + 2]!;
      const nx = srcNormal[pi]!;
      const nz = srcNormal[pi + 2]!;
      const o = (base + i) * 3;
      // Mur orienté selon Z : rotation de 90° autour de Y (x' = z, z' = -x).
      positions[o] = (alongX ? x : z) + centerX;
      positions[o + 1] = y;
      positions[o + 2] = (alongX ? z : -x) + centerZ;
      normals[o] = alongX ? nx : nz;
      normals[o + 1] = srcNormal[pi + 1]!;
      normals[o + 2] = alongX ? nz : -nx;
      const ui = i * 2;
      const uo = (base + i) * 2;
      uvs[uo] = srcUv[ui]!;
      uvs[uo + 1] = srcUv[ui + 1]!;
    }
    const indexBase = s * indexCount;
    for (let i = 0; i < indexCount; i++) indices[indexBase + i] = srcIndex[i]! + base;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, getWallMaterial());
}

/**
 * Boîte sans ses faces du haut et du bas (groupes +Y et -Y de `BoxGeometry`) : murs et piliers
 * vont du sol au plafond, ces faces y sont collées et ne sont jamais visibles. Un quart des
 * sommets d'un mur en moins (chacun lit la carte de relief dans le vertex shader, deux fois en
 * VR), et autant de moins à recopier à chaque chargement de chunk.
 */
function withoutTopAndBottom(box: THREE.BoxGeometry): THREE.BufferGeometry {
  const TOP = 2;
  const BOTTOM = 3;
  const sourceIndex = box.getIndex()!;
  const remap = new Map<number, number>();
  const indices: number[] = [];
  for (const group of box.groups) {
    if (group.materialIndex === TOP || group.materialIndex === BOTTOM) continue;
    for (let i = group.start; i < group.start + group.count; i++) {
      const vertex = sourceIndex.getX(i);
      let mapped = remap.get(vertex);
      if (mapped === undefined) {
        mapped = remap.size;
        remap.set(vertex, mapped);
      }
      indices.push(mapped);
    }
  }
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    const source = box.getAttribute(name) as THREE.BufferAttribute;
    const array = new Float32Array(remap.size * source.itemSize);
    for (const [from, to] of remap) for (let k = 0; k < source.itemSize; k++) array[to * source.itemSize + k] = source.array[from * source.itemSize + k]!;
    geometry.setAttribute(name, new THREE.BufferAttribute(array, source.itemSize));
  }
  geometry.setIndex(indices);
  box.dispose();
  return geometry;
}

/** Tous les piliers ont la même forme : une seule géométrie partagée par tous les chunks (au
 * lieu d'en reconstruire une, identique, à chaque chargement) — jamais disposée par chunk, voir
 * l'exclusion sur le nom "pillars" dans `disposeGroup` (chunkStreamer.ts). */
let pillarTemplate: THREE.BufferGeometry | null = null;

function buildPillars(layout: ChunkLayout): THREE.InstancedMesh | null {
  if (layout.pillarPositions.length === 0) return null;

  pillarTemplate ??= withoutTopAndBottom(new THREE.BoxGeometry(PILLAR_SIZE, WALL_HEIGHT, PILLAR_SIZE, PILLAR_SEGMENTS, WALL_SEGMENTS_HEIGHT, PILLAR_SEGMENTS));
  const mesh = new THREE.InstancedMesh(pillarTemplate, getPillarMaterial(), layout.pillarPositions.length);
  mesh.name = "pillars";
  const matrix = new THREE.Matrix4();

  layout.pillarPositions.forEach((position, index) => {
    matrix.setPosition(position.x, WALL_HEIGHT / 2, position.z);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;

  return mesh;
}
