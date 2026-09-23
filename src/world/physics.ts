import * as THREE from "three";
import type { WallSegment } from "../shared/chunkLayout";
import { resolveWallCollisions } from "./collision";

const GRAVITY = 9.8;
const GROUND_FRICTION = 0.86;
const AIR_DAMPING = 0.99;
const SETTLE_SPEED = 0.05;
const TUMBLE_RATE = 3.5;

/**
 * Physique légère "maison" (pas de moteur type Rapier/Cannon-es — budget Quest 72fps +
 * cohérence avec la collision existante en boîtes alignées) : un objet de décor ou de
 * collection touché par le joueur reçoit une impulsion, puis tombe/glisse quelques
 * instants (gravité + frottement au sol + poussée hors des murs) avant de se stabiliser.
 * Pas de simulation de rotation rigide réelle : juste un tumble visuel proportionnel à
 * la vitesse, suffisant pour lire "l'objet a été bousculé" sans coût de calcul notable.
 */
export class PhysicsBody {
  private readonly velocity = new THREE.Vector3();
  private settled = true;

  constructor(
    private readonly restY: number,
    private readonly radius: number,
  ) {}

  get isSettled(): boolean {
    return this.settled;
  }

  /** Réarme la simulation avec une vitesse initiale donnée (ex : objet lâché en main, voir `collectible.ts`). */
  arm(velocity: THREE.Vector3 = new THREE.Vector3()): void {
    this.velocity.copy(velocity);
    this.settled = false;
  }

  /** Pousse l'objet depuis `origin` (position du joueur) : appelé au contact, une seule fois par approche (voir `isSettled`). */
  nudgeFrom(object: THREE.Object3D, origin: THREE.Vector3, strength: number): void {
    const dx = object.position.x - origin.x;
    const dz = object.position.z - origin.z;
    const distance = Math.hypot(dx, dz) || 1;
    this.velocity.x += (dx / distance) * strength;
    this.velocity.z += (dz / distance) * strength;
    this.velocity.y += strength * 0.4;
    this.settled = false;
  }

  update(object: THREE.Object3D, deltaSeconds: number, wallSegments: WallSegment[]): void {
    if (this.settled) return;

    this.velocity.y -= GRAVITY * deltaSeconds;
    object.position.addScaledVector(this.velocity, deltaSeconds);

    if (object.position.y <= this.restY) {
      object.position.y = this.restY;
      this.velocity.y = 0;
      this.velocity.x *= GROUND_FRICTION;
      this.velocity.z *= GROUND_FRICTION;
    } else {
      this.velocity.x *= AIR_DAMPING;
      this.velocity.z *= AIR_DAMPING;
    }

    resolveWallCollisions(object.position, this.radius, wallSegments);

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    object.rotation.z += this.velocity.x * deltaSeconds * TUMBLE_RATE;
    object.rotation.x -= this.velocity.z * deltaSeconds * TUMBLE_RATE;

    if (horizontalSpeed < SETTLE_SPEED && object.position.y <= this.restY + 0.001) {
      this.velocity.set(0, 0, 0);
      this.settled = true;
    }
  }
}
