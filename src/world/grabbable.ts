import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { getModelShape, scaledHull } from "../physics/modelShape";
import type { PropKind } from "../shared/props";
import type { CollectionEntry } from "./collection";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Au-delà (m) du joueur, un objet n'est plus dessiné : noyé dans le brouillard, il coûtait
 * quand même un draw call (une centaine de meubles chargés sur les 25 chunks).
 */
const RENDER_DISTANCE = 17;

/** Au-delà, un objet ne se soulève pas (on peut seulement le pousser) — fiche : physique réaliste. */
export const MAX_LIFT_MASS = 32;

/** Meubles "boîtes" (armoire, bureau de direction) : collider cuboïde, stable au repos. */
const BOX_COLLIDER_PROPS = new Set<PropKind>(["cabinet", "officeDesk"]);

const PROP_MASS: Record<PropKind, number> = {
  chair: 6,
  schoolDesk: 14,
  officeDesk: 28,
  cabinet: 45,
};

export type HighlightLevel = 0 | 1 | 2;

const HIGHLIGHT_COLOR = new THREE.Color(0xfff1c2);
const HIGHLIGHT_INTENSITY: Record<1 | 2, number> = { 1: 0.18, 2: 0.4 };
const highlightCache = new Map<THREE.Material, [THREE.Material, THREE.Material]>();

function highlightVariant(material: THREE.Material, level: 1 | 2): THREE.Material {
  let variants = highlightCache.get(material);
  if (!variants) {
    const make = (intensity: number): THREE.Material => {
      const clone = material.clone();
      if (clone instanceof THREE.MeshStandardMaterial) {
        clone.emissive = HIGHLIGHT_COLOR.clone();
        clone.emissiveIntensity = intensity;
      }
      applyVhsEffect(clone);
      return clone;
    };
    variants = [make(HIGHLIGHT_INTENSITY[1]), make(HIGHLIGHT_INTENSITY[2])];
    highlightCache.set(material, variants);
  }
  return level === 1 ? variants[0] : variants[1];
}

export interface GrabbableInit {
  model: THREE.Object3D;
  template: THREE.Object3D;
  scale: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  mass: number;
  /** Données d'inventaire : présent uniquement pour les objets de collection (rangeables). */
  item: CollectionEntry | null;
  /** Boîte de collision au lieu de l'enveloppe convexe (meubles massifs et anguleux). */
  boxCollider?: boolean;
}

/**
 * Objet physique saisissable (mobilier ou objet de collection) : corps dynamique Rapier
 * avec une enveloppe convexe fidèle au modèle, synchronisé chaque frame vers son mesh.
 */
export class Grabbable {
  readonly object: THREE.Object3D;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mass: number;
  readonly item: CollectionEntry | null;
  /** Centre de la boîte englobante, en espace local du corps (échelle comprise). */
  readonly localCenter: THREE.Vector3;
  /** Main qui tient l'objet (opaque ici, voir `GrabSystem`). */
  heldBy: object | null = null;

  private highlight: HighlightLevel = 0;
  private readonly meshes: Array<{ mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }> = [];

  constructor(
    private readonly physics: PhysicsWorld,
    init: GrabbableInit,
  ) {
    this.mass = init.mass;
    this.item = init.item;
    this.object = init.model;
    this.object.scale.setScalar(init.scale);
    this.object.position.copy(init.position);
    this.object.quaternion.copy(init.quaternion);
    this.object.traverse((child) => {
      if (child instanceof THREE.Mesh) this.meshes.push({ mesh: child, original: child.material });
    });

    const shape = getModelShape(init.template);
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(init.position.x, init.position.y, init.position.z)
        .setRotation(init.quaternion)
        // CCD (anti-traversée à grande vitesse) activée seulement une fois l'objet saisi (voir
        // GrabSystem) : au repos, elle faisait trembler les petits objets, jusqu'à traverser le sol.
        // Les meubles naissent endormis, posés au sol : ils ne coûtent rien tant qu'on n'y touche pas.
        .setSleeping(init.item === null)
        // Meubles : fort amortissement (frottement sur la moquette) pour qu'ils se posent et
        // s'endorment vite au lieu de glisser sans fin quand un amas se chevauche au chargement.
        .setLinearDamping(init.item === null ? 0.8 : 0.25)
        .setAngularDamping(init.item === null ? 1.5 : 0.9),
    );

