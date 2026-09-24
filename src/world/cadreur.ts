import * as THREE from "three";
import { createCameraStaticBuffer, createCarpetStepBuffer, createCaughtBuffer, createTapeMotorBuffer, createZoomBuffer } from "../assets/audio/threatSounds";
import { queueWarmup } from "../assets/audio/synth";
import { log } from "../debug/debugLog";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { loadCadreur, type CadreurRig } from "./cadreurModel";

/** Profondeur à partir de laquelle le Cadreur peut apparaître (le niveau 0 reste sûr). */
export const CADREUR_MIN_DEPTH = 1;

/** Espacement des jalons de la trace du joueur (m) et longueur maximale gardée. */
const TRAIL_SPACING = 0.5;
const TRAIL_MAX = 400;
/** Il apparaît sur la trace du joueur, entre 14 et 26 m derrière lui (en suivant le chemin). */
const SPAWN_MIN_BEHIND = 14;
const SPAWN_MAX_BEHIND = 26;
/** Si le joueur le distance de plus de 50 m de chemin, il le perd (et reviendra plus tard). */
const LOSE_BEHIND = 50;
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
/** Il garde son allure un instant après avoir quitté le regard (évite les à-coups en bord de champ). */
const OBSERVE_GRACE = 0.25;
const SIGHTING_COOLDOWN = 5;
/** Vitesse sous les yeux du joueur (m/s) : lente, il marche vers toi. */
const WATCHED_SPEED = 0.6;

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
 * le zoom qui se resserre quand on le découvre. S'il atteint le joueur : coupure, réveil un
 * niveau plus bas, les mains vides.
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
  private readonly forward = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  /** Appelé à la main (menu debug) : ignore la profondeur minimale, apparaît plus près. */
  private manual = false;

  constructor(
    scene: THREE.Scene,
    listener: THREE.AudioListener,
    private readonly physics: PhysicsWorld,
  ) {
    this.motor = new THREE.PositionalAudio(listener);
    this.motor.setRefDistance(1.2);
    this.motor.setRolloffFactor(1.8);
    this.motor.setLoop(true);
    this.voice = new THREE.PositionalAudio(listener);
    this.voice.setRefDistance(1.6);
    this.voice.setRolloffFactor(1.4);
    this.caughtAudio = new THREE.Audio(listener);
    queueWarmup(() => (this.motorBuffer = createTapeMotorBuffer(listener.context)));
    queueWarmup(() => (this.caughtBuffer = createCaughtBuffer(listener.context)));
    queueWarmup(() => (this.zoomBuffer = createZoomBuffer(listener.context)));
    queueWarmup(() => (this.staticBuffer = createCameraStaticBuffer(listener.context)));
    queueWarmup(() => {
      for (let i = 0; i < 4; i++) this.steps.push(createCarpetStepBuffer(listener.context));
    });
    loadCadreur()
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

  /** Nouveau niveau (ou nouvelle run) : il disparaît, la trace repart de zéro. */
  reset(depth: number): void {
    this.despawn();
    this.trail.length = 0;
    this.manual = false;
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
    const events: CadreurEvents = { caught: false, sighted: false };
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
        this.play(this.zoomBuffer, 0.9);
        log("cadreur", { action: "sighted", distance: Math.round(this.distanceTo(context.head) * 10) / 10 });
      }
      this.lastObserved = this.elapsed;
      this.observedGrace = OBSERVE_GRACE;
    } else {
      this.observedGrace -= deltaSeconds;
    }
    const watched = this.observedGrace > 0;
    const hunting = Math.min(2.3, 1.25 + context.depth * 0.1);
    this.frozenSeconds = sight.flashlit ? this.frozenSeconds + deltaSeconds : 0;
    const speed = sight.flashlit ? 0 : watched ? WATCHED_SPEED : hunting;
    this.advance(deltaSeconds, speed, watched, context);
    if (sight.flashlit) {
      // Pris dans la lampe : la caméra grésille par salves.
      this.staticTimer -= deltaSeconds;
      if (this.staticTimer <= 0) {
        this.staticTimer = 0.5 + Math.random() * 0.9;
        this.play(this.staticBuffer, 0.7);
      }
    } else this.staticTimer = 0;

    const distance = this.distanceTo(context.head);
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
    if (this.pathBehind() > LOSE_BEHIND) {
      log("cadreur", { action: "lost" });
      this.despawn();
      this.timer = 25 + Math.random() * 25;
      return events;
    }

    const rig = this.rig;
    rig.root.visible = distance < MAX_SEE_DISTANCE + 5;
    // REC : clignote une fois par seconde ; affolée quand la lampe le fige.
    rig.led.visible = this.frozenSeconds > 0 ? Math.random() < 0.5 : this.elapsed % 1 < 0.6;
    return events;
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
      if (this.sight(context).seen) continue;
      this.trailIndex = i;
      this.stalking = true;
      this.observedGrace = 0;
      this.lastObserved = this.elapsed;
      const next = this.trail[i] ?? b;
      this.rig!.root.position.copy(this.position);
      this.rig!.root.rotation.y = Math.atan2(next.x - b.x, next.z - b.z);
      this.rig!.root.visible = true;
      if (this.motorBuffer && this.motor.context.state === "running") {
        this.motor.setBuffer(this.motorBuffer);
        this.motor.setVolume(0.55);
        this.motor.play();
      }
      log("cadreur", { action: "spawn", behind: Math.round(length), depth: context.depth });
      return;
    }
    // Pas encore assez de chemin parcouru (ou tout est sous les yeux) : on réessaie bientôt.
    this.timer = 3;
  }

  private despawn(): void {
    this.stalking = false;
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

  /** Avance au rythme de sa marche : le long de la trace, ou droit sur le joueur s'il est proche et à découvert. */
  private advance(deltaSeconds: number, speed: number, watched: boolean, context: CadreurContext): void {
    const rig = this.rig!;
    const head = context.head;
    const step = rig.update(deltaSeconds, speed, head);
    if (step.footstep) this.play(this.steps[Math.floor(Math.random() * this.steps.length)] ?? null, watched ? 0.8 : 0.55);
    let budget = step.distance;
    if (budget <= 0) return;
    const direct =
      this.distanceTo(head) < DIRECT_CHASE_DISTANCE && this.clearLine(this.tmp.set(this.position.x, 1.2, this.position.z), head.x, 1.2, head.z);
    let headingX = 0;
    let headingZ = 0;
    while (budget > 1e-4) {
      const target: TrailPoint = direct || this.trailIndex >= this.trail.length ? { x: head.x, z: head.z } : this.trail[this.trailIndex]!;
      const dx = target.x - this.position.x;
      const dz = target.z - this.position.z;
      const gap = Math.hypot(dx, dz);
      if (gap > 1e-4) {
        headingX = dx / gap;
        headingZ = dz / gap;
      }
      if (gap <= budget) {
        this.position.x = target.x;
        this.position.z = target.z;
        budget -= gap;
        if (direct || this.trailIndex >= this.trail.length) break;
        this.trailIndex++;
      } else {
        this.position.x += headingX * budget;
        this.position.z += headingZ * budget;
        budget = 0;
      }
    }
    if (direct) this.trailIndex = this.trail.length;
    rig.root.position.copy(this.position);
    if (headingX !== 0 || headingZ !== 0) {
      // Le corps se tourne vers où il marche (la tête-caméra, elle, reste sur le joueur).
      const wanted = Math.atan2(headingX, headingZ);
      const delta = THREE.MathUtils.euclideanModulo(wanted - rig.root.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
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
