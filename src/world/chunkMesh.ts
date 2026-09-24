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

  return group;
}

// Segments des murs/piliers : sans subdivision, le displacementMap (voir materials.ts) ne
// déplace que les sommets des coins et gondole tout le quad au lieu de créer un relief.
const WALL_SEGMENTS_LENGTH = 8;
const WALL_SEGMENTS_HEIGHT = 5;
const PILLAR_SEGMENTS = 4;

/** Boîte modèle d'un mur (1 m de long), partagée : ses sommets sont recopiés transformés. */
let wallTemplate: THREE.BoxGeometry | null = null;

function buildWalls(layout: ChunkLayout): THREE.Mesh | null {
  const segments = layout.wallSegments;
  if (segments.length === 0) return null;

  // Boîte (pas un plan) : le mur a une vraie épaisseur, cohérente avec la boîte de collision.
  // Écriture directe dans un seul buffer (pas de clone + fusion de 30 géométries : ~4 ms par
  // chunk sur PC, un à-coup visible sur Quest à chaque changement de chunk).
  wallTemplate ??= new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS, WALL_SEGMENTS_LENGTH, WALL_SEGMENTS_HEIGHT, 1);
  const srcPosition = wallTemplate.getAttribute("position") as THREE.BufferAttribute;
  const srcNormal = wallTemplate.getAttribute("normal") as THREE.BufferAttribute;
  const srcUv = wallTemplate.getAttribute("uv") as THREE.BufferAttribute;
  const srcIndex = wallTemplate.getIndex()!;
  const vertexCount = srcPosition.count;
  const indexCount = srcIndex.count;

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
      const x = srcPosition.getX(i) * length;
      const y = srcPosition.getY(i) + WALL_HEIGHT / 2;
      const z = srcPosition.getZ(i);
      const nx = srcNormal.getX(i);
      const nz = srcNormal.getZ(i);
      const o = (base + i) * 3;
      // Mur orienté selon Z : rotation de 90° autour de Y (x' = z, z' = -x).
      positions[o] = (alongX ? x : z) + centerX;
      positions[o + 1] = y;
      positions[o + 2] = (alongX ? z : -x) + centerZ;
      normals[o] = alongX ? nx : nz;
      normals[o + 1] = srcNormal.getY(i);
      normals[o + 2] = alongX ? nz : -nx;
      uvs[(base + i) * 2] = srcUv.getX(i);
      uvs[(base + i) * 2 + 1] = srcUv.getY(i);
    }
    const indexBase = s * indexCount;
    for (let i = 0; i < indexCount; i++) indices[indexBase + i] = srcIndex.getX(i) + base;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, getWallMaterial());
}

function buildPillars(layout: ChunkLayout): THREE.InstancedMesh | null {
  if (layout.pillarPositions.length === 0) return null;

  const geometry = new THREE.BoxGeometry(PILLAR_SIZE, WALL_HEIGHT, PILLAR_SIZE, PILLAR_SEGMENTS, WALL_SEGMENTS_HEIGHT, PILLAR_SEGMENTS);
  const mesh = new THREE.InstancedMesh(geometry, getPillarMaterial(), layout.pillarPositions.length);
  const matrix = new THREE.Matrix4();

  layout.pillarPositions.forEach((position, index) => {
    matrix.setPosition(position.x, WALL_HEIGHT / 2, position.z);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;

  return mesh;
}
