import * as THREE from "three";
import { createBreakerBuffer, createTubeDeathBuffer, createTubeStartBuffer, createWindDownBuffer } from "../assets/audio/threatSounds";
import { queueWarmup } from "../assets/audio/synth";
import { log } from "../debug/debugLog";
import { blackoutLightAt, FRONT_WIDTH, type BlackoutState } from "./blackoutField";
import { setBlackoutUniforms } from "./vhsMaterial";

type Phase = "idle" | "warning" | "wave" | "dark" | "restore";

/** Profondeur à partir de laquelle la coupure peut survenir. */
export const BLACKOUT_MIN_DEPTH = 2;
const WARNING_SECONDS = 3.5;
/** Vitesse du front (m/s) : plus rapide qu'un sprint, on ne le distance pas. */
const WAVE_SPEED = 7;
const ORIGIN_MIN_DISTANCE = 24;
const ORIGIN_MAX_DISTANCE = 34;
/** Le front continue après le joueur jusqu'à couvrir tout ce qu'il voit (brouillard ~30 m). */
const WAVE_OVERSHOOT = 40;
const DARK_MIN_SECONDS = 22;
const DARK_MAX_SECONDS = 32;
const RESTORE_SECONDS = 8;

export interface BlackoutEvents {
  /** Vrai la frame où le noir atteint le joueur. */
  reachedPlayer: boolean;
  /** Vrai la frame où la coupure commence (disjoncteur). */
  started: boolean;
}

/**
 * La Coupure : le bourdonnement s'étrangle, les néons grésillent, puis un disjoncteur saute
 * au loin et le courant meurt en vague — secteur par secteur, les néons agonisent et
 * s'éteignent vers le joueur. Noir complet pendant ~30 s (seule la lampe éclaire), puis les
 * tubes redémarrent un à un, starters qui claquent, par zones.
 *
 * Aucun modèle : tout passe par le champ `blackoutField.ts` (même calcul sur CPU et GPU),
 * les néons du plafond et l'éclairage ambiant des surfaces.
 */
export class Blackout {
  private phase: Phase = "idle";
  private phaseSeconds = 0;
  private darkSeconds = 0;
  private nextEvent = 0;
  private readonly state: BlackoutState = { on: false, originX: 0, originZ: 0, radius: 0, restore: 0 };
  private targetRadius = 0;
  private playerDark = false;
  private readonly breakerVoice: THREE.PositionalAudio;
  private readonly tubeVoices: THREE.PositionalAudio[] = [];
  private readonly windDown: THREE.Audio;
  private nextTubeVoice = 0;
  private tubeTimer = 0;
  private breaker: AudioBuffer | null = null;
  private windDownBuffer: AudioBuffer | null = null;
  private readonly deaths: AudioBuffer[] = [];
  private readonly starts: AudioBuffer[] = [];
  private readonly tmp = new THREE.Vector3();
  /** Délai du premier déclenchement (debug `?force=coupure` : quelques secondes). */
  forced = false;

  constructor(scene: THREE.Scene, listener: THREE.AudioListener) {
    this.breakerVoice = new THREE.PositionalAudio(listener);
    this.breakerVoice.setRefDistance(10);
    this.breakerVoice.setRolloffFactor(0.6);
    scene.add(this.breakerVoice);
    for (let i = 0; i < 3; i++) {
      const voice = new THREE.PositionalAudio(listener);
      voice.setRefDistance(2.5);
      voice.setRolloffFactor(1.2);
      scene.add(voice);
      this.tubeVoices.push(voice);
    }
    this.windDown = new THREE.Audio(listener);
    queueWarmup(() => (this.breaker = createBreakerBuffer(listener.context)));
    queueWarmup(() => (this.windDownBuffer = createWindDownBuffer(listener.context)));
    queueWarmup(() => {
      for (let i = 0; i < 3; i++) this.deaths.push(createTubeDeathBuffer(listener.context));
    });
    queueWarmup(() => {
      for (let i = 0; i < 3; i++) this.starts.push(createTubeStartBuffer(listener.context));
    });
    this.reset(0);
  }

  get active(): boolean {
    return this.phase !== "idle";
  }

  /** Vrai pendant l'avertissement (néons qui s'étranglent) : l'atmosphère fait grésiller. */
  get warning(): boolean {
    return this.phase === "warning";
  }

  /** Nouveau niveau : tout est rallumé, prochaine coupure dans quelques minutes. */
  reset(depth: number): void {
    this.phase = "idle";
    this.state.on = false;
    this.playerDark = false;
    this.nextEvent = this.forced ? 12 : 100 + Math.random() * 90 - Math.min(40, depth * 5);
    this.apply();
  }

  /** Lumière [0..1] à une position (1 hors coupure). */
  lightAt(x: number, z: number): number {
    return blackoutLightAt(this.state, x, z).light;
  }

