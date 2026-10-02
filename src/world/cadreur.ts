import * as THREE from "three";
import { createCameraStaticBuffer, createCarpetStepBuffer, createCaughtBuffer, createTapeMotorBuffer, createZoomBuffer } from "../assets/audio/threatSounds";
import { queueWarmup } from "../assets/audio/synth";
import { log } from "../debug/debugLog";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { loadCadreur, type CadreurRig } from "./cadreurModel";
import { tuning } from "../player/difficulty";
import type { NoiseEvent } from "./noise";

/** Profondeur à partir de laquelle le Cadreur peut apparaître (le niveau 0 reste sûr). */
export const CADREUR_MIN_DEPTH = 1;

/** Espacement des jalons de la trace du joueur (m) et longueur maximale gardée. */
const TRAIL_SPACING = 0.5;
const TRAIL_MAX = 400;
/** Il apparaît sur la trace du joueur, entre 14 et 26 m derrière lui (en suivant le chemin). */
const SPAWN_MIN_BEHIND = 14;
const SPAWN_MAX_BEHIND = 26;
/**
 * Si le joueur le distance de plus de 34 m de chemin hors de vue, il ne disparaît pas : il se
 * "recale" sur la trace, un peu plus près et toujours hors de vue (voir `relocate`).
 */
const LOSE_BEHIND = 34;
/** Distance (m) de chemin derrière le joueur où il se recale. */
const RELOCATE_MIN_BEHIND = 15;
const RELOCATE_MAX_BEHIND = 22;
/** Délai minimal (s) entre deux recalages, pour qu'il ne "téléporte" pas en boucle. */
const RELOCATE_COOLDOWN = 8;
/** Au-delà de cette avance (m de chemin), il accélère hors de vue pour rattraper le joueur. */
const CATCH_UP_START = 22;
const CATCH_UP_MAX_FACTOR = 2.2;
const CATCH_DISTANCE = 0.75;
/** Ligne directe vers le joueur quand il est proche et que rien ne les sépare. */
const DIRECT_CHASE_DISTANCE = 9;
/** Cône de vue retenu (demi-angle) : le champ du Quest est d'environ 100°. */
const VIEW_COS = Math.cos(THREE.MathUtils.degToRad(50));
const FLASHLIGHT_COS = Math.cos(THREE.MathUtils.degToRad(24));
const FLASHLIGHT_RANGE = 13;
/** Éclairage minimal pour le distinguer sans lampe (zone éclairée, néons allumés). */
const LIT_THRESHOLD = 0.3;
/** Si près qu'on le devine même dans le noir. */
const TOUCH_VISIBLE_DISTANCE = 1.4;
const MAX_SEE_DISTANCE = 40;
const NEAR_EFFECT_DISTANCE = 8;
/**
 * Embuscade interdite : il n'apparaît jamais dans le champ de vision (lumière ou non — dans le noir
 * d'une coupure, "non éclairé" ne veut pas dire "hors de vue") ni à moins de SPAWN_MIN_DISTANCE m
 * à vol d'oiseau, et il ne fonce jamais sur un joueur qui ne l'a pas vu : à moins de
 * SNEAK_RANGE m il ralentit, et il s'annonce (zoom du caméscope) avant d'être sur lui.
 */
