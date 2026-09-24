import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { PLAYER_MOVE_SPEED, PLAYER_SPRINT_SPEED } from "../shared/constants";
import type { XrInput } from "./xrInput";

/** Hauteur des yeux visée "debout" : un joueur assis est rehaussé jusqu'ici (fiche : jouable assis). */
const STANDING_EYE_HEIGHT = 1.62;
/** En dessous (hauteur réelle mesurée), on considère le joueur assis. */
const SEATED_THRESHOLD = 1.35;
/** Accroupi : assez bas pour ramasser un objet au sol sans se baisser physiquement. */
const CROUCH_DEPTH = 0.85;
/** Stick droit poussé vers le bas / le haut au-delà : s'accroupir / se relever. */
const CROUCH_STICK_THRESHOLD = 0.7;
const MIN_EYE_HEIGHT = 0.35;
const HEIGHT_LAMBDA = 10;
const CALIBRATION_DELAY_SECONDS = 0.6;

const CROUCH_SPEED = 1.25;
const MOVE_DEADZONE = 0.15;
const SNAP_TURN_ANGLE = THREE.MathUtils.degToRad(45);
const SNAP_TURN_DEADZONE = 0.6;
const SNAP_TURN_RESET_DEADZONE = 0.3;

export const PLAYER_RADIUS = 0.25;
const CAPSULE_HALF_HEIGHT = 0.55;
const CAPSULE_CENTER_Y = CAPSULE_HALF_HEIGHT + PLAYER_RADIUS + 0.05;
const FLAT_PREVIEW_EYE_HEIGHT = 1.6;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Corps du joueur (contrôles type The Walking Dead: Saints & Sinners) :
 * - stick gauche : déplacement relatif au regard, clic : sprint (bascule) ;
 * - stick droit : rotation par crans autour de la tête ; bas : s'accroupir, haut : se
 *   relever, clic : bascule (on peut aussi se baisser physiquement) ;
 * - capsule cinématique Rapier suivant la *tête* (pas l'origine du rig) : on ne traverse
 *   ni les murs ni les objets, même en se penchant physiquement, et on bouscule les objets
 *   dynamiques en marchant dedans (impulsions du contrôleur de personnage) ;
 * - hauteur : un joueur assis est rehaussé à hauteur debout (calibrage au démarrage de la
 *   session, relançable depuis le menu), l'accroupi abaisse le corps virtuel.
 */
export class PlayerController {
  /** Rig déplacé par la locomotion ; `body` porte le décalage vertical (hauteur, accroupi). */
  readonly rig = new THREE.Group();
  readonly body = new THREE.Group();
  readonly headWorld = new THREE.Vector3();

  crouching = false;
  sprinting = false;
  /** Vrai la frame où le rig a été téléporté/tourné (les objets tenus doivent suivre sans balayer le monde). */
  teleported = false;
  movementIntensity = 0;

  private heightOffset = 0;
  private crouchOffset = 0;
  private calibrated = false;
  private presentingSeconds = 0;
  private wasPresenting = false;
  private snapTurnReady = true;
  private crouchStickReady = true;

  private readonly capsuleBody: RAPIER.RigidBody;
  private readonly capsule: RAPIER.Collider;
  private readonly characterController: RAPIER.KinematicCharacterController;
  private readonly capsulePosition = new THREE.Vector3();

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.PerspectiveCamera,
    physics: PhysicsWorld,
  ) {
    this.rig.name = "player-rig";
    this.body.name = "player-body";
    this.rig.add(this.body);
    this.body.add(camera);
    camera.position.set(0, FLAT_PREVIEW_EYE_HEIGHT, 0);

    this.capsuleBody = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, CAPSULE_CENTER_Y, 0));
    this.capsule = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, PLAYER_RADIUS).setCollisionGroups(CollisionGroups.player),
      this.capsuleBody,
    );
    this.characterController = physics.world.createCharacterController(0.02);
    this.characterController.setSlideEnabled(true);
    this.characterController.setApplyImpulsesToDynamicBodies(true);
    this.characterController.setCharacterMass(75);
  }

  /** Hauteur réelle des yeux (espace de référence XR "local-floor"). */
  get realEyeHeight(): number {
    return this.camera.position.y;
  }

  /** Relance la mesure assis/debout (bouton du menu). */
  recalibrate(): void {
    const measured = this.realEyeHeight;
    this.heightOffset = measured < SEATED_THRESHOLD ? STANDING_EYE_HEIGHT - measured : 0;
    this.calibrated = true;
  }

  /** Place le joueur (tête) à une position monde, sans balayage physique (spawn, changement de level). */
  teleport(position: THREE.Vector3): void {
    this.updateHeadWorld();
    this.rig.position.x += position.x - this.headWorld.x;
    this.rig.position.z += position.z - this.headWorld.z;
    this.updateHeadWorld();
    this.capsulePosition.set(this.headWorld.x, CAPSULE_CENTER_Y, this.headWorld.z);
    this.capsuleBody.setTranslation(this.capsulePosition, true);
    this.teleported = true;
  }

  update(deltaSeconds: number, input: XrInput): void {
    this.teleported = false;
    const presenting = this.renderer.xr.isPresenting;
    if (presenting && !this.wasPresenting) {
      this.presentingSeconds = 0;
      this.calibrated = false;
    }
    if (!presenting) this.camera.position.set(0, FLAT_PREVIEW_EYE_HEIGHT, 0);
    this.presentingSeconds += deltaSeconds;
    if (presenting && !this.calibrated && this.presentingSeconds > CALIBRATION_DELAY_SECONDS) this.recalibrate();

    if (input.right.stick.justPressed) this.crouching = !this.crouching;
    // Stick droit bas/haut (fronts) : plus fiable que le clic, facile à rater en jeu.
    const stickY = input.right.stickY;
    const vertical = Math.abs(stickY) > Math.abs(input.right.stickX);
    if (this.crouchStickReady && vertical && stickY > CROUCH_STICK_THRESHOLD) {
      this.crouching = true;
      this.crouchStickReady = false;
    } else if (this.crouchStickReady && vertical && stickY < -CROUCH_STICK_THRESHOLD) {
      this.crouching = false;
      this.crouchStickReady = false;
    } else if (Math.abs(stickY) < SNAP_TURN_RESET_DEADZONE) {
      this.crouchStickReady = true;
    }
    this.updateHeight(deltaSeconds);

    if (presenting && !this.wasPresenting) {
      // Première frame en XR : la tête "saute" à sa vraie position — on y recale la capsule.
      this.updateHeadWorld();
      this.teleport(this.headWorld);
    }
    this.wasPresenting = presenting;

    this.applySnapTurn(input.right.stickX, input.right.stickY);
    this.movementIntensity = this.applyLocomotion(deltaSeconds, input);
  }

  private updateHeight(deltaSeconds: number): void {
    const eye = this.realEyeHeight + this.heightOffset;
    const target = this.crouching ? Math.max(-CROUCH_DEPTH, MIN_EYE_HEIGHT - eye) : 0;
    this.crouchOffset = THREE.MathUtils.damp(this.crouchOffset, Math.min(0, target), HEIGHT_LAMBDA, deltaSeconds);
    this.body.position.y = this.heightOffset + this.crouchOffset;
  }

  private updateHeadWorld(): void {
    this.rig.updateMatrixWorld(true);
    this.camera.getWorldPosition(this.headWorld);
  }

  private applySnapTurn(stickX: number, stickY: number): void {
    // Axe dominant seulement : pousser vers le bas pour s'accroupir ne fait pas tourner.
    if (this.snapTurnReady && Math.abs(stickX) > SNAP_TURN_DEADZONE && Math.abs(stickX) > Math.abs(stickY)) {
      this.updateHeadWorld();
      const angle = -Math.sign(stickX) * SNAP_TURN_ANGLE;
      // Pivot sur la tête : on tourne sur place, même décentré dans son espace de jeu.
      this.scratch.copy(this.rig.position).sub(this.headWorld).applyAxisAngle(UP, angle).add(this.headWorld);
      this.rig.position.x = this.scratch.x;
      this.rig.position.z = this.scratch.z;
      this.rig.rotateY(angle);
      this.snapTurnReady = false;
      this.teleported = true;
    } else if (!this.snapTurnReady && Math.abs(stickX) < SNAP_TURN_RESET_DEADZONE) {
      this.snapTurnReady = true;
    }
  }

  private applyLocomotion(deltaSeconds: number, input: XrInput): number {
    const x = input.left.stickX;
    const y = input.left.stickY;
    const magnitude = Math.min(Math.hypot(x, y), 1);

    if (input.left.stick.justPressed) this.sprinting = !this.sprinting;
    if (magnitude < MOVE_DEADZONE) this.sprinting = false;

    this.updateHeadWorld();
    this.move.set(0, 0, 0);
    if (magnitude >= MOVE_DEADZONE) {
      this.camera.getWorldDirection(this.forward);
      this.forward.y = 0;
      this.forward.normalize();
      this.right.crossVectors(this.forward, UP).normalize();
      this.move.addScaledVector(this.right, x).addScaledVector(this.forward, -y);
      if (this.move.lengthSq() > 1) this.move.normalize().multiplyScalar(magnitude);
      const speed = this.crouching ? CROUCH_SPEED : this.sprinting ? PLAYER_SPRINT_SPEED : PLAYER_MOVE_SPEED;
      this.move.multiplyScalar(speed * deltaSeconds);
    }

    // La capsule suit la tête (déplacement au stick + déplacement physique dans la pièce).
    const current = this.capsuleBody.translation();
    const desiredX = this.headWorld.x + this.move.x;
    const desiredZ = this.headWorld.z + this.move.z;
    this.characterController.computeColliderMovement(
      this.capsule,
      { x: desiredX - current.x, y: 0, z: desiredZ - current.z },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      CollisionGroups.player,
    );
    const corrected = this.characterController.computedMovement();
    this.capsulePosition.set(current.x + corrected.x, CAPSULE_CENTER_Y, current.z + corrected.z);
    this.capsuleBody.setNextKinematicTranslation(this.capsulePosition);

    // Le rig est recalé pour que la tête coïncide avec la capsule (bloquée par les murs).
    this.rig.position.x += this.capsulePosition.x - this.headWorld.x;
    this.rig.position.z += this.capsulePosition.z - this.headWorld.z;
    this.updateHeadWorld();

    return magnitude >= MOVE_DEADZONE ? magnitude : 0;
  }
}
