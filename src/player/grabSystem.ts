import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import type { UiPointer } from "../ui/uiPointer";
import { spawnCollectibleModel } from "../world/collectibleLoader";
import type { CollectionEntry } from "../world/collection";
import { MAX_LIFT_MASS, type Grabbable, type GrabbableRegistry } from "../world/grabbable";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

/** Rayon de saisie autour de la paume (généreux : attraper au contact, avant de bousculer). */
const NEAR_GRAB_RADIUS = 0.13;
/** Portée de la saisie à distance (fiche / Saints & Sinners : l'objet vient dans la main). */
const DISTANCE_GRAB_RANGE = 4;
/** Rayon du "cylindre" de visée : pas besoin de viser au pixel près. */
const AIM_RADIUS = 0.07;
/** Gâchette enfoncée au-delà : le rayon de visée s'affiche (saisie à distance possible). */
const AIM_TRIGGER = 0.35;
const BEAM_COLOR = 0xffe3a0;
/** Masse max soulevable à deux mains (au-delà : on ne peut que traîner). */
const MAX_TWO_HAND_LIFT_MASS = MAX_LIFT_MASS * 2;
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
  stretchSeconds: number;
}

interface AimBeam {
  line: THREE.Line;
  dot: THREE.Mesh;
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
const tmpTargetPos2 = new THREE.Vector3();
const tmpTargetQuat2 = new THREE.Quaternion();

/**
 * Saisie et manipulation physique des objets (contrôles type Saints & Sinners) :
 * - grip au contact d'un objet : on le prend là où on le touche ;
 * - gâchette maintenue : un rayon de visée s'affiche (jusqu'à 4 m, l'objet visé s'illumine) ;
 *   grip pendant la visée : l'objet vole jusqu'à la main ;
 * - deux mains sur le même objet : il suit la moyenne des deux (on le tourne, on le porte),
 *   et un meuble trop lourd pour une main se soulève à deux ; d'une seule main, on le traîne ;
 * - changer de main : saisir avec l'autre main, puis lâcher la première ;
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
  private readonly aimBall = new RAPIER.Ball(AIM_RADIUS);
  private readonly beams = new Map<Hand, AimBeam>();
  private time = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly registry: GrabbableRegistry,
    private readonly hands: Hand[],
    private readonly sfx: Sfx,
    private readonly hooks: GrabHooks,
    scene?: THREE.Scene,
  ) {
    if (!scene) return;
    for (const hand of hands) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: 0.45, depthWrite: false, fog: false }),
      );
      line.frustumCulled = false;
      line.visible = false;
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 10, 8),
        new THREE.MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: 0.8, fog: false }),
      );
      dot.visible = false;
      scene.add(line, dot);
      this.beams.set(hand, { line, dot });
    }
  }

  /** Mains qui tiennent un objet donné. */
  private holdersOf(grabbable: Grabbable): Hand[] {
    const holders: Hand[] = [];
    for (const [hand, state] of this.held) if (state.grabbable === grabbable) holders.push(hand);
    return holders;
  }

  /** Force de suivi selon la masse et le nombre de mains ; soulevé ou seulement traîné. */
  private gripFor(grabbable: Grabbable, handCount: number): { strength: number; lifted: boolean } {
    const lifted = handCount >= 2 ? grabbable.mass <= MAX_TWO_HAND_LIFT_MASS : grabbable.liftable;
    const strength = THREE.MathUtils.clamp((3.5 * handCount) / grabbable.mass, 0.08, 1);
    return { strength, lifted };
  }

