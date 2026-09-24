import * as THREE from "three";
import { log } from "../debug/debugLog";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import type { UiPointer } from "../ui/uiPointer";
import { spawnCollectibleModel } from "../world/collectibleLoader";
import type { CollectionEntry } from "../world/collection";
import { MAX_LIFT_MASS, type Grabbable, type GrabbableRegistry } from "../world/grabbable";
import type { Hand } from "./hand";
import type { Sfx } from "./sfx";

/** Rayon de saisie autour de la paume (généreux : attraper au contact, avant de bousculer). */
const NEAR_GRAB_RADIUS = 0.13;
/** Portée de la saisie à distance. */
const DISTANCE_GRAB_RANGE = 5;
/** Rayon du "cylindre" de visée : pas besoin de viser au pixel près. */
const AIM_RADIUS = 0.08;
/** Gâchette enfoncée au-delà : le rayon de visée s'affiche. */
const AIM_TRIGGER = 0.35;
const BEAM_COLOR = 0xffe3a0;
const TETHER_COLOR = 0x9fe39f;
/** Masse max soulevable à deux mains (au-delà : on ne peut que traîner). */
const MAX_TWO_HAND_LIFT_MASS = MAX_LIFT_MASS * 2;

/** Coup de poignet vers soi (m/s) qui déclenche l'attraction d'un objet verrouillé. */
const FLICK_SPEED = 1.1;
/** Sans coup de poignet, l'objet verrouillé finit par venir tout seul (accessibilité). */
const LOCK_FALLBACK_SECONDS = 0.9;
const LOCK_TIMEOUT_SECONDS = 4;
/** Objet en vol vers la main : rattrapé automatiquement s'il passe à portée, grip tenu. */
const CATCH_RADIUS = 0.3;
const INCOMING_TIMEOUT_SECONDS = 1.6;
const PULL_SPEED = 6;
const PULL_TIMEOUT_SECONDS = 1.4;

const MAX_HOLD_SPEED = 14;
const MAX_HOLD_ANGULAR_SPEED = 28;
/** Objet coincé (derrière un mur) trop loin de la main pendant trop longtemps : il est lâché. */
const BREAK_DISTANCE = 0.45;
const BREAK_SECONDS = 0.25;
const THROW_BOOST = 1.3;
const MAX_THROW_ANGULAR_SPEED = 25;
/** Juste après un lâcher, l'objet ne percute pas encore le corps du joueur (il en sort). */
const RELEASE_GRACE_SECONDS = 0.35;
/** Objet traîné : part maximale de son poids que la main peut porter (il reste au sol). */
const DRAG_MAX_LIFT = 0.55;
const GRAVITY = new THREE.Vector3(0, -9.81, 0);

export interface GrabHooks {
  /** L'inventaire est ouvert et la main (ou son pointeur) est dessus : relâcher y range l'objet. */
  isOverInventory(hand: Hand): boolean;
  /** Index de la case d'inventaire visée/touchée au lâcher (rangement à cet endroit), sinon null. */
  inventorySlotAt?(hand: Hand): number | null;
  store(item: CollectionEntry, slotIndex?: number | null): void;
  /** Pose de la tête (rangement "par-dessus l'épaule", comme le sac de Saints & Sinners). */
  head?(): { position: THREE.Vector3; forward: THREE.Vector3 };
}

interface HeldState {
  grabbable: Grabbable;
  /** Point de saisie, dans le repère local du corps (là où la main tient l'objet). */
  grabPointLocal: THREE.Vector3;
  offsetQuaternion: THREE.Quaternion;
  stretchSeconds: number;
}

interface Beam {
  tube: THREE.Mesh;
  dot: THREE.Mesh;
}

type RemoteState =
  | { kind: "locked"; grabbable: Grabbable; elapsed: number }
  | { kind: "incoming"; grabbable: Grabbable; elapsed: number }
  | { kind: "pulling"; grabbable: Grabbable; elapsed: number };

