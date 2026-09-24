import * as THREE from "three";
import { CHUNK_SIZE, WALL_HEIGHT } from "../shared/constants";
import { getCeilingMaterial, getFloorMaterial, SURFACE_CELLS, SURFACE_CHUNKS } from "./materials";

const SURFACE_SIZE = SURFACE_CHUNKS * CHUNK_SIZE;

/**
 * Sol et plafond : un seul plan chacun pour toute la zone chargée (2 draw calls au lieu de 2
 * par chunk, soit ~50 de moins), recalé sur la grille des chunks quand le joueur change de
 * chunk. Le plan se déplace toujours d'un nombre entier de cellules : les tuiles de texture
 * (une par cellule, néons compris) restent donc fixes dans le monde, sans couture visible.
 *
 * Un sommet par coin de cellule : pas de displacement (relief invisible à cette échelle),
 * juste assez pour le tremblement des sommets dans les zones de glitch.
 */
export class FloorCeiling {
  private readonly floor: THREE.Mesh;
  private readonly ceiling: THREE.Mesh;
  private chunkX = Number.NaN;
  private chunkZ = Number.NaN;

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.PlaneGeometry(SURFACE_SIZE, SURFACE_SIZE, SURFACE_CELLS, SURFACE_CELLS);
    this.floor = new THREE.Mesh(geometry, getFloorMaterial());
    this.floor.rotation.x = -Math.PI / 2;
    this.ceiling = new THREE.Mesh(geometry, getCeilingMaterial());
    this.ceiling.rotation.x = Math.PI / 2;
    this.ceiling.position.y = WALL_HEIGHT;
    // Toujours autour du joueur : inutile de tester le frustum.
    this.floor.frustumCulled = false;
    this.ceiling.frustumCulled = false;
    scene.add(this.floor, this.ceiling);
  }

  update(playerPosition: THREE.Vector3): void {
    const chunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
    if (chunkX === this.chunkX && chunkZ === this.chunkZ) return;
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    const centerX = (chunkX + 0.5) * CHUNK_SIZE;
    const centerZ = (chunkZ + 0.5) * CHUNK_SIZE;
    this.floor.position.set(centerX, 0, centerZ);
    this.ceiling.position.set(centerX, WALL_HEIGHT, centerZ);
  }
}
