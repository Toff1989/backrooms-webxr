import * as THREE from "three";
import { applyVhsEffect } from "./vhsMaterial";

let geometry: THREE.BufferGeometry | null = null;
let bodyMaterial: THREE.MeshStandardMaterial | null = null;
let capMaterial: THREE.MeshStandardMaterial | null = null;

function sharedAssets(): { geometry: THREE.BufferGeometry; body: THREE.MeshStandardMaterial; cap: THREE.MeshStandardMaterial } {
  if (!geometry || !bodyMaterial || !capMaterial) {
    geometry = new THREE.CylinderGeometry(0.017, 0.017, 0.065, 12);
    // Corps sombre, bague cuivrée légèrement lumineuse : repérable à la lampe, pas dans le noir complet.
    bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.45, metalness: 0.3 });
    capMaterial = new THREE.MeshStandardMaterial({ color: 0xc88a3a, roughness: 0.3, metalness: 0.8, emissive: 0x6b3f10, emissiveIntensity: 0.25 });
    applyVhsEffect(bodyMaterial);
    applyVhsEffect(capMaterial);
  }
  return { geometry, body: bodyMaterial, cap: capMaterial };
}

/**
 * Pile de lampe torche posée au sol (voir `Flashlight`) : un petit cylindre couché, ramassé
 * en marchant dessus ou en l'effleurant de la main. Pas d'objet physique : juste un décor
 * qui disparaît quand on le prend.
 */
export class BatteryPickup {
  readonly object: THREE.Group;
  readonly template: THREE.Group;

  constructor(
    readonly id: string,
    x: number,
    z: number,
    rotationY: number,
  ) {
    const { geometry, body, cap } = sharedAssets();
    this.object = new THREE.Group();
    this.object.name = "battery";
    this.object.position.set(x, 0.017, z);
    this.object.rotation.set(0, rotationY, Math.PI / 2);
    const cell = new THREE.Mesh(geometry, body);
    const ring = new THREE.Mesh(geometry, cap);
    ring.scale.set(1.04, 0.25, 1.04);
    ring.position.y = 0.026;
    this.object.add(cell, ring);
    this.template = this.object.clone();
    this.template.position.set(0, 0, 0);
    this.template.rotation.set(0, 0, 0);
  }
}