  update(deltaSeconds: number, player: THREE.Vector3, depth: number): BlackoutEvents {
    const events: BlackoutEvents = { reachedPlayer: false, started: false };
    if (depth < BLACKOUT_MIN_DEPTH && !this.forced) return events;
    this.phaseSeconds += deltaSeconds;

    switch (this.phase) {
      case "idle":
        this.nextEvent -= deltaSeconds;
        if (this.nextEvent <= 0) this.enter("warning");
        break;
      case "warning":
        if (this.phaseSeconds >= WARNING_SECONDS) {
          this.start(player);
          events.started = true;
        }
        break;
      case "wave":
        this.state.radius = Math.min(this.targetRadius, this.state.radius + WAVE_SPEED * deltaSeconds);
        this.playDyingTubes(deltaSeconds, player);
        if (this.state.radius >= this.targetRadius) this.enter("dark");
        break;
      case "dark":
        if (this.phaseSeconds >= this.darkSeconds) this.enter("restore");
        break;
      case "restore":
        this.state.restore = Math.min(1, this.phaseSeconds / RESTORE_SECONDS);
        this.playRestartingTubes(deltaSeconds, player);
        if (this.state.restore >= 1) {
          log("blackout", { action: "end" });
          this.reset(depth);
        }
        break;
    }

    const dark = this.state.on && this.lightAt(player.x, player.z) < 0.5;
    if (dark && !this.playerDark) {
      events.reachedPlayer = true;
      if (this.windDownBuffer && this.windDown.context.state === "running") {
        if (this.windDown.isPlaying) this.windDown.stop();
        this.windDown.setBuffer(this.windDownBuffer);
        this.windDown.setVolume(0.35);
        this.windDown.play();
      }
    }
    this.playerDark = dark;
    this.apply();
    return events;
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.phaseSeconds = 0;
    if (phase === "dark") this.darkSeconds = DARK_MIN_SECONDS + Math.random() * (DARK_MAX_SECONDS - DARK_MIN_SECONDS);
  }

  private start(player: THREE.Vector3): void {
    const angle = Math.random() * Math.PI * 2;
    const distance = ORIGIN_MIN_DISTANCE + Math.random() * (ORIGIN_MAX_DISTANCE - ORIGIN_MIN_DISTANCE);
    this.state.on = true;
    this.state.originX = player.x + Math.cos(angle) * distance;
    this.state.originZ = player.z + Math.sin(angle) * distance;
    this.state.radius = 0;
    this.state.restore = 0;
    this.targetRadius = distance + WAVE_OVERSHOOT;
    this.enter("wave");
    log("blackout", { action: "start", origin: [Math.round(this.state.originX), Math.round(this.state.originZ)] });
    if (this.breaker && this.breakerVoice.context.state === "running") {
      if (this.breakerVoice.isPlaying) this.breakerVoice.stop();
      this.breakerVoice.position.set(this.state.originX, 2.4, this.state.originZ);
      this.breakerVoice.setBuffer(this.breaker);
      this.breakerVoice.setVolume(1);
      this.breakerVoice.play();
    }
  }

  /** Tubes qui lâchent sur le front, quand il passe près du joueur. */
  private playDyingTubes(deltaSeconds: number, player: THREE.Vector3): void {
    const toPlayer = Math.hypot(player.x - this.state.originX, player.z - this.state.originZ);
    if (Math.abs(toPlayer - this.state.radius) > 12) return;
    this.tubeTimer -= deltaSeconds;
    if (this.tubeTimer > 0) return;
    this.tubeTimer = 0.25 + Math.random() * 0.45;
    // Un point du front, du côté du joueur.
    const base = Math.atan2(player.z - this.state.originZ, player.x - this.state.originX);
    const angle = base + (Math.random() - 0.5) * (14 / Math.max(6, this.state.radius));
    const radius = this.state.radius + Math.random() * FRONT_WIDTH;
    this.tmp.set(this.state.originX + Math.cos(angle) * radius, 2.6, this.state.originZ + Math.sin(angle) * radius);
    this.playTube(this.deaths, 0.5);
  }

  /** Starters qui claquent autour du joueur pendant le rallumage. */
  private playRestartingTubes(deltaSeconds: number, player: THREE.Vector3): void {
    this.tubeTimer -= deltaSeconds;
    if (this.tubeTimer > 0) return;
    this.tubeTimer = 0.35 + Math.random() * 0.6;
    const angle = Math.random() * Math.PI * 2;
    const radius = 2 + Math.random() * 9;
    this.tmp.set(player.x + Math.cos(angle) * radius, 2.6, player.z + Math.sin(angle) * radius);
    this.playTube(this.starts, 0.45);
  }

  private playTube(buffers: AudioBuffer[], volume: number): void {
    const voice = this.tubeVoices[this.nextTubeVoice];
    const buffer = buffers[Math.floor(Math.random() * buffers.length)];
    if (!voice || !buffer || voice.context.state !== "running") return;
    this.nextTubeVoice = (this.nextTubeVoice + 1) % this.tubeVoices.length;
    if (voice.isPlaying) voice.stop();
    voice.position.copy(this.tmp);
    voice.setBuffer(buffer);
    voice.setVolume(volume);
    voice.play();
  }

  private apply(): void {
    setBlackoutUniforms(this.state.on, this.state.originX, this.state.originZ, this.state.radius, this.state.restore);
  }
}