  private updateBeam(hand: Hand, aiming: boolean, hitPoint: THREE.Vector3 | null): void {
    const beam = this.beams.get(hand);
    if (!beam) return;
    beam.line.visible = aiming;
    beam.dot.visible = aiming && hitPoint !== null;
    if (!aiming) return;
    const end = hitPoint ?? tmpVec.copy(hand.aimOrigin).addScaledVector(hand.aimDirection, DISTANCE_GRAB_RANGE);
    const positions = beam.line.geometry.getAttribute("position") as THREE.BufferAttribute;
    positions.setXYZ(0, hand.aimOrigin.x, hand.aimOrigin.y, hand.aimOrigin.z);
    positions.setXYZ(1, end.x, end.y, end.z);
    positions.needsUpdate = true;
    if (hitPoint) beam.dot.position.copy(hitPoint);
  }

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
        this.updateBeam(hand, false, null);
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
        this.updateBeam(hand, false, null);
        continue;
      }

      if (this.pulling.has(hand)) {
        if (!input.squeeze.pressed) this.cancelPull(hand);
        this.updateBeam(hand, false, null);
        continue;
      }

      const frame = pointer.frame(hand);
      if (frame.target || this.pendingTake.has(hand)) {
        this.setHovered(hand, null);
        this.updateBeam(hand, false, null);
        continue;
      }

      // Contact d'abord ; la saisie à distance n'existe que gâchette maintenue (rayon visible).
      const near = this.findNear(hand);
      const aiming = !near && input.trigger.value > AIM_TRIGGER;
      const aimed = aiming ? this.findAimed(hand) : null;
      this.updateBeam(hand, aiming, aimed?.point ?? null);
      const far = aimed?.grabbable ?? null;
      const candidate = near ?? far;
      if (candidate && this.holdersOf(candidate).length === 0) desired.set(candidate, Math.max(desired.get(candidate) ?? 0, near ? 2 : 1) as 1 | 2);
      this.setHovered(hand, candidate);

      if (input.squeeze.justPressed && !frame.consumedGrip && candidate) {
        if (near) this.attach(hand, candidate, "relative");
        else if (candidate.liftable) this.startPull(hand, candidate);
        else {
          // Trop lourd pour voler jusqu'à la main : il faut aller le chercher.
          hand.pulse(0.6, 60);
          this.sfx.play("denied", 0.3);
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
    const tracked = new Set<Grabbable>();
    for (const state of this.held.values()) {
      if (tracked.has(state.grabbable)) continue;
      tracked.add(state.grabbable);
      this.track(state.grabbable, stepSeconds);
    }

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
    for (const state of this.held.values()) {
      this.computeGroupTarget(state.grabbable);
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
    // Objets déjà tenus par l'autre main (groupe "tenu", invisible à la requête ci-dessus) :
    // test de proximité direct, pour la prise à deux mains.
    for (const state of this.held.values()) {
      const projection = state.grabbable.collider.projectPoint(hand.palm, true);
      if (!projection) continue;
      const gap = projection.isInside ? 0 : Math.hypot(projection.point.x - hand.palm.x, projection.point.y - hand.palm.y, projection.point.z - hand.palm.z);
      if (gap < NEAR_GRAB_RADIUS && gap < bestScore) {
        bestScore = gap;
        best = state.grabbable;
      }
    }
    return best;
  }

  private findAimed(hand: Hand): { grabbable: Grabbable | null; point: THREE.Vector3 } | null {
    const hit = this.physics.world.castShape(
      hand.aimOrigin,
      IDENTITY,
      hand.aimDirection,
      this.aimBall,
      0,
      DISTANCE_GRAB_RANGE,
      true,
      undefined,
      CollisionGroups.querySight,
    );
    if (!hit) return null;
    const point = new THREE.Vector3().copy(hand.aimOrigin).addScaledVector(hand.aimDirection, hit.time_of_impact);
    const grabbable = this.registry.fromCollider(hit.collider.handle);
    return { grabbable: grabbable && this.holdersOf(grabbable).length === 0 ? grabbable : null, point };
  }

  private setHovered(hand: Hand, grabbable: Grabbable | null): void {
    if (this.hovered.get(hand) === grabbable) return;
    this.hovered.set(hand, grabbable);
    if (grabbable) hand.pulse(0.12, 12);
  }

  private attach(hand: Hand, grabbable: Grabbable, mode: "relative" | "centered"): void {
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

    this.held.set(hand, { grabbable, offsetPosition, offsetQuaternion, stretchSeconds: 0 });
    hand.holding = grabbable;
    grabbable.heldBy = hand;
    grabbable.setHighlight(0);
    this.highlighted.delete(grabbable);
    this.releasing.delete(grabbable);
    grabbable.collider.setCollisionGroups(CollisionGroups.held);
    // Tenu, il peut aller vite (lancer, balayage) : anti-traversée activé.
    grabbable.body.enableCcd(true);
    this.applyGrip(grabbable);
    grabbable.body.wakeUp();
    hand.pulse(0.35, 30);
    this.sfx.play("grab", 0.35);
  }

  /** Objet léger (ou lourd porté à deux) : il flotte en main ; trop lourd : il pèse, on le traîne. */
  private applyGrip(grabbable: Grabbable): void {
    const { strength, lifted } = this.gripFor(grabbable, this.holdersOf(grabbable).length);
    grabbable.body.setGravityScale(lifted ? 1 - strength : 1, true);
  }

  private computeTarget(hand: Hand, state: HeldState): void {
    tmpTargetPos.copy(state.offsetPosition).applyQuaternion(hand.quaternion).add(hand.palm);
    tmpTargetQuat.multiplyQuaternions(hand.quaternion, state.offsetQuaternion);
  }

  /** Cible commune d'un objet : celle de la main qui le tient, ou la moyenne des deux. */
  private computeGroupTarget(grabbable: Grabbable): Hand[] {
    const holders = this.holdersOf(grabbable);
    this.computeTarget(holders[0]!, this.held.get(holders[0]!)!);
    if (holders.length > 1) {
      tmpTargetPos2.copy(tmpTargetPos);
      tmpTargetQuat2.copy(tmpTargetQuat);
      this.computeTarget(holders[1]!, this.held.get(holders[1]!)!);
      tmpTargetPos.lerp(tmpTargetPos2, 0.5);
      tmpTargetQuat.slerp(tmpTargetQuat2, 0.5);
    }
    return holders;
  }

  private track(grabbable: Grabbable, stepSeconds: number): void {
    const body = grabbable.body;
    const holders = this.computeGroupTarget(grabbable);
    const { strength, lifted } = this.gripFor(grabbable, holders.length);
    const t = body.translation();
    const r = body.rotation();
    tmpCurrentPos.set(t.x, t.y, t.z);
    tmpCurrentQuat.set(r.x, r.y, r.z, r.w);

    tmpVec.subVectors(tmpTargetPos, tmpCurrentPos);
    const distance = tmpVec.length();
    for (const hand of holders) {
      const state = this.held.get(hand)!;
      state.stretchSeconds = distance > BREAK_DISTANCE ? state.stretchSeconds + stepSeconds : 0;
      if (state.stretchSeconds > BREAK_SECONDS) {
        this.release(hand, false);
        hand.pulse(0.5, 50);
        return;
      }
    }

    tmpVec.multiplyScalar(strength / stepSeconds);
    if (tmpVec.length() > MAX_HOLD_SPEED) tmpVec.setLength(MAX_HOLD_SPEED);
    if (!lifted) {
      // Trop lourd pour la ou les mains : on le traîne au sol (la gravité garde la verticale,
      // la physique gère son basculement).
      tmpVec.y = body.linvel().y;
      body.setLinvel(tmpVec, true);
      return;
    }
    body.setLinvel(tmpVec, true);

    tmpDelta.copy(tmpCurrentQuat).invert().premultiply(tmpTargetQuat);
    if (tmpDelta.w < 0) tmpDelta.set(-tmpDelta.x, -tmpDelta.y, -tmpDelta.z, -tmpDelta.w);
    const angle = 2 * Math.acos(Math.min(1, tmpDelta.w));
    const sinHalf = Math.sqrt(Math.max(0, 1 - tmpDelta.w * tmpDelta.w));
    if (sinHalf < 1e-5) {
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      tmpVec.set(tmpDelta.x, tmpDelta.y, tmpDelta.z).divideScalar(sinHalf).multiplyScalar((angle / stepSeconds) * strength);
      if (tmpVec.length() > MAX_HOLD_ANGULAR_SPEED) tmpVec.setLength(MAX_HOLD_ANGULAR_SPEED);
      body.setAngvel(tmpVec, true);
    }
  }

  private release(hand: Hand, withThrow: boolean): void {
    const state = this.held.get(hand);
    if (!state) return;
    this.held.delete(hand);
    hand.holding = null;
    const { grabbable } = state;
    // L'autre main tient encore l'objet : il reste en main (changement de main), pas de lancer.
    const remaining = this.holdersOf(grabbable);
    if (remaining.length > 0) {
      grabbable.heldBy = remaining[0]!;
      this.applyGrip(grabbable);
      return;
    }
    const { strength } = this.gripFor(grabbable, 1);
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
    for (const holder of this.holdersOf(state.grabbable)) {
      this.held.delete(holder);
      holder.holding = null;
    }
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