const SPAWN_VIEW_COS = Math.cos(THREE.MathUtils.degToRad(70));
const SPAWN_MIN_DISTANCE = 11;
const SNEAK_RANGE = 8;
const SNEAK_SPEED = 1.1;
const PLAYER_DAMAGE_DISTANCE = 4;
const PLAYER_DAMAGE_MAX_PER_SECOND = 36;
const NEAR_EFFECT_COOLDOWN = 3;
/** Il garde son allure un instant après avoir quitté le regard (évite les à-coups en bord de champ). */
const OBSERVE_GRACE = 0.25;
const SIGHTING_COOLDOWN = 5;
/** Vitesse sous les yeux du joueur (m/s) : lente, il marche vers toi. */
const WATCHED_SPEED = 0.85;
const FLASHLIGHT_SPEED_FACTOR = 0.22;
/** Corps (capsule) : il bute sur les murs et glisse le long, comme le joueur. */
const BODY_RADIUS = 0.3;
const BODY_HALF_HEIGHT = 0.6;
const BODY_CENTER_Y = 1.2;
/** Bloqué (coin, mur régénéré sur la trace) hors de vue : il saute en avant sur la trace. */
const STUCK_SECONDS = 1.2;
const STUCK_SKIP_POINTS = 4;
/** Il entend un bruit jusqu'à `loudness × NOISE_RANGE` mètres (une alarme porte à 40 m). */
const NOISE_RANGE = 40;
/** Arrivé à la source d'un bruit, il fouille un instant avant de reprendre la trace. */
const LURE_SEARCH_SECONDS = 2.5;
const LURE_TIMEOUT_SECONDS = 20;
/** Sous ce seuil, le joueur est trop près : il ne se laisse plus distraire. */
const LURE_IGNORE_DISTANCE = 4;

export interface CadreurContext {
  head: THREE.Vector3;
  camera: THREE.Camera;
  /** Vrai si la lampe éclaire vraiment (allumée, pas en coupure). */
  flashlight: boolean;
  /** Éclairage ambiant [0..1] à une position (zones sombres, coupure, clignotement). */
  lightAt: (x: number, z: number) => number;
  depth: number;
}

export interface CadreurEvents {
  caught: boolean;
  /** Vrai la frame où le joueur le découvre (zoom de la caméra). */
  sighted: boolean;
  /** Vrai périodiquement quand le joueur s'approche assez pour faire décrocher la VHS. */
  nearby: boolean;
  /** Vrai tant que le joueur le fixe à découvert. */
  watched: boolean;
  /** Dégâts retirés au joueur, proportionnels à la proximité du Cadreur. */
  playerDamage: number;
}

interface TrailPoint {
  x: number;
  z: number;
}

/**
 * Le Cadreur : un monstre à tête de caméra qui te filme. Il suit exactement le chemin du
 * joueur (sa trace), apparaît derrière lui au bout d'un couloir déjà parcouru ; quand il est
 * proche et à découvert, il coupe droit vers lui.
 * - Sous les yeux du joueur, il avance lentement, en boitant, par à-coups.
 * - Hors de vue (dos tourné, derrière un mur, dans le noir), il accélère.
 * - Pris dans le faisceau de la lampe, il se fige — la tête-caméra tressaute et grésille.
 *
 * On l'entend avant de le voir : le moteur de sa caméra qui ronronne, ses pas sur la moquette,
 * le zoom qui se resserre quand on le découvre. Sa proximité blesse le joueur ; le contact est
 * fatal et termine la run.
 */
export class Cadreur {
  private rig: CadreurRig | null = null;
  private stalking = false;
  private timer = 0;
  private readonly trail: TrailPoint[] = [];
  private trailIndex = 0;
  private readonly position = new THREE.Vector3();
  private observedGrace = 0;
  private lastObserved = -Infinity;
  private elapsed = 0;
  private frozenSeconds = 0;
  private staticTimer = 0;
  private readonly motor: THREE.PositionalAudio;
  private readonly voice: THREE.PositionalAudio;
  private readonly caughtAudio: THREE.Audio;
  private caughtBuffer: AudioBuffer | null = null;
  private motorBuffer: AudioBuffer | null = null;
  private zoomBuffer: AudioBuffer | null = null;
  private readonly steps: AudioBuffer[] = [];
  private staticBuffer: AudioBuffer | null = null;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  /** Boule de la largeur du corps : "à découvert" = il peut passer, pas seulement voir. */
  private readonly bodyBall = new RAPIER.Ball(BODY_RADIUS);
  private stuckSeconds = 0;
  private readonly forward = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly lastSeenPosition = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  /** Appelé à la main (menu debug) : ignore la profondeur minimale, apparaît plus près. */
  private manual = false;
  /** Bruit vers lequel il marche (leurre), et le temps passé à le chercher. */
  private lure: { x: number; z: number; seconds: number; searching: number } | null = null;
  private lastSeenSeconds = 0;
  /** Annonce sonore (zoom) déjà jouée pour cette approche. */
  private announced = false;
  private lastNearEffect = -Infinity;
  private lastRelocation = -Infinity;
  /** Étourdi (tapette à souris) : figé, la caméra grésille. */
  private stunnedSeconds = 0;
  /** Modèle chargé et ajouté (caché) à la scène — ou échec journalisé : ne rejette jamais. */
  readonly ready: Promise<void>;

