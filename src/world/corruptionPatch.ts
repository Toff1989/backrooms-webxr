import * as THREE from "three";
import { createCorruptionWarningBuffer } from "../assets/audio/threatSounds";
import { queueWarmup } from "../assets/audio/synth";
import { log } from "../debug/debugLog";
import { getVhsNoiseTexture, vhsNoiseFrame } from "./vhsNoiseTexture";

type Phase = "idle" | "warning" | "growing" | "holding" | "shrinking";

/** Profondeur à partir de laquelle une tache peut apparaître. */
export const CORRUPTION_PATCH_MIN_DEPTH = 1;
/** Rayon maximal de la tache (m). */
const MAX_RADIUS = 1.6;
/** Le quad déborde du rayon max pour laisser place au bord déchiqueté et à son halo. */
const QUAD_HALF = MAX_RADIUS * 1.35;
/** Distance devant le joueur du centre de la tache : elle s'étend sous ses pieds en grandissant. */
const SPAWN_DISTANCE = 1.1;
const WARNING_SECONDS = 1.6;
const GROW_SECONDS = 4;
const HOLD_MIN_SECONDS = 14;
const HOLD_MAX_SECONDS = 22;
const SHRINK_SECONDS = 3;
const FIRST_DELAY_MIN = 45;
const FIRST_DELAY_MAX = 90;
const NEXT_DELAY_MIN = 70;
const NEXT_DELAY_MAX = 130;
/** Tolérance : on ne mord le joueur que bien à l'intérieur du bord déchiqueté. */
const DAMAGE_INNER_FACTOR = 0.78;
/** Dégâts (points de santé/s) et folie (%/s) tant que le joueur est sur la tache. */
export const PATCH_DAMAGE_PER_SECOND = 7;
export const PATCH_MADNESS_PER_SECOND = 9;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    // Plan posé à plat : position locale (x, z) en mètres depuis le centre de la tache.
    vLocal = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Disque au bord rongé (ondulation lente + dents de neige qui changent à la cadence de la
 * bande), rempli de neige VHS animée : lignes de tracking qui décalent l'image, barre sombre
 * qui défile, liseré clair, halo de neige qui crépite autour (noir et blanc).
 */
const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vLocal;
  uniform float uTime;
  uniform float uRadius;
  uniform sampler2DArray uNoiseMap;
  uniform float uNoiseFrame;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vhs(vec2 uv) {
    return texture(uNoiseMap, vec3(fract(uv), uNoiseFrame)).r;
  }

  void main() {
    float d = length(vLocal);
    float a = atan(vLocal.y, vLocal.x);
    float stepTime = floor(uTime * 12.0);

    // Bord : ondulation lente + harmoniques rapides + dents brusques, renouvelées à ~12 Hz.
    float wobble = 0.06 * sin(3.0 * a + 1.7 * uTime) + 0.04 * sin(5.0 * a - 2.3 * uTime) + 0.03 * sin(9.0 * a + 4.1 * uTime)
      + 0.03 * sin(17.0 * a + stepTime * 2.1) + 0.02 * sin(29.0 * a - stepTime * 3.7);
    float spikes = hash(vec2(floor(a * 48.0), stepTime)) - 0.5;
    float edge = uRadius * (1.0 + wobble + spikes * 0.06);

    float inside = 1.0 - smoothstep(edge - 0.035, edge, d);
    float halo = (1.0 - smoothstep(edge, edge + 0.16, d)) * step(0.6, hash(vec2(floor(a * 40.0), stepTime + floor(d * 9.0))));
    if (inside + halo < 0.01) discard;

    // Tracking : bandes horizontales qui décalent le bruit latéralement.
    float row = floor(vLocal.y * 22.0 + uTime * 2.5);
    float shift = (vhs(vec2(row * 0.113, 0.3)) - 0.5) * step(0.72, vhs(vec2(row * 0.071, 0.8))) * 0.5;
    vec2 uv = vLocal * 0.55 + vec2(shift, 0.0) + vec2(stepTime * 0.137, uTime * 0.21);
    float grain = vhs(uv);
    float grain2 = vhs(uv * 1.7 + 0.31);

    // Barre sombre qui monte, comme une bande mal tendue.
    float bar = smoothstep(0.0, 0.25, fract(vLocal.y * 0.35 - uTime * 0.4));
    vec3 color = vec3(grain) * (0.55 + 0.45 * bar);
    color = mix(color, vec3(grain2), 0.35);

    // Liseré plus clair et plus contrasté, en noir et blanc.
    float rim = smoothstep(edge - 0.2, edge, d);
    color = mix(color, vec3(clamp(grain * 1.6, 0.0, 1.0)), rim * 0.8);

    vec3 haloColor = vec3(0.3 + grain * 0.7);
    float alpha = inside * 0.96 + halo * 0.7 * (1.0 - inside);
    gl_FragColor = vec4(mix(haloColor, color, inside), alpha);
  }
