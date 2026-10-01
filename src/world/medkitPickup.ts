import * as THREE from "three";
import { applyVhsEffect } from "./vhsMaterial";

let shared: { box: THREE.BufferGeometry; bar: THREE.BufferGeometry; body: THREE.MeshStandardMaterial; cross: THREE.MeshStandardMaterial } | null = null;

function sharedAssets(): NonNullable<typeof shared> {
  if (!shared) {
    const body = new THREE.MeshStandardMaterial({ color: 0xd9d6cc, roughness: 0.6, metalness: 0.05 });
    // Croix rouge légèrement lumineuse : repérable à la lampe, pas dans le noir complet.
    const cross = new THREE.MeshStandardMaterial({ color: 0xc0201a, roughness: 0.5, emissive: 0x5a0a08, emissiveIntensity: 0.3 });
    applyVhsEffect(body);
    applyVhsEffect(cross);
    shared = { box: new THREE.BoxGeometry(0.2, 0.07, 0.14), bar: new THREE.BoxGeometry(0.1, 0.004, 0.026), body, cross };
  }
  return shared;
}

/**
 * Trousse de soin posée au sol, comme une pile (voir `BatteryPickup`) : on la saisit puis on
 * appuie sur la gâchette pour s'en servir — elle rend de la santé et disparaît.
 */
export class MedkitPickup {
  readonly object: THREE.Group;
  readonly template: THREE.Group;

  constructor(
    readonly id: string,
    x: number,
    z: number,
    rotationY: number,
  ) {
    const { box, bar, body, cross } = sharedAssets();
    this.object = new THREE.Group();
    this.object.name = "medkit";
    this.object.position.set(x, 0.036, z);
    this.object.rotation.set(0, rotationY, 0);
    const shell = new THREE.Mesh(box, body);
    const horizontal = new THREE.Mesh(bar, cross);
    horizontal.position.y = 0.037;
    const vertical = new THREE.Mesh(bar, cross);
    vertical.position.y = 0.037;
    vertical.rotation.y = Math.PI / 2;
    this.object.add(shell, horizontal, vertical);
    this.template = this.object.clone();
    this.template.position.set(0, 0, 0);
    this.template.rotation.set(0, 0, 0);
  }
}