  constructor(
    scene: THREE.Scene,
    listener: THREE.AudioListener,
    private readonly physics: PhysicsWorld,
  ) {
    this.motor = new THREE.PositionalAudio(listener);
    this.motor.setRefDistance(3.5);
    this.motor.setRolloffFactor(1.2);
    this.motor.setLoop(true);
    this.voice = new THREE.PositionalAudio(listener);
    this.voice.setRefDistance(1.6);
    this.voice.setRolloffFactor(1.4);
    this.caughtAudio = new THREE.Audio(listener);
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -20, 0));
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(BODY_HALF_HEIGHT, BODY_RADIUS).setCollisionGroups(CollisionGroups.cadreur),
      this.body,
    );
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.setSlideEnabled(true);
    // Enjambe les petits objets posés au sol (canette, jouet...) ; les meubles, eux, le bloquent.
    this.controller.enableAutostep(0.2, 0.05, true);
    queueWarmup(() => (this.motorBuffer = createTapeMotorBuffer(listener.context)));
    queueWarmup(() => (this.caughtBuffer = createCaughtBuffer(listener.context)));
    queueWarmup(() => (this.zoomBuffer = createZoomBuffer(listener.context)));
    queueWarmup(() => (this.staticBuffer = createCameraStaticBuffer(listener.context)));
    queueWarmup(() => {
      for (let i = 0; i < 4; i++) this.steps.push(createCarpetStepBuffer(listener.context));
    });
    this.ready = loadCadreur()
      .then((rig) => {
        this.rig = rig;
        rig.root.visible = false;
        rig.root.add(this.motor, this.voice);
        this.motor.position.set(0, 1.6, 0.2);
        this.voice.position.set(0, 1.2, 0);
        scene.add(rig.root);
      })
      .catch((error: unknown) => log("error", { where: "cadreur", error: String(error) }));
    this.reset(0);
  }

  get present(): boolean {
    return this.stalking;
  }

  /** Position au sol (x, z) quand il est là, sinon null. */
  get worldPosition(): THREE.Vector3 | null {
    return this.stalking ? this.position : null;
  }

  get renderObject(): THREE.Object3D | null {
    return this.rig?.root ?? null;
  }

  /** Position réelle de l'objectif (LED "REC", son œil), quand il est là — pas une approximation. */
  get eyeWorld(): THREE.Vector3 | null {
    if (!this.stalking || !this.rig) return null;
    return this.rig.led.getWorldPosition(new THREE.Vector3());
  }

  /**
   * Un bruit : absent, un bruit fort (ou proche de là où il rôde) le fait venir plus tôt ;
   * présent, il va voir d'où ça vient — sauf s'il tient déjà le joueur de près.
   */
  hear(event: NoiseEvent, depth: number): void {
    if (event.loudness <= 0 || (depth < CADREUR_MIN_DEPTH && !this.manual)) return;
    if (!this.stalking) {
      const timer = Math.min(this.timer, 2 + (1 - event.loudness) * 25);
      if (timer < this.timer - 1) log("cadreur", { action: "called-by-noise", loudness: Math.round(event.loudness * 100) / 100, in: Math.round(timer) });
      this.timer = timer;
      return;
    }
    const distance = Math.hypot(event.x - this.position.x, event.z - this.position.z);
    if (distance > event.loudness * NOISE_RANGE) return;
    this.lure = { x: event.x, z: event.z, seconds: 0, searching: 0 };
    log("cadreur", { action: "heard", distance: Math.round(distance), loudness: Math.round(event.loudness * 100) / 100 });
  }

  /** Tapette à souris : il reste figé quelques secondes. */
  stun(seconds: number): void {
    if (!this.stalking) return;
    log("cadreur", { action: "stunned", seconds });
    this.stunnedSeconds = Math.max(this.stunnedSeconds, seconds);
    this.play(this.staticBuffer, 0.4);
  }

  /** Nouveau niveau (ou nouvelle run) : il disparaît, la trace repart de zéro. */
  reset(depth: number): void {
    this.despawn();
    this.trail.length = 0;
    this.manual = false;
    this.lastRelocation = -Infinity;
    this.timer = Math.max(35, 70 + Math.random() * 50 - depth * 4);
  }

  /** Menu debug : le fait venir tout de suite (sur la trace, ≥ 6 m derrière), ou le renvoie. */
  toggle(): void {
    if (this.stalking) {
      log("cadreur", { action: "dismissed" });
      this.despawn();
      this.manual = false;
      this.timer = 60;
      return;
    }
    this.manual = true;
    this.timer = 0;
  }

  /** La coupure l'appelle : s'il n'est pas déjà là, il arrive avec le noir. */
  summon(): void {
    if (!this.stalking) this.timer = Math.min(this.timer, 2);
  }

  update(deltaSeconds: number, context: CadreurContext): CadreurEvents {
    const events: CadreurEvents = { caught: false, sighted: false, nearby: false, watched: false, playerDamage: 0 };
    this.elapsed += deltaSeconds;
    this.recordTrail(context.head);
    if (!this.rig || (context.depth < CADREUR_MIN_DEPTH && !this.manual)) return events;

    if (!this.stalking) {
      this.timer -= deltaSeconds;
      if (this.timer <= 0) this.trySpawn(context);
      return events;
    }

    context.camera.getWorldDirection(this.forward);
    context.camera.getWorldPosition(this.cameraPosition);
    const sight = this.sight(context);
    if (sight.seen) {
      if (this.elapsed - this.lastObserved > SIGHTING_COOLDOWN) {
        events.sighted = true;
        this.play(this.zoomBuffer, 0.45);
        log("cadreur", { action: "sighted", distance: Math.round(this.distanceTo(context.head) * 10) / 10 });
      }
      this.lastObserved = this.elapsed;
      this.observedGrace = OBSERVE_GRACE;
      this.lastSeenPosition.set(context.head.x, 0, context.head.z);
      this.lastSeenSeconds = 3.5;
    } else {
      this.observedGrace -= deltaSeconds;
      this.lastSeenSeconds = Math.max(0, this.lastSeenSeconds - deltaSeconds);
    }
    const watched = this.observedGrace > 0;
    const hunting = Math.min(3, 1.45 + context.depth * 0.12);
    this.stunnedSeconds = Math.max(0, this.stunnedSeconds - deltaSeconds);
    const stunned = this.stunnedSeconds > 0;
    this.frozenSeconds = sight.flashlit || stunned ? this.frozenSeconds + deltaSeconds : 0;
    if (!sight.seen && this.lastSeenSeconds > 0 && !this.lure && !stunned) {
      this.lure = { x: this.lastSeenPosition.x, z: this.lastSeenPosition.z, seconds: 0, searching: 0 };
    }
    this.updateLure(deltaSeconds, context.head);
    const searching = this.lure !== null && this.lure.searching > 0;
    // Hors de vue et loin derrière : il force l'allure (jamais sous les yeux du joueur).
    const gap = this.pathBehind();
    const catchUp = watched ? 1 : THREE.MathUtils.clamp(1 + (gap - CATCH_UP_START) / 14, 1, CATCH_UP_MAX_FACTOR);
    const speed = stunned || searching ? 0 : watched ? WATCHED_SPEED * (sight.flashlit ? FLASHLIGHT_SPEED_FACTOR : 1) : hunting * catchUp * tuning().cadreurSpeed;
    // Jamais d'embuscade : près du joueur qui ne l'a pas vu, il ralentit, et s'annonce une fois.
    const closeBy = this.distanceTo(context.head) < SNEAK_RANGE;
    if (closeBy && !this.announced) {
      this.announced = true;
      this.play(this.zoomBuffer, 0.5);
    } else if (!closeBy && this.distanceTo(context.head) > SNEAK_RANGE + 6) this.announced = false;
    this.advance(deltaSeconds, closeBy && !stunned && !searching ? Math.min(speed, SNEAK_SPEED) : speed, watched, context);
    if (sight.flashlit) {
      // Pris dans la lampe : la caméra grésille par salves.
      this.staticTimer -= deltaSeconds;
      if (this.staticTimer <= 0) {
        this.staticTimer = 0.5 + Math.random() * 0.9;
        this.play(this.staticBuffer, 0.35);
      }
    } else this.staticTimer = 0;

    const distance = this.distanceTo(context.head);
    events.nearby = distance < NEAR_EFFECT_DISTANCE && this.elapsed - this.lastNearEffect > NEAR_EFFECT_COOLDOWN;
    if (events.nearby) this.lastNearEffect = this.elapsed;
    const proximity = THREE.MathUtils.clamp(1 - distance / PLAYER_DAMAGE_DISTANCE, 0, 1);
    events.playerDamage = PLAYER_DAMAGE_MAX_PER_SECOND * tuning().cadreurDamage * proximity * deltaSeconds;
    events.watched = sight.seen;
    if (distance < CATCH_DISTANCE) {
      events.caught = true;
      log("cadreur", { action: "caught" });
      if (this.caughtBuffer && this.caughtAudio.context.state === "running") {
        if (this.caughtAudio.isPlaying) this.caughtAudio.stop();
        this.caughtAudio.setBuffer(this.caughtBuffer);
        this.caughtAudio.setVolume(0.8);
        this.caughtAudio.play();
      }
      this.despawn();
      this.trail.length = 0;
      this.timer = 60 + Math.random() * 40;
      return events;
    }
    // Distancé : il ne renonce jamais, il se recale sur la trace (hors de vue) pour reprendre la chasse.
    if (gap > LOSE_BEHIND && !sight.seen && !this.lure && this.elapsed - this.lastRelocation > RELOCATE_COOLDOWN) this.relocate(context);

    const rig = this.rig;
    rig.root.visible = distance < MAX_SEE_DISTANCE + 5 || sight.seen;
    // REC : clignote une fois par seconde ; affolée quand la lampe le fige.
    rig.led.visible = this.frozenSeconds > 0 ? Math.random() < 0.5 : this.elapsed % 1 < 0.6;
    return events;
  }

  /** Leurre : arrivé à la source du bruit, il fouille, puis reprend la trace du joueur. */
  private updateLure(deltaSeconds: number, head: THREE.Vector3): void {
    const lure = this.lure;
    if (!lure) return;
    lure.seconds += deltaSeconds;
    const arrived = Math.hypot(lure.x - this.position.x, lure.z - this.position.z) < 0.8;
    if (arrived) lure.searching += deltaSeconds;
    if (lure.searching > LURE_SEARCH_SECONDS || lure.seconds > LURE_TIMEOUT_SECONDS || this.distanceTo(head) < LURE_IGNORE_DISTANCE) {
      this.lure = null;
      this.syncTrailIndex();
    }
  }

  private distanceTo(head: THREE.Vector3): number {
    return Math.hypot(head.x - this.position.x, head.z - this.position.z);
  }

  private recordTrail(head: THREE.Vector3): void {
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(head.x - last.x, head.z - last.z) < TRAIL_SPACING) return;
    this.trail.push({ x: head.x, z: head.z });
    if (this.trail.length > TRAIL_MAX) {
      this.trail.shift();
      this.trailIndex = Math.max(0, this.trailIndex - 1);
    }
  }

  /** Longueur de chemin (m) entre lui et le joueur, le long de la trace. */
  private pathBehind(): number {
    let length = 0;
    let previous: TrailPoint = { x: this.position.x, z: this.position.z };
    for (let i = this.trailIndex; i < this.trail.length; i++) {
      const point = this.trail[i]!;
      length += Math.hypot(point.x - previous.x, point.z - previous.z);
      previous = point;
    }
    return length;
  }

  private trySpawn(context: CadreurContext): void {
    context.camera.getWorldDirection(this.forward);
    context.camera.getWorldPosition(this.cameraPosition);
    const minBehind = this.manual ? 6 : SPAWN_MIN_BEHIND;
    const wanted = minBehind + Math.random() * (SPAWN_MAX_BEHIND - minBehind);
    let length = 0;
    for (let i = this.trail.length - 1; i > 0; i--) {
      const a = this.trail[i]!;
      const b = this.trail[i - 1]!;
      length += Math.hypot(a.x - b.x, a.z - b.z);
      if (length < wanted) continue;
      if (length > SPAWN_MAX_BEHIND + 10) break;
      this.position.set(b.x, 0, b.z);
      // Jamais sous les yeux du joueur : il apparaît hors de vue, derrière un angle.
      if (this.sight(context).seen || this.inAmbushZone()) continue;
      this.trailIndex = i;
      this.stalking = true;
      this.lastNearEffect = -Infinity;
      this.placeBody();
      this.observedGrace = 0;
      this.lastObserved = this.elapsed;
      const next = this.trail[i] ?? b;
      this.rig!.root.position.copy(this.position);
      this.rig!.root.rotation.y = Math.atan2(next.x - b.x, next.z - b.z);
      this.rig!.root.visible = true;
      if (this.motorBuffer && this.motor.context.state === "running") {
        this.motor.setBuffer(this.motorBuffer);
        this.motor.setVolume(0.28);
        this.motor.play();
      }
      log("cadreur", { action: "spawn", behind: Math.round(length), depth: context.depth });
      return;
    }
    // Pas encore assez de chemin parcouru (ou tout est sous les yeux) : on réessaie bientôt.
    this.timer = 3;
  }

  /**
   * Distancé de plus de `LOSE_BEHIND` m : se replace plus près sur la trace du joueur, hors de
   * son champ de vision. Sans emplacement valide (tout est sous ses yeux), il réessaiera au
   * prochain tour — il ne disparaît jamais de lui-même.
   */
  private relocate(context: CadreurContext): void {
    this.lastRelocation = this.elapsed;
    context.camera.getWorldDirection(this.forward);
    context.camera.getWorldPosition(this.cameraPosition);
    const saved = this.position.clone();
    const wanted = RELOCATE_MIN_BEHIND + Math.random() * (RELOCATE_MAX_BEHIND - RELOCATE_MIN_BEHIND);
    let length = 0;
    for (let i = this.trail.length - 1; i > 0; i--) {
      const a = this.trail[i]!;
      const b = this.trail[i - 1]!;
      length += Math.hypot(a.x - b.x, a.z - b.z);
      if (length < wanted) continue;
      if (length > RELOCATE_MAX_BEHIND + 10) break;
      this.position.set(b.x, 0, b.z);
      if (this.sight(context).seen || this.inAmbushZone()) continue;
      this.trailIndex = i;
      this.lastSeenSeconds = 0;
      this.stuckSeconds = 0;
      this.placeBody();
      this.rig!.root.position.copy(this.position);
      const next = this.trail[i] ?? b;
      this.rig!.root.rotation.y = Math.atan2(next.x - b.x, next.z - b.z);
      log("cadreur", { action: "relocated", behind: Math.round(length) });
      return;
    }
    this.position.copy(saved);
    log("cadreur", { action: "relocate-failed" });
  }

  private despawn(): void {
    this.stalking = false;
    this.announced = false;
    this.lure = null;
    this.stunnedSeconds = 0;
    this.body.setTranslation({ x: 0, y: -20, z: 0 }, true);
    if (this.rig) this.rig.root.visible = false;
    if (this.motor.isPlaying) this.motor.stop();
  }

  /**
   * `seen` : dans le champ, à découvert (pas derrière un mur) et éclairé (néons ou lampe).
   * `flashlit` : pris dans le faisceau de la lampe (il se fige).
   */
  private sight(context: CadreurContext): { seen: boolean; flashlit: boolean } {
    const none = { seen: false, flashlit: false };
    this.tmp.set(this.position.x, 1.3, this.position.z).sub(this.cameraPosition);
    const distance = this.tmp.length();
    if (distance > MAX_SEE_DISTANCE) return none;
    const facing = this.tmp.normalize().dot(this.forward);
    if (facing < VIEW_COS) return none;
    const flashlit = context.flashlight && facing > FLASHLIGHT_COS && distance < FLASHLIGHT_RANGE;
    const lit = flashlit || context.lightAt(this.position.x, this.position.z) > LIT_THRESHOLD || distance < TOUCH_VISIBLE_DISTANCE;
    if (!lit) return none;
    const clear =
      this.clearLine(this.cameraPosition, this.position.x, 1.3, this.position.z) || this.clearLine(this.cameraPosition, this.position.x, 1.9, this.position.z);
    return clear ? { seen: true, flashlit } : none;
  }

  /** Vrai si `position` est dans le champ du joueur (même dans le noir) ou trop près de lui : interdit pour apparaître. */
  private inAmbushZone(): boolean {
    this.tmp.set(this.position.x, 1.3, this.position.z).sub(this.cameraPosition);
    const distance = Math.hypot(this.tmp.x, this.tmp.z);
    if (distance < SPAWN_MIN_DISTANCE) return true;
    return this.tmp.normalize().dot(this.forward) > SPAWN_VIEW_COS;
  }

  private clearLine(from: THREE.Vector3, x: number, y: number, z: number): boolean {
    const dx = x - from.x;
    const dy = y - from.y;
    const dz = z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.01) return true;
    this.ray.origin = { x: from.x, y: from.y, z: from.z };
    this.ray.dir = { x: dx / length, y: dy / length, z: dz / length };
    return this.physics.world.castRay(this.ray, length, true, undefined, CollisionGroups.queryWalls) === null;
  }

  /** Recale le corps physique sur `position` (apparition, saut sur la trace). */
  private placeBody(): void {
    this.body.setTranslation({ x: this.position.x, y: BODY_CENTER_Y, z: this.position.z }, true);
    this.stuckSeconds = 0;
  }

  /** Passage libre pour tout son corps (pas seulement un regard) entre deux points, à mi-hauteur. */
  private clearPath(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const length = Math.hypot(dx, dz);
    if (length < 0.01) return true;
    const hit = this.physics.world.castShape(
      { x: fromX, y: BODY_CENTER_Y, z: fromZ },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dx / length, y: 0, z: dz / length },
      this.bodyBall,
      0,
      length,
      true,
      undefined,
      CollisionGroups.queryObstacles,
    );
    return hit === null;
  }

  /** Pendant la course directe, garde son repère sur la trace : s'il te perd de vue, il la reprend d'ici. */
  private syncTrailIndex(): void {
    let best = this.trailIndex;
    let bestDistance = Infinity;
    for (let i = this.trailIndex; i < this.trail.length; i++) {
      const point = this.trail[i]!;
      const distance = Math.hypot(point.x - this.position.x, point.z - this.position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    this.trailIndex = best;
  }

  /**
   * Avance au rythme de sa marche : le long de la trace, ou droit sur le joueur s'il est proche
   * et que le passage est libre pour tout son corps. Le déplacement passe par un contrôleur de
   * personnage : il glisse le long des murs au lieu de les traverser.
   */
  private advance(deltaSeconds: number, speed: number, watched: boolean, context: CadreurContext): void {
    const rig = this.rig!;
    const head = context.head;
    const step = rig.update(deltaSeconds, speed, head);
    if (step.footstep) this.play(this.steps[Math.floor(Math.random() * this.steps.length)] ?? null, watched ? 0.45 : 0.3);
    let budget = step.distance;
    if (budget <= 0) return;
    const lure = this.lure;
    const direct = !lure && this.distanceTo(head) < DIRECT_CHASE_DISTANCE && this.clearPath(this.position.x, this.position.z, head.x, head.z);
    // Point visé à la fin de ce pas, en suivant la trace (ou droit sur le joueur).
    let targetX = this.position.x;
    let targetZ = this.position.z;
    let index = this.trailIndex;
    let headingX = 0;
    let headingZ = 0;
    while (budget > 1e-4) {
      const target: TrailPoint = lure ? { x: lure.x, z: lure.z } : direct || index >= this.trail.length ? { x: head.x, z: head.z } : this.trail[index]!;
      const dx = target.x - targetX;
      const dz = target.z - targetZ;
      const gap = Math.hypot(dx, dz);
      if (gap > 1e-4) {
        headingX = dx / gap;
        headingZ = dz / gap;
      }
      if (gap <= budget) {
        targetX = target.x;
        targetZ = target.z;
        budget -= gap;
        if (lure || direct || index >= this.trail.length) break;
        index++;
      } else {
        targetX += headingX * budget;
        targetZ += headingZ * budget;
        budget = 0;
      }
    }

    const current = this.collider.translation();
    const wantedX = targetX - current.x;
    const wantedZ = targetZ - current.z;
    this.controller.computeColliderMovement(this.collider, { x: wantedX, y: 0, z: wantedZ }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, CollisionGroups.queryObstacles);
    const moved = this.controller.computedMovement();
    this.position.set(current.x + moved.x, 0, current.z + moved.z);
    this.body.setNextKinematicTranslation({ x: this.position.x, y: BODY_CENTER_Y, z: this.position.z });

    // On n'avance sur la trace que jusqu'au point réellement atteint (bloqué : il la reprend d'où il est).
    if (lure) {
      // Bloqué en allant vers le bruit : il abandonne et reprend la trace.
      if (Math.hypot(moved.x, moved.z) < Math.hypot(wantedX, wantedZ) * 0.3) lure.seconds += deltaSeconds * 4;
    } else if (!direct && Math.hypot(this.position.x - targetX, this.position.z - targetZ) < 0.2) this.trailIndex = index;
    else this.syncTrailIndex();

    // Coincé contre un mur (coin serré, couloir régénéré sur sa trace) : hors de vue, il
    // "saute" un peu plus loin sur la trace — il ne bouge jamais ainsi quand on le regarde.
    const wanted = Math.hypot(wantedX, wantedZ);
    this.stuckSeconds = wanted > 1e-3 && Math.hypot(moved.x, moved.z) < wanted * 0.3 ? this.stuckSeconds + deltaSeconds : 0;
    if (this.stuckSeconds > STUCK_SECONDS && !watched && this.trailIndex < this.trail.length) {
      this.trailIndex = Math.min(this.trail.length - 1, this.trailIndex + STUCK_SKIP_POINTS);
      const point = this.trail[this.trailIndex]!;
      this.position.set(point.x, 0, point.z);
      this.placeBody();
      log("cadreur", { action: "unstuck" });
    }

    rig.root.position.copy(this.position);
    if (headingX !== 0 || headingZ !== 0) {
      // Le corps se tourne vers où il marche (la tête-caméra, elle, reste sur le joueur).
      const wantedAngle = Math.atan2(headingX, headingZ);
      const delta = THREE.MathUtils.euclideanModulo(wantedAngle - rig.root.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
      rig.root.rotation.y += delta * Math.min(1, deltaSeconds * 6);
    }
  }

  private play(buffer: AudioBuffer | null, volume: number): void {
    if (!buffer || this.voice.context.state !== "running") return;
    if (this.voice.isPlaying) this.voice.stop();
    this.voice.setBuffer(buffer);
    this.voice.setVolume(volume);
    this.voice.play();
  }
}