`;

export interface CorruptionPatchEvents {
  /** Vrai la frame où l'annonce sonore démarre. */
  announced: boolean;
  /** Vrai tant que le joueur se trouve sur la tache. */
  onPatch: boolean;
}

/**
 * Corruption VHS : une tache au sol — disque au bord rongé rempli de neige de bande — qui
 * apparaît devant le joueur après une annonce sonore, grandit jusqu'à son rayon maximal, reste
 * un moment puis se résorbe. La marcher dessus fait perdre de la santé, monte la folie et
 * interdit le sprint (voir main.ts / `PlayerController.sprintBlocked`).
 *
 * Surface plane à plat sur le sol (shader, aucun modèle), qui réutilise la texture de bruit VHS
 * partagée avec l'overlay caméra et la sortie.
 */
export class CorruptionPatch {
  private phase: Phase = "idle";
  private phaseSeconds = 0;
  private holdSeconds = HOLD_MIN_SECONDS;
  private nextEvent = 0;
  private radius = 0;
  private manual = false;
  private depth = 0;
  private justAnnounced = false;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly warningVoice: THREE.Audio;
  private warningBuffer: AudioBuffer | null = null;
  private readonly center = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  constructor(scene: THREE.Scene, listener: THREE.AudioListener) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: 0 },
        uNoiseMap: { value: getVhsNoiseTexture() },
        uNoiseFrame: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const geometry = new THREE.PlaneGeometry(QUAD_HALF * 2, QUAD_HALF * 2);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "corruption-patch";
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.warningVoice = new THREE.Audio(listener);
    queueWarmup(() => (this.warningBuffer = createCorruptionWarningBuffer(listener.context)));
    this.reset(0);
  }

  get active(): boolean {
    return this.phase !== "idle";
  }

  /** Nouveau niveau : la tache disparaît, la prochaine viendra dans une à deux minutes. */
  reset(depth: number): void {
    this.phase = "idle";
    this.manual = false;
    this.radius = 0;
    this.depth = depth;
    this.nextEvent = FIRST_DELAY_MIN + Math.random() * (FIRST_DELAY_MAX - FIRST_DELAY_MIN);
    this.mesh.visible = false;
  }

  /** Menu debug : fait apparaître une tache tout de suite, ou la retire. */
  toggle(player: THREE.Vector3, camera: THREE.Camera): void {
    if (this.phase !== "idle") {
      log("corruptionPatch", { action: "stop" });
      this.reset(this.depth);
      return;
    }
    this.manual = true;
    this.begin(player, camera);
  }

  update(deltaSeconds: number, player: THREE.Vector3, camera: THREE.Camera, depth: number, elapsedSeconds: number): CorruptionPatchEvents {
    const events: CorruptionPatchEvents = { announced: this.justAnnounced, onPatch: false };
    this.justAnnounced = false;
    if (depth < CORRUPTION_PATCH_MIN_DEPTH && !this.manual) return events;
    this.phaseSeconds += deltaSeconds;

    switch (this.phase) {
      case "idle":
        this.nextEvent -= deltaSeconds;
        if (this.nextEvent <= 0) this.begin(player, camera);
        break;
      case "warning":
        if (this.phaseSeconds >= WARNING_SECONDS) this.enter("growing");
        break;
      case "growing":
        this.radius = MAX_RADIUS * easeOut(this.phaseSeconds / GROW_SECONDS);
        if (this.phaseSeconds >= GROW_SECONDS) this.enter("holding");
        break;
      case "holding":
        this.radius = MAX_RADIUS;
        if (this.phaseSeconds >= this.holdSeconds) this.enter("shrinking");
        break;
      case "shrinking":
        this.radius = MAX_RADIUS * (1 - Math.min(1, this.phaseSeconds / SHRINK_SECONDS));
        if (this.phaseSeconds >= SHRINK_SECONDS) {
          log("corruptionPatch", { action: "end" });
          this.reset(depth);
          this.nextEvent = NEXT_DELAY_MIN + Math.random() * (NEXT_DELAY_MAX - NEXT_DELAY_MIN);
        }
        break;
    }

    if (this.phase !== "idle") {
      events.onPatch = this.contains(player);
      this.apply(elapsedSeconds);
    }
    return events;
  }

  /** Pose la tache devant le joueur et lance l'annonce. */
  private begin(player: THREE.Vector3, camera: THREE.Camera): void {
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.center.set(player.x + this.forward.x * SPAWN_DISTANCE, 0.012, player.z + this.forward.z * SPAWN_DISTANCE);
    this.mesh.position.copy(this.center);
    this.mesh.visible = true;
    this.radius = 0;
    this.justAnnounced = true;
    this.enter("warning");
    log("corruptionPatch", { action: "start", at: [Math.round(this.center.x * 10) / 10, Math.round(this.center.z * 10) / 10] });
    this.playWarning();
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.phaseSeconds = 0;
    if (phase === "holding") this.holdSeconds = HOLD_MIN_SECONDS + Math.random() * (HOLD_MAX_SECONDS - HOLD_MIN_SECONDS);
  }

  private contains(player: THREE.Vector3): boolean {
    if (this.radius <= 0.05) return false;
    return Math.hypot(player.x - this.center.x, player.z - this.center.z) < this.radius * DAMAGE_INNER_FACTOR;
  }

  private playWarning(): void {
    if (!this.warningBuffer || this.warningVoice.context.state !== "running") return;
    if (this.warningVoice.isPlaying) this.warningVoice.stop();
    this.warningVoice.setBuffer(this.warningBuffer);
    this.warningVoice.setVolume(0.45);
    this.warningVoice.play();
  }

  private apply(elapsedSeconds: number): void {
    const uniforms = this.material.uniforms;
    uniforms["uTime"]!.value = elapsedSeconds;
    uniforms["uNoiseFrame"]!.value = vhsNoiseFrame(elapsedSeconds);
    // Pendant l'annonce : un germe qui crépite ; ensuite le vrai rayon.
    uniforms["uRadius"]!.value = this.phase === "warning" ? 0.12 + 0.1 * Math.random() : this.radius;
  }
}

function easeOut(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return 1 - (1 - t) * (1 - t);
}
