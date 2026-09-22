import * as THREE from "three";
import type { WallSegment } from "../shared/chunkLayout";

export const PLAYER_RADIUS = 0.35;

const RESOLUTION_ITERATIONS = 2;
const MIN_PUSH_DISTANCE = 1e-5;

/**
 * Repousse `position` hors des segments de mur proches (collision cercle/AABB dans le
 * plan XZ). Plusieurs itérations pour stabiliser les coins où deux murs se rejoignent.
 */
export function resolveWallCollisions(position: THREE.Vector3, radius: number, segments: WallSegment[]): void {
  for (let iteration = 0; iteration < RESOLUTION_ITERATIONS; iteration++) {
    for (const segment of segments) {
      const closestX = THREE.MathUtils.clamp(position.x, segment.minX, segment.maxX);
      const closestZ = THREE.MathUtils.clamp(position.z, segment.minZ, segment.maxZ);
      const dx = position.x - closestX;
      const dz = position.z - closestZ;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= radius * radius) continue;

      const distance = Math.sqrt(distanceSq);
      if (distance < MIN_PUSH_DISTANCE) {
        position.x += radius;
        continue;
      }

      const overlap = radius - distance;
      position.x += (dx / distance) * overlap;
      position.z += (dz / distance) * overlap;
    }
  }
}
