import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import type { UiPointer } from "../ui/uiPointer";
import { spawnCollectibleModel } from "../world/collectibleLoader";
import type { CollectionEntry } from "../world/collection";
import type { Grabbable, GrabbableRegistry } from "../world/grabbable";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

/** Rayon de saisie autour de la paume (généreux : attraper avant de bousculer). */
const NEAR_GRAB_RADIUS = 0.11;
/** Portée de la saisie à distance (fiche / Saints & Sinners : l'objet vient dans la main). */
const DISTANCE_GRAB_RANGE = 4;
const PULL_SPEED = 7;
const PULL_ATTACH_DISTANCE = 0.14;
const PULL_TIMEOUT_SECONDS = 1.2;

const MAX_HOLD_SPEED = 14;
const MAX_HOLD_ANGULAR_SPEED = 28;
/** Objet coincé (derrière un mur) trop loin de la main pendant trop longtemps : il est lâché. */
const BREAK_DISTANCE = 0.45;
const BREAK_SECONDS = 0.25;
const THROW_BOOST = 1.3;
const MAX_THROW_ANGULAR_SPEED = 25;
/** Juste après un lâcher, l'objet ne percute pas encore le corps du joueur (il en sort). */
const RELEASE_GRACE_SECONDS = 0.35;

export interface GrabHooks {
  /** L'inventaire est ouvert et la main (ou son pointeur) est dessus : relâcher y range l'objet. */
  isOverInventory(hand: Hand): boolean;
  store(item: CollectionEntry): void;
}

interface HeldState {
  grabbable: Grabbable;
  offsetPosition: THREE.Vector3;
  offsetQuaternion: THREE.Quaternion;
  strength: number;
  stretchSeconds: number;
}

interface PullState {
  grabbable: Grabbable;
  elapsed: number;
}

const IDENTITY = new THREE.Quaternion();
const tmpTargetPos = new THREE.Vector3();
const tmpTargetQuat = new THREE.Quaternion();
const tmpCurrentPos = new THREE.Vector3();
const tmpCurrentQuat = new THREE.Quaternion();
const tmpDelta = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();

/**
 * Saisie et manipulation physique des objets (contrôles type Saints & Sinners) :
 * - grip près d'un objet : on le prend là où on le touche ; grip en visant un objet
 *   (jusqu'à 4 m, il s'illumine) : il vole jusqu'à la main ;
 * - l'objet tenu reste un corps physique qui suit la main par vitesse (il cogne les murs
 *   au lieu de les traverser, un objet lourd traîne derrière la main) ;
 * - relâcher = lâcher ou lancer avec la vitesse réelle de la main ; relâcher sur le menu
 *   d'inventaire, ou A/X, range un objet de collection.
 */