const IDENTITY = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpTargetPos = new THREE.Vector3();
const tmpTargetQuat = new THREE.Quaternion();
const tmpCurrentPos = new THREE.Vector3();
const tmpCurrentQuat = new THREE.Quaternion();
const tmpDelta = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpTargetPos2 = new THREE.Vector3();
const tmpTargetQuat2 = new THREE.Quaternion();

/**
 * Saisie et manipulation physique des objets, au plus près de The Walking Dead: Saints & Sinners :
 * - grip au contact : on prend l'objet LÀ où on le touche (point de la surface réelle le plus
 *   proche de la paume, forme de collision fidèle au modèle), pas par son centre ;
 * - la main visible reste posée sur l'objet ; si l'objet est bloqué ou trop lourd pour suivre,
 *   une main fantôme translucide montre où est réellement la manette ;
 * - poids : un objet léger suit la main, un objet lourd traîne derrière ; trop lourd pour une
 *   main, il est tiré par le point saisi (il pivote, bascule, racle le sol) ; à deux mains, on
 *   le soulève ;
 * - à distance : gâchette maintenue = rayon de visée ; grip sur l'objet visé = verrouillage
 *   (lien lumineux) ; coup de poignet vers soi = l'objet vole en cloche vers la main, et se
 *   rattrape au vol en gardant le grip ;
 * - lâcher = lancer avec la vitesse réelle de la main ; lâcher derrière l'épaule, sur le menu
 *   d'inventaire (à la case visée) ou A/X = ranger dans le sac ;
 * - changer de main : saisir avec l'autre, lâcher la première.
 */
