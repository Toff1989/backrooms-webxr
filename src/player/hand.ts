import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import type { Grabbable } from "../world/grabbable";
import { pulseGamepad } from "./haptics";
import { HandModel } from "./handModel";
import type { HandInput } from "./xrInput";

/** Point de saisie devant la paume, dans l'espace grip (paume vers -X main droite, +X main gauche). */
const PALM_OFFSET = { right: new THREE.Vector3(-0.035, -0.005, -0.01), left: new THREE.Vector3(0.035, -0.005, -0.01) };
const HAND_COLLIDER_RADIUS = 0.045;
/** Main ouverte : ne bouscule les objets qu'au-delà de cette vitesse (sinon on renverse ce qu'on veut attraper). */
const SWIPE_SPEED = 1.1;
const TELEPORT_JUMP = 0.35;
const HISTORY_SECONDS = 0.09;
/** Flexion des doigts au repos (main posée sur la manette, sans appuyer). */
const REST_GRIP = 0.45;
const REST_INDEX = 0.25;

interface PoseSample {
  time: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/**
 * Main virtuelle (gant) : suit l'espace grip de la manette, anime les doigts selon grip et
 * gâchette, estime vitesse linéaire/angulaire (pour lancer les objets) et porte un petit
 * collider cinématique — poing fermé ou geste vif, la main bouscule les objets.
 */
export class Hand {
  readonly palm = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();
  readonly aimOrigin = new THREE.Vector3();
  readonly aimDirection = new THREE.Vector3();
  /** Objet tenu (géré par `GrabSystem`). */
  holding: Grabbable | null = null;

  private model: HandModel | null = null;
  private attachedTo: THREE.Object3D | null = null;
  private readonly history: PoseSample[] = [];
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly lastBodyPosition = new THREE.Vector3();
  private readonly gripPosition = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly deltaQuat = new THREE.Quaternion();

  constructor(
    readonly input: HandInput,
    physics: PhysicsWorld,
  ) {
    HandModel.load(input.handedness)
      .then((model) => {
        this.model = model;
      })
      .catch(() => {});

    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -10, 0));
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.ball(HAND_COLLIDER_RADIUS).setCollisionGroups(CollisionGroups.hand).setEnabled(false),
      this.body,
    );
  }

  get tracked(): boolean {
    return this.input.connected;
  }

  get speed(): number {
    return this.velocity.length();
  }

  pulse(intensity: number, durationMs: number): void {
    pulseGamepad(this.input.inputSource?.gamepad, intensity, durationMs);
  }

  getIndexTipWorld(target: THREE.Vector3): THREE.Vector3 | null {
    return this.model ? this.model.getIndexTipWorld(target) : null;
  }

  /** À appeler après la mise à jour du rig (matrices monde à jour). */
  update(time: number): void {
    const grip = this.input.grip;
    const model = this.model;
    if (model && grip && this.attachedTo !== grip) {
      grip.add(model.root);
      this.attachedTo = grip;
    }
    if (!grip || !this.tracked) {
      this.history.length = 0;
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      return;
    }

    grip.getWorldPosition(this.gripPosition);
    grip.getWorldQuaternion(this.quaternion);
    this.palm.copy(PALM_OFFSET[this.input.handedness]).applyQuaternion(this.quaternion).add(this.gripPosition);

    const ray = this.input.targetRay;
    if (ray) {
      ray.getWorldPosition(this.aimOrigin);
      ray.getWorldDirection(this.aimDirection).negate();
    }

    if (model) {
      // Au repos, la main enserre déjà la manette (doigts à demi repliés) : une main grande
      // ouverte, doigts tendus, paraissait tordue alors qu'on tient physiquement la manette.
      const holding = this.holding !== null;
      const grip = holding ? 1 : REST_GRIP + (1 - REST_GRIP) * this.input.squeeze.value;
      const index = holding ? 1 : REST_INDEX + (1 - REST_INDEX) * this.input.trigger.value;
      const thumb = holding ? 0.9 : Math.max(this.input.thumbDown ? 0.85 : 0.45, grip * 0.6);
      model.setPose(index, grip, thumb);
    }

    this.recordVelocity(time);
  }

  /** Oublie l'historique de vitesse (téléportation / rotation du rig : ce n'est pas un geste de lancer). */
  resetMotion(): void {
    this.history.length = 0;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
  }

  /** Cible du corps cinématique, avant chaque pas de simulation. */
  applyKinematicTarget(): void {
    const active =
      this.tracked && this.holding === null && (this.input.squeeze.value > 0.6 || this.speed > SWIPE_SPEED);
    if (this.collider.isEnabled() !== active) this.collider.setEnabled(active);
    if (!this.tracked) return;

    if (this.scratch.subVectors(this.palm, this.lastBodyPosition).length() > TELEPORT_JUMP) {
      this.body.setTranslation(this.palm, false);
    } else {
      this.body.setNextKinematicTranslation(this.palm);
    }
    this.lastBodyPosition.copy(this.palm);
  }

  private recordVelocity(time: number): void {
    const history = this.history;
    const last = history[history.length - 1];
    if (last && time - last.time < 1e-4) return;
    history.push({ time, position: this.palm.clone(), quaternion: this.quaternion.clone() });
    while (history.length > 2 && time - history[0]!.time > HISTORY_SECONDS) history.shift();

    const first = history[0]!;
    const span = time - first.time;
    if (history.length < 2 || span <= 0) {
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      return;
    }
    this.velocity.subVectors(this.palm, first.position).divideScalar(span);

    this.deltaQuat.copy(first.quaternion).invert().premultiply(this.quaternion);
    if (this.deltaQuat.w < 0) this.deltaQuat.set(-this.deltaQuat.x, -this.deltaQuat.y, -this.deltaQuat.z, -this.deltaQuat.w);
    const angle = 2 * Math.acos(Math.min(1, this.deltaQuat.w));
    const sinHalf = Math.sqrt(Math.max(0, 1 - this.deltaQuat.w * this.deltaQuat.w));
    if (sinHalf < 1e-5) this.angularVelocity.set(0, 0, 0);
    else this.angularVelocity.set(this.deltaQuat.x, this.deltaQuat.y, this.deltaQuat.z).divideScalar(sinHalf).multiplyScalar(angle / span);
  }
}
