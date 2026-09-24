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

/** Meubles "boîtes" (armoire, bureau, étagères, caisses...) : collider cuboïde, stable au repos et empilable. */
const BOX_COLLIDER_PROPS = new Set<PropKind>([
  "cabinet",
  "officeDesk",
  "sofa",
  "coffeeTable",
  "metalShelves",
  "bookshelf",
  "storageCart",
  "cardboardBox",
  "plasticCrate",
  "television",
]);

const PROP_MASS: Record<PropKind, number> = {
  chair: 6,
  schoolDesk: 14,
  officeDesk: 28,
  cabinet: 45,
  monoblocChair: 3,
  armChair: 12,
  sofa: 35,
  coffeeTable: 10,
  metalStool: 4,
  metalShelves: 18,
  bookshelf: 40,
  storageCart: 30,
  projectorScreen: 7,
  chalkboard: 9,
  cardboardBox: 4,
  plasticCrate: 1.5,
  wetFloorSign: 1.2,
  television: 12,
  pottedPlant: 1.5,
};

/** Échelle d'import : l'étagère Poly Haven est modélisée ~12× trop grande (21 m de haut). */
const PROP_SCALE: Partial<Record<PropKind, number>> = { metalShelves: 1.85 / 21.4 };
/** Hauteur (m) d'où tombe un meuble renversé : il se couche de lui-même sur le sol. */
const TIPPED_SPAWN_HEIGHT = 0.55;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

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
  /** Page de bande perdue (voir `lorePage.ts`) : saisissable et lisible, jamais rangée dans le sac. */
  lorePage?: LorePageData | null;
  /** Boîte de collision au lieu de l'enveloppe convexe (meubles massifs et anguleux). */
  boxCollider?: boolean;
  /** Meuble qui naît éveillé (renversé : il doit retomber avant de s'endormir). */
  awake?: boolean;
  /** Libère les ressources propres à cette instance (texture d'une page). */
  onDispose?: () => void;
  /** Type de meuble (le type d'un objet de collection vient de `item`). */
  propKind?: PropKind;
}

/** Page de bande perdue posée dans le monde : identifiant unique par level, fragment de récit porté. */
export interface LorePageData {
  id: string;
  fragment: number;
  /** Prise en main : la bande est lue selon sa forme (polaroid développé, cassette lancée). */
  onRead(): void;
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
  readonly lorePage: LorePageData | null;
  /** Type de meuble ou d'objet de collection (null : page de bande perdue). */
  readonly kind: string | null;
  /** Centre de la boîte englobante, en espace local du corps (échelle comprise). */
  readonly localCenter: THREE.Vector3;
  /** Main qui tient l'objet (opaque ici, voir `GrabSystem`). */
  heldBy: object | null = null;

  private highlight: HighlightLevel = 0;
  private readonly onDispose: (() => void) | undefined;
  private readonly meshes: Array<{ mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }> = [];

  constructor(
    private readonly physics: PhysicsWorld,
    init: GrabbableInit,
  ) {
    this.mass = init.mass;
    this.item = init.item;
    this.lorePage = init.lorePage ?? null;
    this.kind = init.item?.kind ?? init.propKind ?? null;
    this.onDispose = init.onDispose;
    // Meuble : endormi, fortement amorti. Petit objet (collection, page) : libre, il roule.
    const furniture = init.item === null && this.lorePage === null;
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
        .setSleeping(furniture && !init.awake)
        // Meubles : fort amortissement (frottement sur la moquette) pour qu'ils se posent et
        // s'endorment vite au lieu de glisser sans fin quand un amas se chevauche au chargement.
        .setLinearDamping(furniture ? 0.8 : 0.25)
        .setAngularDamping(furniture ? 1.5 : 0.9),
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
    if (furniture && !init.awake) this.body.sleep();
  }

  get isCollectible(): boolean {
    return this.item !== null;
  }

  /** Petit objet (collection ou page) : préféré au meuble qu'il touche quand on tend la main. */
  get isSmall(): boolean {
    return this.item !== null || this.lorePage !== null;
  }

