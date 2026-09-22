import * as THREE from "three";
import { createCeilingTexture, createFloorTexture, createWallTexture } from "./materials";

/**
 * Chunk statique unique pour le proto (étape 1 de la roadmap).
 * La génération infinie par chunks seedés arrive à l'étape 2.
 */
export const CELL_SIZE = 2.5;
export const CHUNK_CELLS = 8;
export const ROOM_SIZE = CELL_SIZE * CHUNK_CELLS;
export const WALL_HEIGHT = 2.7;
/** Limite de déplacement du joueur en attendant le vrai système de collision (étape 2). */
export const ROOM_HALF_EXTENT = ROOM_SIZE / 2 - 0.5;

export function buildStaticChunk(): THREE.Group {
  const group = new THREE.Group();
  group.name = "chunk-proto";

  group.add(buildFloorAndCeiling());
  group.add(buildWalls());
  group.add(buildPillars());
  group.add(buildCeilingLightStrips());

  return group;
}

function buildFloorAndCeiling(): THREE.Group {
  const group = new THREE.Group();

  const floorTexture = createFloorTexture();
  floorTexture.repeat.set(ROOM_SIZE / CELL_SIZE, ROOM_SIZE / CELL_SIZE);
  const floorMaterial = new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const ceilingTexture = createCeilingTexture();
  ceilingTexture.repeat.set(ROOM_SIZE / CELL_SIZE, ROOM_SIZE / CELL_SIZE);
  const ceilingMaterial = new THREE.MeshStandardMaterial({ map: ceilingTexture, roughness: 0.8 });
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), ceilingMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_HEIGHT;
  group.add(ceiling);

  return group;
}

function buildWalls(): THREE.Group {
  const group = new THREE.Group();
  const half = ROOM_SIZE / 2;

  const wallTexture = createWallTexture();
  wallTexture.repeat.set(ROOM_SIZE / CELL_SIZE, WALL_HEIGHT / CELL_SIZE);
  const wallMaterial = new THREE.MeshStandardMaterial({ map: wallTexture, roughness: 0.85 });
  const wallGeometry = new THREE.PlaneGeometry(ROOM_SIZE, WALL_HEIGHT);

  const walls: Array<{ position: THREE.Vector3Tuple; rotationY: number }> = [
    { position: [0, WALL_HEIGHT / 2, -half], rotationY: 0 },
    { position: [0, WALL_HEIGHT / 2, half], rotationY: Math.PI },
    { position: [-half, WALL_HEIGHT / 2, 0], rotationY: Math.PI / 2 },
    { position: [half, WALL_HEIGHT / 2, 0], rotationY: -Math.PI / 2 },
  ];

  for (const wall of walls) {
    const mesh = new THREE.Mesh(wallGeometry, wallMaterial);
    mesh.position.fromArray(wall.position);
    mesh.rotation.y = wall.rotationY;
    group.add(mesh);
  }

  return group;
}

/** Colonnes de soutien, disposition typique des Backrooms, en InstancedMesh pour le budget draw calls. */
function buildPillars(): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(0.4, WALL_HEIGHT, 0.4);
  const material = new THREE.MeshStandardMaterial({ color: 0x8c7a3a, roughness: 0.9 });

  const spacing = CELL_SIZE * 2;
  const margin = 3;
  const spawnClearance = 2;
  const positions: THREE.Vector3[] = [];

  for (let x = -ROOM_SIZE / 2 + margin; x <= ROOM_SIZE / 2 - margin; x += spacing) {
    for (let z = -ROOM_SIZE / 2 + margin; z <= ROOM_SIZE / 2 - margin; z += spacing) {
      if (Math.abs(x) < spawnClearance && Math.abs(z) < spawnClearance) continue;
      positions.push(new THREE.Vector3(x, WALL_HEIGHT / 2, z));
    }
  }

  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  const matrix = new THREE.Matrix4();
  positions.forEach((position, index) => {
    matrix.setPosition(position);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;

  return mesh;
}

/** Néons émissifs (sans point lights dynamiques : ambiance bakée prévue à l'étape 3). */
function buildCeilingLightStrips(): THREE.Group {
  const group = new THREE.Group();
  const stripGeometry = new THREE.BoxGeometry(1.6, 0.05, 0.25);
  const stripMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff7d6,
    emissive: 0xfff2b0,
    emissiveIntensity: 1.4,
  });

  const spacing = CELL_SIZE * 3;
  const start = -ROOM_SIZE / 2 + CELL_SIZE;
  const end = ROOM_SIZE / 2 - CELL_SIZE;

  for (let x = start; x <= end; x += spacing) {
    for (let z = start; z <= end; z += spacing) {
      const strip = new THREE.Mesh(stripGeometry, stripMaterial);
      strip.position.set(x, WALL_HEIGHT - 0.05, z);
      group.add(strip);
    }
  }

  return group;
}
