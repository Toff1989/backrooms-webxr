import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
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
const WALL_SEGMENTS_LENGTH = 12;
const WALL_SEGMENTS_HEIGHT = 6;
const PILLAR_SEGMENTS = 4;

function buildWalls(layout: ChunkLayout): THREE.Mesh | null {
  if (layout.wallSegments.length === 0) return null;

  // Boîte (pas un plan) : le mur a une vraie épaisseur, cohérente avec la boîte de collision.
  // Segments sur la longueur/hauteur pour laisser le displacementMap créer un relief.
  const baseBox = new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS, WALL_SEGMENTS_LENGTH, WALL_SEGMENTS_HEIGHT, 1);
  const geometries: THREE.BufferGeometry[] = [];

  for (const segment of layout.wallSegments) {
    const width = segment.maxX - segment.minX;
    const depth = segment.maxZ - segment.minZ;
    const alongX = width >= depth;
    const length = alongX ? width : depth;
    const centerX = (segment.minX + segment.maxX) / 2;
    const centerZ = (segment.minZ + segment.maxZ) / 2;

    const geometry = baseBox.clone();
    geometry.scale(length, 1, 1);
    if (!alongX) geometry.rotateY(Math.PI / 2);
    geometry.translate(centerX, WALL_HEIGHT / 2, centerZ);
    geometries.push(geometry);
  }
  baseBox.dispose();

  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) return null;

  return new THREE.Mesh(merged, getWallMaterial());
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