    // L'enveloppe convexe détaillée d'un meuble lourd oscillait sur le sol (contacts instables) ;
    // une boîte suffit pour ces formes anguleuses.
    const hullDesc = init.boxCollider ? null : RAPIER.ColliderDesc.convexHull(scaledHull(shape, init.scale));
    const size = shape.box.getSize(new THREE.Vector3()).multiplyScalar(init.scale * 0.5);
    const center = shape.box.getCenter(new THREE.Vector3()).multiplyScalar(init.scale);
    this.localCenter = center.clone();
    const colliderDesc =
      hullDesc ??
      RAPIER.ColliderDesc.cuboid(Math.max(size.x, 0.01), Math.max(size.y, 0.01), Math.max(size.z, 0.01)).setTranslation(center.x, center.y, center.z);
    colliderDesc.setMass(init.mass).setFriction(0.8).setRestitution(0.15).setCollisionGroups(CollisionGroups.dynamic);
    this.collider = physics.world.createCollider(colliderDesc, this.body);
    // L'ajout du collider réveille le corps : un meuble posé se rendort immédiatement.
    if (init.item === null) this.body.sleep();
  }

  get isCollectible(): boolean {
    return this.item !== null;
  }

  get liftable(): boolean {
    return this.mass <= MAX_LIFT_MASS;
  }

  setHighlight(level: HighlightLevel): void {
    if (level === this.highlight) return;
    this.highlight = level;
    for (const { mesh, original } of this.meshes) {
      if (level === 0) mesh.material = original;
      else mesh.material = Array.isArray(original) ? original.map((material) => highlightVariant(material, level)) : highlightVariant(original, level);
    }
  }

  /** Copie la pose simulée vers le mesh. */
  sync(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.object.position.set(t.x, t.y, t.z);
    this.object.quaternion.set(r.x, r.y, r.z, r.w);
  }

  dispose(): void {
    this.setHighlight(0);
    this.object.removeFromParent();
    this.physics.world.removeRigidBody(this.body);
  }
}

/**
 * Registre de tous les objets saisissables vivants : retrouve un objet depuis un collider
 * (requêtes Rapier), synchronise les meshes, et suit les objets de collection présents dans
 * le monde (pour ne jamais en faire apparaître un doublon au rechargement d'un chunk).
 */
export class GrabbableRegistry {
  readonly all = new Set<Grabbable>();
  private readonly byCollider = new Map<number, Grabbable>();
  private readonly aliveItemIds = new Set<string>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
  ) {}

  create(init: GrabbableInit): Grabbable {
    const grabbable = new Grabbable(this.physics, init);
    this.scene.add(grabbable.object);
    this.all.add(grabbable);
    this.byCollider.set(grabbable.collider.handle, grabbable);
    if (grabbable.item) this.aliveItemIds.add(grabbable.item.id);
    return grabbable;
  }

  createProp(kind: PropKind, model: THREE.Object3D, template: THREE.Object3D, x: number, z: number, rotationY: number): Grabbable {
    return this.create({
      model,
      template,
      scale: 1,
      position: new THREE.Vector3(x, 0.005, z),
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY),
      mass: PROP_MASS[kind],
      item: null,
      boxCollider: BOX_COLLIDER_PROPS.has(kind),
    });
  }

  createCollectible(item: CollectionEntry, model: THREE.Object3D, template: THREE.Object3D, position: THREE.Vector3, quaternion: THREE.Quaternion): Grabbable {
    // Jamais enfoncé dans le sol : le point le plus bas du modèle est posé juste au-dessus.
    const lowest = getModelShape(template).box.min.y * item.scale;
    if (position.y + lowest < 0.01) position = position.clone().setY(0.01 - lowest);
    return this.create({ model, template, scale: item.scale, position, quaternion, mass: collectibleMass(template, item.scale), item });
  }

  fromCollider(handle: number): Grabbable | undefined {
    return this.byCollider.get(handle);
  }

  isItemAlive(id: string): boolean {
    return this.aliveItemIds.has(id);
  }

  remove(grabbable: Grabbable): void {
    if (!this.all.delete(grabbable)) return;
    this.byCollider.delete(grabbable.collider.handle);
    if (grabbable.item) this.aliveItemIds.delete(grabbable.item.id);
    grabbable.dispose();
  }

  /** Retire les objets non tenus situés dans une zone XZ (déchargement d'un chunk). */
  removeInArea(minX: number, maxX: number, minZ: number, maxZ: number): void {
    for (const grabbable of [...this.all]) {
      if (grabbable.heldBy) continue;
      const t = grabbable.body.translation();
      if (t.x >= minX && t.x < maxX && t.z >= minZ && t.z < maxZ) this.remove(grabbable);
    }
  }

  /** Changement de level : tout ce qui n'est pas en main disparaît avec l'ancien monde. */
  removeAllNotHeld(): void {
    for (const grabbable of [...this.all]) if (!grabbable.heldBy) this.remove(grabbable);
  }

  sync(viewer: THREE.Vector3): void {
    for (const grabbable of this.all) {
      grabbable.sync();
      const position = grabbable.object.position;
      grabbable.object.visible = grabbable.heldBy !== null || Math.hypot(position.x - viewer.x, position.z - viewer.z) < RENDER_DISTANCE;
      // Filet de sécurité : un objet sorti du monde (éjecté à travers un mur) est retiré.
      if (grabbable.object.position.y < -3 && !grabbable.heldBy) this.remove(grabbable);
    }
  }
}

/** Masse plausible d'un petit objet d'après son volume englobant (de ~100 g à 6 kg). */
function collectibleMass(template: THREE.Object3D, scale: number): number {
  const size = getModelShape(template).box.getSize(new THREE.Vector3()).multiplyScalar(scale);
  return THREE.MathUtils.clamp(0.15 + size.x * size.y * size.z * 300, 0.1, 6);
}