  /** Identifiant d'unicité dans le monde (objet de collection ou page), null pour un meuble. */
  get uniqueId(): string | null {
    return this.item?.id ?? this.lorePage?.id ?? null;
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
    this.onDispose?.();
  }
}

/**
 * Registre de tous les objets saisissables vivants : retrouve un objet depuis un collider
 * (requêtes Rapier), synchronise les meshes, et garantit qu'un objet de collection n'existe
 * qu'en un seul exemplaire dans le monde (jamais de doublon au rechargement d'un chunk, ni
 * entre l'inventaire et le sol).
 */
export class GrabbableRegistry {
  readonly all = new Set<Grabbable>();
  private readonly byCollider = new Map<number, Grabbable>();
  private readonly aliveItems = new Map<string, Grabbable>();
  /** Objets en cours de sortie de l'inventaire (modèle en chargement) : déjà "vivants". */
  private readonly reservedItems = new Set<string>();
  /** Abonnés à l'apparition / disparition des objets (interactions). */
  readonly onCreate = new Set<(grabbable: Grabbable) => void>();
  readonly onRemove = new Set<(grabbable: Grabbable) => void>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
  ) {}

  create(init: GrabbableInit): Grabbable {
    const grabbable = new Grabbable(this.physics, init);
    this.scene.add(grabbable.object);
    this.all.add(grabbable);
    this.byCollider.set(grabbable.collider.handle, grabbable);
    const uniqueId = grabbable.uniqueId;
    if (uniqueId) {
      // Un seul exemplaire par objet : un ancien resté au sol disparaît au profit du nouveau.
      const previous = this.aliveItems.get(uniqueId);
      if (previous && !previous.heldBy) this.remove(previous);
      this.reservedItems.delete(uniqueId);
      this.aliveItems.set(uniqueId, grabbable);
    }
    for (const listener of this.onCreate) listener(grabbable);
    return grabbable;
  }

  /** Meuble posé au sol (ou à `y` : caisse empilée, objet sur un bureau), ou renversé (il retombe). */
  createProp(kind: PropKind, model: THREE.Object3D, template: THREE.Object3D, x: number, z: number, rotationY: number, y = 0, tipped = false): Grabbable {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, rotationY);
    if (tipped) quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, Math.PI / 2));
    return this.create({
      model,
      template,
      scale: PROP_SCALE[kind] ?? 1,
      position: new THREE.Vector3(x, tipped ? TIPPED_SPAWN_HEIGHT : y + 0.005, z),
      quaternion,
      mass: PROP_MASS[kind],
      item: null,
      boxCollider: BOX_COLLIDER_PROPS.has(kind),
      awake: tipped,
      propKind: kind,
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
    return this.aliveItems.has(id) || this.reservedItems.has(id);
  }

  /** Exemplaire de cet objet présent dans le monde, s'il y en a un. */
  itemInWorld(id: string): Grabbable | null {
    return this.aliveItems.get(id) ?? null;
  }

  /** Retire du monde tous les exemplaires non tenus d'un objet (il vient d'être rangé). */
  removeItemCopies(id: string): void {
    for (const grabbable of [...this.all]) if (grabbable.item?.id === id && !grabbable.heldBy) this.remove(grabbable);
  }

  /** Réserve un objet pendant sa sortie de l'inventaire (aucun chunk ne le fait réapparaître). */
  reserveItem(id: string): void {
    this.reservedItems.add(id);
  }

  releaseItem(id: string): void {
    this.reservedItems.delete(id);
  }

  remove(grabbable: Grabbable): void {
    if (!this.all.delete(grabbable)) return;
    this.byCollider.delete(grabbable.collider.handle);
    const uniqueId = grabbable.uniqueId;
    if (uniqueId && this.aliveItems.get(uniqueId) === grabbable) this.aliveItems.delete(uniqueId);
    for (const listener of this.onRemove) listener(grabbable);
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
