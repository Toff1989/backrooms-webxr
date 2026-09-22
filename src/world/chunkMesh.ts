import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CELL_SIZE, PILLAR_SIZE, WALL_HEIGHT, WALL_THICKNESS } from "../shared/constants";
import type { ChunkLayout } from "../shared/chunkLayout";
import { getCeilingMaterial, getFloorMaterial, getNeonMaterial, getPillarMaterial, getWallMaterial } from "./materials";

const NEON_WIDTH = 1.6;
const NEON_DEPTH = 0.25;
const NEON_THICKNESS = 0.05;
/** Espacement des néons, en cellules (ambiance bakée, pas d'ombres dynamiques). */
const NEON_SPACING_CELLS = 3;

/**
 * Construit le groupe THREE d'un chunk à partir de sa disposition (murs/piliers).
 * Les murs sont fusionnés en une seule géométrie (1 draw call) pour tenir le budget
 * de la fiche projet (<100 draw calls) même avec plusieurs dizaines de chunks chargés.
 */
export function buildChunkGroup(layout: ChunkLayout, chunkOriginX: number, chunkOriginZ: number, chunkSize: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `chunk-${layout.chunkX}-${layout.chunkZ}`;

  const centerX = chunkOriginX + chunkSize / 2;
  const centerZ = chunkOriginZ + chunkSize / 2;

  group.add(buildFloor(centerX, centerZ, chunkSize));
  group.add(buildCeiling(centerX, centerZ, chunkSize));

  const walls = buildWalls(layout);
  if (walls) group.add(walls);

  const pillars = buildPillars(layout);
  if (pillars) group.add(pillars);

  const neonStrips = buildNeonStrips(chunkOriginX, chunkOriginZ, chunkSize);
  if (neonStrips) group.add(neonStrips);

  return group;
}

function buildFloor(centerX: number, centerZ: number, size: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size);
  const mesh = new THREE.Mesh(geometry, getFloorMaterial());
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(centerX, 0, centerZ);
  return mesh;
}

function buildCeiling(centerX: number, centerZ: number, size: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size);
  const mesh = new THREE.Mesh(geometry, getCeilingMaterial());
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(centerX, WALL_HEIGHT, centerZ);
  return mesh;
}

function buildWalls(layout: ChunkLayout): THREE.Mesh | null {
  if (layout.wallSegments.length === 0) return null;

  // Boîte (pas un plan) : le mur a une vraie épaisseur, cohérente avec la boîte de collision.
  const baseBox = new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS);
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

  const geometry = new THREE.BoxGeometry(PILLAR_SIZE, WALL_HEIGHT, PILLAR_SIZE);
  const mesh = new THREE.InstancedMesh(geometry, getPillarMaterial(), layout.pillarPositions.length);
  const matrix = new THREE.Matrix4();

  layout.pillarPositions.forEach((position, index) => {
    matrix.setPosition(position.x, WALL_HEIGHT / 2, position.z);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;

  return mesh;
}

/** Néons émissifs plafonniers (sans point lights dynamiques : ambiance bakée). */
function buildNeonStrips(chunkOriginX: number, chunkOriginZ: number, chunkSize: number): THREE.InstancedMesh | null {
  const spacing = CELL_SIZE * NEON_SPACING_CELLS;
  const margin = CELL_SIZE;
  const positions: Array<{ x: number; z: number }> = [];

  for (let x = chunkOriginX + margin; x <= chunkOriginX + chunkSize - margin; x += spacing) {
    for (let z = chunkOriginZ + margin; z <= chunkOriginZ + chunkSize - margin; z += spacing) {
      positions.push({ x, z });
    }
  }
  if (positions.length === 0) return null;

  const geometry = new THREE.BoxGeometry(NEON_WIDTH, NEON_THICKNESS, NEON_DEPTH);
  const mesh = new THREE.InstancedMesh(geometry, getNeonMaterial(), positions.length);
  const matrix = new THREE.Matrix4();

  positions.forEach((position, index) => {
    matrix.setPosition(position.x, WALL_HEIGHT - NEON_THICKNESS, position.z);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;

  return mesh;
}