export class GrabSystem {
  private readonly held = new Map<Hand, HeldState>();
  private readonly pulling = new Map<Hand, PullState>();
  private readonly releasing = new Map<Grabbable, number>();
  private readonly hovered = new Map<Hand, Grabbable | null>();
  private readonly highlighted = new Set<Grabbable>();
  private readonly pendingTake = new Set<Hand>();
  private readonly grabBall = new RAPIER.Ball(NEAR_GRAB_RADIUS);
  private time = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly registry: GrabbableRegistry,
    private readonly hands: Hand[],
    private readonly sfx: Sfx,
    private readonly hooks: GrabHooks,
  ) {}

  isHolding(hand: Hand): boolean {
    return this.held.has(hand);
  }

  update(time: number, pointer: UiPointer): void {
    this.time = time;
    const desired = new Map<Grabbable, 1 | 2>();

    for (const hand of this.hands) {
      if (!hand.tracked) {
        if (this.held.has(hand)) this.release(hand, false);
        this.cancelPull(hand);
        this.setHovered(hand, null);
        continue;
      }

      const input = hand.input;
      if (this.held.has(hand)) {
        const state = this.held.get(hand)!;
        if (input.primary.justPressed && state.grabbable.item) this.storeHeld(hand);
        else if (input.squeeze.justReleased) {
          if (state.grabbable.item && this.hooks.isOverInventory(hand)) this.storeHeld(hand);
          else this.release(hand, true);
        }
        this.setHovered(hand, null);
        continue;
      }

      if (this.pulling.has(hand)) {
        if (!input.squeeze.pressed) this.cancelPull(hand);
        continue;
      }

      const frame = pointer.frame(hand);
      if (frame.target || this.pendingTake.has(hand)) {
        this.setHovered(hand, null);
        continue;
      }

      const near = this.findNear(hand);
      const far = near ? null : this.findAimed(hand);
      const candidate = near ?? far;
      if (candidate) desired.set(candidate, Math.max(desired.get(candidate) ?? 0, near ? 2 : 1) as 1 | 2);
      this.setHovered(hand, candidate);

      if (input.squeeze.justPressed && !frame.consumedGrip && candidate) {
        if (!candidate.liftable) {
          hand.pulse(0.6, 60);
          this.sfx.play("denied", 0.3);
        } else if (near) {
          this.attach(hand, candidate, "relative");
        } else {
          this.startPull(hand, candidate);
        }
      }
    }

    for (const grabbable of this.highlighted) {
      if (!desired.has(grabbable) || !this.registry.all.has(grabbable)) {
        grabbable.setHighlight(0);
        this.highlighted.delete(grabbable);
      }
    }
    for (const [grabbable, level] of desired) {
      grabbable.setHighlight(level);
      this.highlighted.add(grabbable);
    }
  }

  /** Avant chaque pas de simulation : suivi des objets tenus, attraction des objets tirés. */
  step(stepSeconds: number): void {
    for (const [hand, state] of this.held) this.track(hand, state, stepSeconds);

    for (const [hand, pull] of this.pulling) {
      // L'objet a pu disparaître en route (chunk déchargé) : son corps n'existe plus.
      if (!this.registry.all.has(pull.grabbable)) {
        this.pulling.delete(hand);
        continue;
      }
      pull.elapsed += stepSeconds;
      const t = pull.grabbable.body.translation();
      tmpVec.set(hand.palm.x - t.x, hand.palm.y - t.y, hand.palm.z - t.z);
      const distance = tmpVec.length();
      if (distance < PULL_ATTACH_DISTANCE) {
        this.pulling.delete(hand);
        this.attach(hand, pull.grabbable, "centered");
        continue;
      }
      if (pull.elapsed > PULL_TIMEOUT_SECONDS) {
        this.cancelPull(hand);
        continue;
      }
      const speed = Math.min(PULL_SPEED, distance / 0.12);
      tmpVec.multiplyScalar(speed / distance);
      pull.grabbable.body.setLinvel(tmpVec, true);
      pull.grabbable.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    for (const [grabbable, until] of this.releasing) {
      if (this.time < until) continue;
      this.releasing.delete(grabbable);
      if (!grabbable.heldBy && this.registry.all.has(grabbable)) grabbable.collider.setCollisionGroups(CollisionGroups.dynamic);
    }
  }

  /** Rig téléporté/tourné : les objets tenus sautent directement à leur place, sans balayer le monde. */
  onTeleport(): void {
    for (const hand of this.hands) hand.resetMotion();
    for (const [hand, state] of this.held) {
      this.computeTarget(hand, state);
      state.grabbable.body.setTranslation(tmpTargetPos, true);
      state.grabbable.body.setRotation(tmpTargetQuat, true);
      state.grabbable.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      state.grabbable.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (const hand of [...this.pulling.keys()]) this.cancelPull(hand);
  }

  /** Sort un objet de l'inventaire directement dans la main, à sa taille réelle. */
  takeIntoHand(hand: Hand, item: CollectionEntry, onFailure: () => void): void {
    if (this.held.has(hand) || this.pendingTake.has(hand)) {
      onFailure();
      return;
    }
    this.pendingTake.add(hand);
    spawnCollectibleModel(item.kind)
      .then(({ model, template }) => {
        this.pendingTake.delete(hand);
        if (this.held.has(hand) || !hand.tracked) {
          onFailure();
          return;
        }
        const grabbable = this.registry.createCollectible(item, model, template, hand.palm.clone(), hand.quaternion.clone());
        this.attach(hand, grabbable, "centered");
        this.sfx.play("take", 0.45);
      })
      .catch(() => {
        this.pendingTake.delete(hand);
        onFailure();
      });
  }

  private findNear(hand: Hand): Grabbable | null {
    let best: Grabbable | null = null;
    let bestScore = Infinity;
    this.physics.world.intersectionsWithShape(
      hand.palm,
      IDENTITY,
      this.grabBall,
      (collider) => {
        const grabbable = this.registry.fromCollider(collider.handle);
        if (grabbable && !grabbable.heldBy) {
          const t = grabbable.body.translation();
          // À distance égale, on préfère le petit objet de collection au meuble qu'il touche.
          const score = Math.hypot(t.x - hand.palm.x, t.y - hand.palm.y, t.z - hand.palm.z) - (grabbable.isCollectible ? 0.5 : 0);
          if (score < bestScore) {
            bestScore = score;
            best = grabbable;
          }
        }
        return true;
      },
      undefined,
      CollisionGroups.queryGrabbable,
    );
    return best;
  }

  private findAimed(hand: Hand): Grabbable | null {
    const ray = new RAPIER.Ray(hand.aimOrigin, hand.aimDirection);
    const hit = this.physics.world.castRay(ray, DISTANCE_GRAB_RANGE, true, undefined, CollisionGroups.querySight);
    if (!hit) return null;
    const grabbable = this.registry.fromCollider(hit.collider.handle);
    return grabbable && !grabbable.heldBy && grabbable.liftable ? grabbable : null;
  }

  private setHovered(hand: Hand, grabbable: Grabbable | null): void {
    if (this.hovered.get(hand) === grabbable) return;
    this.hovered.set(hand, grabbable);
    if (grabbable) hand.pulse(0.12, 12);
  }

  private attach(hand: Hand, grabbable: Grabbable, mode: "relative" | "centered"): void {
    // Passage d'une main à l'autre : l'autre main lâche d'abord.
    for (const [other, state] of this.held) if (state.grabbable === grabbable && other !== hand) this.release(other, false);

    const t = grabbable.body.translation();
    const r = grabbable.body.rotation();
    tmpCurrentPos.set(t.x, t.y, t.z);
    tmpCurrentQuat.set(r.x, r.y, r.z, r.w);
    const handInverse = hand.quaternion.clone().invert();
    const offsetQuaternion = handInverse.clone().multiply(tmpCurrentQuat);
    const offsetPosition =
      mode === "relative"
        ? tmpCurrentPos.clone().sub(hand.palm).applyQuaternion(handInverse)
        : grabbable.localCenter.clone().applyQuaternion(offsetQuaternion).negate();

    const strength = THREE.MathUtils.clamp(3.5 / grabbable.mass, 0.12, 1);
    this.held.set(hand, { grabbable, offsetPosition, offsetQuaternion, strength, stretchSeconds: 0 });
    hand.holding = grabbable;
    grabbable.heldBy = hand;
    grabbable.setHighlight(0);
    this.highlighted.delete(grabbable);
    this.releasing.delete(grabbable);
    grabbable.collider.setCollisionGroups(CollisionGroups.held);
    // Objet léger : apesanteur en main. Objet lourd : il pèse et traîne derrière la main.
    grabbable.body.setGravityScale(1 - strength, true);
    grabbable.body.wakeUp();
    hand.pulse(0.35, 30);
    this.sfx.play("grab", 0.35);
  }

  private computeTarget(hand: Hand, state: HeldState): void {
    tmpTargetPos.copy(state.offsetPosition).applyQuaternion(hand.quaternion).add(hand.palm);
    tmpTargetQuat.multiplyQuaternions(hand.quaternion, state.offsetQuaternion);
  }

  private track(hand: Hand, state: HeldState, stepSeconds: number): void {
    const body = state.grabbable.body;
    this.computeTarget(hand, state);
    const t = body.translation();
    const r = body.rotation();
    tmpCurrentPos.set(t.x, t.y, t.z);
    tmpCurrentQuat.set(r.x, r.y, r.z, r.w);

    tmpVec.subVectors(tmpTargetPos, tmpCurrentPos);
    const distance = tmpVec.length();
    state.stretchSeconds = distance > BREAK_DISTANCE ? state.stretchSeconds + stepSeconds : 0;
    if (state.stretchSeconds > BREAK_SECONDS) {
      this.release(hand, false);
      hand.pulse(0.5, 50);
      return;
    }

    tmpVec.multiplyScalar(state.strength / stepSeconds);
    if (tmpVec.length() > MAX_HOLD_SPEED) tmpVec.setLength(MAX_HOLD_SPEED);
    body.setLinvel(tmpVec, true);

    tmpDelta.copy(tmpCurrentQuat).invert().premultiply(tmpTargetQuat);
    if (tmpDelta.w < 0) tmpDelta.set(-tmpDelta.x, -tmpDelta.y, -tmpDelta.z, -tmpDelta.w);
    const angle = 2 * Math.acos(Math.min(1, tmpDelta.w));
    const sinHalf = Math.sqrt(Math.max(0, 1 - tmpDelta.w * tmpDelta.w));
    if (sinHalf < 1e-5) {
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      tmpVec.set(tmpDelta.x, tmpDelta.y, tmpDelta.z).divideScalar(sinHalf).multiplyScalar((angle / stepSeconds) * state.strength);
      if (tmpVec.length() > MAX_HOLD_ANGULAR_SPEED) tmpVec.setLength(MAX_HOLD_ANGULAR_SPEED);
      body.setAngvel(tmpVec, true);
    }
  }

  private release(hand: Hand, withThrow: boolean): void {
    const state = this.held.get(hand);
    if (!state) return;
    this.held.delete(hand);
    hand.holding = null;
    const { grabbable, strength } = state;
    grabbable.heldBy = null;
    grabbable.body.setGravityScale(1, true);
    if (withThrow) {
      tmpVec.copy(hand.velocity).multiplyScalar(THROW_BOOST * strength);
      grabbable.body.setLinvel(tmpVec, true);
      tmpVec.copy(hand.angularVelocity);
      if (tmpVec.length() > MAX_THROW_ANGULAR_SPEED) tmpVec.setLength(MAX_THROW_ANGULAR_SPEED);
      grabbable.body.setAngvel(tmpVec, true);
    }
    this.releasing.set(grabbable, this.time + RELEASE_GRACE_SECONDS);
  }

  private storeHeld(hand: Hand): void {
    const state = this.held.get(hand);
    if (!state?.grabbable.item) return;
    const item = state.grabbable.item;
    this.held.delete(hand);
    hand.holding = null;
    state.grabbable.heldBy = null;
    this.registry.remove(state.grabbable);
    this.hooks.store(item);
    hand.pulse(0.45, 70);
    this.sfx.play("store", 0.5);
  }

  private startPull(hand: Hand, grabbable: Grabbable): void {
    this.pulling.set(hand, { grabbable, elapsed: 0 });
    grabbable.collider.setCollisionGroups(CollisionGroups.held);
    grabbable.body.setGravityScale(0, true);
    grabbable.body.wakeUp();
    hand.pulse(0.25, 40);
  }

  private cancelPull(hand: Hand): void {
    const pull = this.pulling.get(hand);
    if (!pull) return;
    this.pulling.delete(hand);
    if (!this.registry.all.has(pull.grabbable)) return;
    pull.grabbable.body.setGravityScale(1, true);
    this.releasing.set(pull.grabbable, this.time + RELEASE_GRACE_SECONDS);
  }
}