export class GrabSystem {
  private readonly held = new Map<Hand, HeldState>();
  private readonly remote = new Map<Hand, RemoteState>();
  private readonly releasing = new Map<Grabbable, number>();
  private readonly hovered = new Map<Hand, Grabbable | null>();
  private readonly highlighted = new Set<Grabbable>();
  private readonly pendingTake = new Set<Hand>();
  private readonly grabBall = new RAPIER.Ball(NEAR_GRAB_RADIUS);
  private readonly aimBall = new RAPIER.Ball(AIM_RADIUS);
  private readonly beams = new Map<Hand, Beam>();
  private time = 0;
  private frameSeconds = 1 / 72;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly registry: GrabbableRegistry,
    private readonly hands: Hand[],
    private readonly sfx: Sfx,
    private readonly hooks: GrabHooks,
    scene?: THREE.Scene,
  ) {
    if (!scene) return;
    // Tube fin (pas une ligne de 1 px, invisible en casque), lumineux et semi-transparent.
    const tubeGeometry = new THREE.CylinderGeometry(0.0035, 0.0015, 1, 8, 1, true).translate(0, 0.5, 0);
    for (const hand of hands) {
      const tube = new THREE.Mesh(
        tubeGeometry,
        new THREE.MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: 0.55, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }),
      );
      tube.frustumCulled = false;
      tube.visible = false;
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.014, 12, 8),
        new THREE.MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: 0.9, fog: false, depthTest: false }),
      );
      dot.renderOrder = 12;
      dot.visible = false;
      scene.add(tube, dot);
      this.beams.set(hand, { tube, dot });
    }
  }

  isHolding(hand: Hand): boolean {
    return this.held.has(hand);
  }

  /** Mains qui tiennent un objet donné. */
  private holdersOf(grabbable: Grabbable): Hand[] {
    const holders: Hand[] = [];
    for (const [hand, state] of this.held) if (state.grabbable === grabbable) holders.push(hand);
    return holders;
  }

  private isRemoteTarget(grabbable: Grabbable): boolean {
    for (const state of this.remote.values()) if (state.grabbable === grabbable) return true;
    return false;
  }

  /** Force de suivi selon la masse et le nombre de mains ; soulevé ou seulement traîné. */
  private gripFor(grabbable: Grabbable, handCount: number): { strength: number; lifted: boolean } {
    const lifted = handCount >= 2 ? grabbable.mass <= MAX_TWO_HAND_LIFT_MASS : grabbable.liftable;
    const strength = THREE.MathUtils.clamp((3.5 * handCount) / grabbable.mass, 0.08, 1);
    return { strength, lifted };
  }

  update(time: number, pointer: UiPointer): void {
    this.frameSeconds = THREE.MathUtils.clamp(time - this.time, 0, 0.1);
    this.time = time;
    const desired = new Map<Grabbable, 1 | 2>();

    for (const hand of this.hands) {
      if (!hand.tracked) {
        if (this.held.has(hand)) this.release(hand, false);
        this.cancelRemote(hand);
        this.setHovered(hand, null);
        this.hideBeam(hand);
        continue;
      }

      const input = hand.input;
      if (this.held.has(hand)) {
        const state = this.held.get(hand)!;
        if (input.primary.justPressed && state.grabbable.item) this.storeHeld(hand, null);
        else if (input.squeeze.justReleased) {
          if (state.grabbable.item && this.hooks.isOverInventory(hand)) this.storeHeld(hand, this.hooks.inventorySlotAt?.(hand) ?? null);
          else if (state.grabbable.item && this.isOverShoulder(hand)) this.storeHeld(hand, null);
          else this.release(hand, true);
        }
        this.setHovered(hand, null);
        this.hideBeam(hand);
        continue;
      }

      const remote = this.remote.get(hand);
      if (remote) {
        this.updateRemote(hand, remote);
        continue;
      }

      const frame = pointer.frame(hand);
      if (frame.target || this.pendingTake.has(hand)) {
        this.setHovered(hand, null);
        this.hideBeam(hand);
        continue;
      }

      // Contact d'abord ; la saisie à distance n'existe que gâchette maintenue (rayon visible).
      const near = this.findNear(hand);
      const aiming = !near && input.trigger.value > AIM_TRIGGER;
      const aimed = aiming ? this.findAimed(hand) : null;
      if (aiming) this.showBeam(hand, hand.aimOrigin, aimed?.point ?? null, BEAM_COLOR);
      else this.hideBeam(hand);
      const far = aimed?.grabbable ?? null;
      const candidate = near ?? far;
      if (candidate && this.holdersOf(candidate).length === 0) desired.set(candidate, Math.max(desired.get(candidate) ?? 0, near ? 2 : 1) as 1 | 2);
      this.setHovered(hand, candidate);

      if (input.squeeze.justPressed && !frame.consumedGrip && candidate) {
        if (near) this.attach(hand, candidate, "contact");
        else if (candidate.liftable) {
          // Verrouillage : l'objet attend le coup de poignet (ou vient seul après un instant).
          this.remote.set(hand, { kind: "locked", grabbable: candidate, elapsed: 0 });
          hand.pulse(0.3, 40);
          log("grab", { action: "lock", mass: candidate.mass });
        } else {
          hand.pulse(0.6, 60);
          this.sfx.play("denied", 0.3);
        }
      }
    }

    for (const state of this.remote.values()) desired.set(state.grabbable, 1);
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

  /** Saisie à distance : verrou -> coup de poignet -> vol en cloche -> rattrapage. */
  private updateRemote(hand: Hand, state: RemoteState): void {
    const { grabbable } = state;
    if (!this.registry.all.has(grabbable) || this.holdersOf(grabbable).length > 0) {
      this.cancelRemote(hand);
      return;
    }
    state.elapsed += this.frameSeconds;
    const t = grabbable.body.translation();
    tmpVec.set(t.x, t.y, t.z);

    if (!hand.input.squeeze.pressed) {
      this.cancelRemote(hand);
      return;
    }

    if (state.kind === "locked") {
      this.showBeam(hand, hand.palm, tmpVec, TETHER_COLOR);
      // Coup de poignet : vitesse de la main dirigée de l'objet vers le joueur (ou vers le haut).
      tmpVec2.subVectors(hand.palm, tmpVec).normalize();
      const towardPlayer = hand.velocity.dot(tmpVec2);
      if (towardPlayer > FLICK_SPEED || hand.velocity.y > FLICK_SPEED * 1.3) {
        this.launchToward(hand, grabbable);
        this.remote.set(hand, { kind: "incoming", grabbable, elapsed: 0 });
        log("grab", { action: "flick", speed: Math.round(towardPlayer * 100) / 100 });
      } else if (state.elapsed > LOCK_FALLBACK_SECONDS) {
        this.remote.set(hand, { kind: "pulling", grabbable, elapsed: 0 });
        grabbable.collider.setCollisionGroups(CollisionGroups.held);
        grabbable.body.setGravityScale(0, true);
        grabbable.body.wakeUp();
      } else if (state.elapsed > LOCK_TIMEOUT_SECONDS) this.cancelRemote(hand);
      return;
    }

    this.hideBeam(hand);
    const distance = tmpVec.distanceTo(hand.palm);
    if (distance < CATCH_RADIUS) {
      this.remote.delete(hand);
      this.attach(hand, grabbable, "contact");
      return;
    }
    const timeout = state.kind === "incoming" ? INCOMING_TIMEOUT_SECONDS : PULL_TIMEOUT_SECONDS;
    if (state.elapsed > timeout) this.cancelRemote(hand);
  }

  /** Lance l'objet sur une trajectoire balistique qui arrive dans la main (~0,4 à 0,7 s). */
  private launchToward(hand: Hand, grabbable: Grabbable): void {
    const t = grabbable.body.translation();
    tmpVec.set(hand.palm.x - t.x, hand.palm.y - t.y, hand.palm.z - t.z);
    const flight = THREE.MathUtils.clamp(tmpVec.length() / 7, 0.35, 0.7);
    tmpVec.divideScalar(flight).addScaledVector(GRAVITY, -0.5 * flight);
    grabbable.body.wakeUp();
    grabbable.body.setGravityScale(1, true);
    grabbable.body.setLinvel(tmpVec, true);
    grabbable.body.setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);
    // Il ne doit pas percuter le joueur en arrivant : groupe "tenu" pendant le vol.
    grabbable.collider.setCollisionGroups(CollisionGroups.held);
    grabbable.body.enableCcd(true);
    hand.pulse(0.4, 50);
    this.sfx.play("grab", 0.25);
  }

  private cancelRemote(hand: Hand): void {
    const state = this.remote.get(hand);
    if (!state) return;
    this.remote.delete(hand);
    this.hideBeam(hand);
    if (!this.registry.all.has(state.grabbable) || this.holdersOf(state.grabbable).length > 0) return;
    state.grabbable.body.setGravityScale(1, true);
    this.releasing.set(state.grabbable, this.time + RELEASE_GRACE_SECONDS);
  }

  /** Avant chaque pas de simulation : suivi des objets tenus, attraction des objets tirés. */
  step(stepSeconds: number): void {
    const tracked = new Set<Grabbable>();
    for (const state of this.held.values()) {
      if (tracked.has(state.grabbable)) continue;
      tracked.add(state.grabbable);
      this.track(state.grabbable, stepSeconds);
    }

    for (const [hand, state] of this.remote) {
      if (state.kind !== "pulling" || !this.registry.all.has(state.grabbable)) continue;
      state.elapsed += stepSeconds;
      const t = state.grabbable.body.translation();
      tmpVec.set(hand.palm.x - t.x, hand.palm.y - t.y, hand.palm.z - t.z);
      const distance = tmpVec.length();
      if (distance < 1e-3) continue;
      const speed = Math.min(PULL_SPEED, distance / 0.12);
      tmpVec.multiplyScalar(speed / distance);
      state.grabbable.body.setLinvel(tmpVec, true);
      state.grabbable.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    for (const [grabbable, until] of this.releasing) {
      if (this.time < until) continue;
      this.releasing.delete(grabbable);
      if (!grabbable.heldBy && !this.isRemoteTarget(grabbable) && this.registry.all.has(grabbable)) {
        grabbable.collider.setCollisionGroups(CollisionGroups.dynamic);
      }
    }
  }

  /**
   * Après la physique : la main visible se pose sur l'objet (au point saisi), la main fantôme
   * reste à la manette. Pas de main visible "dans le vide" à côté d'un objet bloqué.
   */
  updateVisuals(): void {
    for (const hand of this.hands) {
      const state = this.held.get(hand);
      if (!state || !this.registry.all.has(state.grabbable)) {
        hand.setHeldAnchor(null);
        continue;
      }
      const t = state.grabbable.body.translation();
      const r = state.grabbable.body.rotation();
      tmpCurrentQuat.set(r.x, r.y, r.z, r.w);
      tmpVec.copy(state.grabPointLocal).applyQuaternion(tmpCurrentQuat).add(tmpCurrentPos.set(t.x, t.y, t.z));
      hand.setHeldAnchor(tmpVec);
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
    for (const hand of [...this.remote.keys()]) this.cancelRemote(hand);
  }

  /** Le joueur est emporté (rattrapé par le Cadreur) : ce qu'il tenait reste derrière et disparaît. */
  loseHeld(): void {
    const lost = new Set([...this.held.values()].map((state) => state.grabbable));
    for (const hand of [...this.held.keys()]) this.release(hand, false);
    for (const grabbable of lost) {
      this.releasing.delete(grabbable);
      this.registry.remove(grabbable);
    }
    for (const hand of [...this.remote.keys()]) this.cancelRemote(hand);
  }

  /** Sort un objet de l'inventaire directement dans la main, à sa taille réelle. */
  takeIntoHand(hand: Hand, item: CollectionEntry, onFailure: () => void): void {
    if (this.held.has(hand) || this.pendingTake.has(hand)) {
      onFailure();
      return;
    }
    // Un exemplaire traîne déjà dans le monde : l'inventaire fait foi, on retire l'autre
    // (s'il est tenu par l'autre main, c'est lui le vrai : l'entrée d'inventaire disparaît).
    const existing = this.registry.itemInWorld(item.id);
    if (existing?.heldBy) return;
    if (existing) this.registry.remove(existing);
    this.pendingTake.add(hand);
    this.registry.reserveItem(item.id);
    let created = false;
    spawnCollectibleModel(item.kind)
      .then(({ model, template }) => {
        this.pendingTake.delete(hand);
        if (this.held.has(hand) || !hand.tracked) {
          this.registry.releaseItem(item.id);
          onFailure();
          return;
        }
        const grabbable = this.registry.createCollectible(item, model, template, hand.palm.clone(), hand.quaternion.clone());
        created = true;
        this.attach(hand, grabbable, "centered");
        this.sfx.play("take", 0.45);
      })
      .catch((error: unknown) => {
        this.pendingTake.delete(hand);
        // L'objet est déjà dans la main : ne surtout pas le remettre aussi dans l'inventaire.
        if (created) {
          log("error", { where: "takeIntoHand", error: String(error) });
          return;
        }
        this.registry.releaseItem(item.id);
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
        if (grabbable && !grabbable.heldBy && !this.isRemoteTarget(grabbable)) {
          const projection = collider.projectPoint(hand.palm, true);
          const gap = projection ? hand.palm.distanceTo(tmpVec.set(projection.point.x, projection.point.y, projection.point.z)) : NEAR_GRAB_RADIUS;
          // À distance égale, on préfère le petit objet de collection au meuble qu'il touche.
          const score = gap - (grabbable.isCollectible ? 0.05 : 0);
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
      const gap = projection.isInside ? 0 : hand.palm.distanceTo(tmpVec.set(projection.point.x, projection.point.y, projection.point.z));
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

  private showBeam(hand: Hand, from: THREE.Vector3, to: THREE.Vector3 | null, color: number): void {
    const beam = this.beams.get(hand);
    if (!beam) return;
    const end = to ?? tmpVec2.copy(hand.aimOrigin).addScaledVector(hand.aimDirection, DISTANCE_GRAB_RANGE);
    const length = from.distanceTo(end);
    beam.tube.visible = length > 0.01;
    beam.tube.position.copy(from);
    beam.tube.scale.set(1, length, 1);
    beam.tube.quaternion.setFromUnitVectors(Y_AXIS, tmpTargetPos2.subVectors(end, from).normalize());
    (beam.tube.material as THREE.MeshBasicMaterial).color.setHex(color);
    beam.dot.visible = to !== null;
    if (to) beam.dot.position.copy(to);
  }

  private hideBeam(hand: Hand): void {
    const beam = this.beams.get(hand);
    if (!beam) return;
    beam.tube.visible = false;
    beam.dot.visible = false;
  }

  /** Rangement "par-dessus l'épaule" : main lâchée derrière le plan de la tête, assez haut. */
  private isOverShoulder(hand: Hand): boolean {
    const head = this.hooks.head?.();
    if (!head) return false;
    tmpVec.subVectors(hand.palm, head.position);
    tmpVec2.copy(head.forward).setY(0).normalize();
    return tmpVec.dot(tmpVec2) < -0.05 && hand.palm.y > head.position.y - 0.35;
  }

  private attach(hand: Hand, grabbable: Grabbable, mode: "contact" | "centered"): void {
    const t = grabbable.body.translation();
    const r = grabbable.body.rotation();
    tmpCurrentPos.set(t.x, t.y, t.z);
    tmpCurrentQuat.set(r.x, r.y, r.z, r.w);
    const handInverse = hand.quaternion.clone().invert();
    const offsetQuaternion = handInverse.multiply(tmpCurrentQuat);
    const bodyInverse = tmpCurrentQuat.clone().invert();

    let grabPointLocal: THREE.Vector3;
    if (mode === "centered") {
      grabPointLocal = grabbable.localCenter.clone();
    } else {
      // Point de la surface réelle le plus proche de la paume : c'est lui qui vient dans la main.
      const projection = grabbable.collider.projectPoint(hand.palm, true);
      const surface = projection && !projection.isInside ? new THREE.Vector3(projection.point.x, projection.point.y, projection.point.z) : hand.palm.clone();
      grabPointLocal = surface.sub(tmpCurrentPos).applyQuaternion(bodyInverse);
    }

    this.held.set(hand, { grabbable, grabPointLocal, offsetQuaternion, stretchSeconds: 0 });
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
    log("grab", { action: "attach", mode, mass: grabbable.mass, item: grabbable.item?.kind ?? "prop", hands: this.holdersOf(grabbable).length });
  }

  /** Objet léger (ou lourd porté à deux) : il flotte en main ; trop lourd : il pèse, on le traîne. */
  private applyGrip(grabbable: Grabbable): void {
    const { strength, lifted } = this.gripFor(grabbable, this.holdersOf(grabbable).length);
    grabbable.body.setGravityScale(lifted ? 1 - strength : 1, true);
  }

  /** Cible du corps pour une main : orientation relative figée, point saisi dans la paume. */
  private computeTarget(hand: Hand, state: HeldState): void {
    tmpTargetQuat.multiplyQuaternions(hand.quaternion, state.offsetQuaternion);
    tmpTargetPos.copy(state.grabPointLocal).applyQuaternion(tmpTargetQuat).negate().add(hand.palm);
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
    const holders = this.holdersOf(grabbable);
    const { strength, lifted } = this.gripFor(grabbable, holders.length);
    if (!lifted) {
      this.drag(grabbable, holders, stepSeconds);
      return;
    }

    this.computeGroupTarget(grabbable);
    const t = body.translation();
    const r = body.rotation();
    tmpCurrentPos.set(t.x, t.y, t.z);
    tmpCurrentQuat.set(r.x, r.y, r.z, r.w);

    tmpVec.subVectors(tmpTargetPos, tmpCurrentPos);
    const distance = tmpVec.length();
    if (this.checkStretch(holders, distance, stepSeconds)) return;

    tmpVec.multiplyScalar(strength / stepSeconds);
    if (tmpVec.length() > MAX_HOLD_SPEED) tmpVec.setLength(MAX_HOLD_SPEED);
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

  /**
   * Trop lourd pour être porté : chaque main tire sur SON point de saisie (impulsion appliquée
   * à ce point) — l'objet pivote autour, bascule, racle le sol, comme une chaise tirée par le
   * dossier. La main ne peut porter qu'une partie de son poids : il reste au sol.
   */
  private drag(grabbable: Grabbable, holders: Hand[], stepSeconds: number): void {
    const body = grabbable.body;
    const t = body.translation();
    const r = body.rotation();
    tmpCurrentPos.set(t.x, t.y, t.z);
    tmpCurrentQuat.set(r.x, r.y, r.z, r.w);
    const linvel = body.linvel();
    const angvel = body.angvel();
    const perHandMass = grabbable.mass / holders.length;
    for (const hand of holders) {
      const state = this.held.get(hand)!;
      // Point saisi (monde) et sa vitesse actuelle.
      const point = tmpTargetPos.copy(state.grabPointLocal).applyQuaternion(tmpCurrentQuat).add(tmpCurrentPos);
      const arm = tmpVec2.subVectors(point, tmpCurrentPos);
      const pointVelocity = new THREE.Vector3(linvel.x, linvel.y, linvel.z).add(new THREE.Vector3(angvel.x, angvel.y, angvel.z).cross(arm));
      tmpVec.subVectors(hand.palm, point);
      if (this.checkStretch([hand], tmpVec.length(), stepSeconds, 0.9)) return;
      // Vitesse voulue du point : rejoindre la main ; impulsion = masse × écart de vitesse (amortie).
      const desired = tmpVec.multiplyScalar(6);
      const impulse = desired.sub(pointVelocity).multiplyScalar(perHandMass * 0.25);
      const maxLift = grabbable.mass * 9.81 * stepSeconds * DRAG_MAX_LIFT;
      impulse.y = Math.min(impulse.y, maxLift);
      body.applyImpulseAtPoint(impulse, point, true);
    }
  }

  /** Objet coincé trop loin de la main trop longtemps : la ou les mains lâchent. */
  private checkStretch(holders: Hand[], distance: number, stepSeconds: number, limit = BREAK_DISTANCE): boolean {
    for (const hand of holders) {
      const state = this.held.get(hand);
      if (!state) continue;
      state.stretchSeconds = distance > limit ? state.stretchSeconds + stepSeconds : 0;
      if (state.stretchSeconds > BREAK_SECONDS) {
        this.release(hand, false);
        hand.pulse(0.5, 50);
        return true;
      }
    }
    return false;
  }

  private release(hand: Hand, withThrow: boolean): void {
    const state = this.held.get(hand);
    if (!state) return;
    this.held.delete(hand);
    hand.holding = null;
    hand.setHeldAnchor(null);
    const { grabbable } = state;
    // L'autre main tient encore l'objet : il reste en main (changement de main), pas de lancer.
    const remaining = this.holdersOf(grabbable);
    if (remaining.length > 0) {
      grabbable.heldBy = remaining[0]!;
      this.applyGrip(grabbable);
      return;
    }
    const { strength, lifted } = this.gripFor(grabbable, 1);
    grabbable.heldBy = null;
    grabbable.body.setGravityScale(1, true);
    if (withThrow && lifted) {
      tmpVec.copy(hand.velocity).multiplyScalar(THROW_BOOST * strength);
      grabbable.body.setLinvel(tmpVec, true);
      tmpVec.copy(hand.angularVelocity);
      if (tmpVec.length() > MAX_THROW_ANGULAR_SPEED) tmpVec.setLength(MAX_THROW_ANGULAR_SPEED);
      grabbable.body.setAngvel(tmpVec, true);
    }
    this.releasing.set(grabbable, this.time + RELEASE_GRACE_SECONDS);
  }

  private storeHeld(hand: Hand, slotIndex: number | null): void {
    const state = this.held.get(hand);
    if (!state?.grabbable.item) return;
    const item = state.grabbable.item;
    for (const holder of this.holdersOf(state.grabbable)) {
      this.held.delete(holder);
      holder.holding = null;
      holder.setHeldAnchor(null);
    }
    state.grabbable.heldBy = null;
    this.registry.remove(state.grabbable);
    // Filet de sécurité : aucun autre exemplaire de cet objet ne reste au sol.
    this.registry.removeItemCopies(item.id);
    this.hooks.store(item, slotIndex);
    hand.pulse(0.45, 70);
    this.sfx.play("store", 0.5);
    log("grab", { action: "store", item: item.kind, slot: slotIndex });
  }
}
