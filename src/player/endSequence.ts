import * as THREE from "three";
import { createJumpscareBuffer } from "../assets/audio/threatSounds";
import { queueWarmup } from "../assets/audio/synth";
import { log } from "../debug/debugLog";
import { spawnCollectibleModel } from "../world/collectibleLoader";
import type { JumpscareLevel } from "./comfortSettings";
import type { VhsOverlay } from "./vhsOverlay";

function glowTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.9)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export type EndSequenceKind = "caught" | "health";

/** Taille (m) visée de la tête-caméra en gros plan, et sa distance devant les yeux. */
const HEAD_SIZE = 0.5;
const HEAD_DISTANCE = 0.55;
const HEAD_RENDER_ORDER = 990;
/** Durées (s) de la séquence selon le cas et l'intensité choisie. */
const CAUGHT_SECONDS: Record<JumpscareLevel, number> = { normal: 2.6, reduced: 1.8, off: 0.9 };
const HEALTH_SECONDS = 3.2;
/** Fondu final vers le noir, au bout de la séquence (s). */
const CAUGHT_FADE_SECONDS = 0.7;
/** Fondu relâché (s) une fois l'écran de score affiché. */
const RELEASE_SECONDS = 0.8;
/** LED "REC" en gros plan : taille (m) du halo et position par rapport au centre de la tête. */
const LED_SIZE = 0.1;
const LED_OFFSET = new THREE.Vector3(0.1, 0.17, 0.05);
const BLOOD = new THREE.Color(0x8a0a0a);
const BLACK = new THREE.Color(0x000000);

/**
 * Séquences avant l'écran de score :
 * - capturé par le Cadreur : sursaut — sa tête-caméra en gros plan (LED allumée), effet VHS
 *   (perte de tracking, neige) et bruit ; atténué ou supprimé dans les paramètres ;
 * - santé à zéro : fondu au rouge puis au noir.
 * Tout passe par l'overlay VHS fixé à la tête (pas de post-traitement en WebXR).
 */
export class EndSequence {
  private readonly head = new THREE.Group();
  private readonly led: THREE.Sprite;
  private readonly sound: THREE.Audio;
  private readonly softSound: THREE.Audio;
  private buffer: AudioBuffer | null = null;
  private softBuffer: AudioBuffer | null = null;
  private kind: EndSequenceKind = "caught";
  private level: JumpscareLevel = "normal";
  private elapsed = 0;
  private duration = 0;
  private running = false;
  private onFinished: (() => void) | null = null;
  private releasing = 0;
  private releaseColor = new THREE.Color();
  private glitchTimer = 0;
  /** Modèle de la tête chargé (ou échec journalisé) : ne rejette jamais. */
  readonly ready: Promise<void>;

  constructor(
    camera: THREE.Camera,
    listener: THREE.AudioListener,
    private readonly overlay: VhsOverlay,
  ) {
    this.sound = new THREE.Audio(listener);
    this.softSound = new THREE.Audio(listener);
    queueWarmup(() => (this.buffer = createJumpscareBuffer(listener.context)));
    queueWarmup(() => (this.softBuffer = createJumpscareBuffer(listener.context, true)));
    this.led = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff2a1a, fog: false, toneMapped: false, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.led.scale.setScalar(LED_SIZE);
    // En haut à droite de la face avant, près du viseur : toujours visible (pas de test de profondeur).
    this.led.position.set(LED_OFFSET.x, LED_OFFSET.y, LED_OFFSET.z);
    this.led.renderOrder = HEAD_RENDER_ORDER + 1;
    this.head.visible = false;
    this.head.renderOrder = HEAD_RENDER_ORDER;
    camera.add(this.head);
    this.ready = spawnCollectibleModel("cadreurHead")
      .then(({ model }) => {
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = HEAD_SIZE / Math.max(size.x, size.y, size.z, 0.01);
        model.scale.setScalar(scale);
        // Centré sur son milieu : le modèle n'est pas centré sur son origine.
        model.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
        // Matériaux d'origine remplacés par des versions sans éclairage : le gros plan ne doit pas
        // dépendre de la lumière de la scène (noire dans une zone sombre).
        model.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const source = Array.isArray(child.material) ? child.material[0] : child.material;
          const color = source instanceof THREE.MeshStandardMaterial ? source.color.clone().multiplyScalar(0.9) : new THREE.Color(0x777777);
          child.material = new THREE.MeshBasicMaterial({
            map: source instanceof THREE.MeshStandardMaterial ? source.map : null,
            color,
            fog: false,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          });
          child.renderOrder = HEAD_RENDER_ORDER;
          child.frustumCulled = false;
        });
        this.head.add(model, this.led);
      })
      .catch((error: unknown) => log("error", { where: "endSequence", error: String(error) }));
  }

  get active(): boolean {
    return this.running;
  }

  /** `onFinished` : appelé quand l'écran est entièrement noir — l'appelant affiche alors l'écran de score. */
  start(kind: EndSequenceKind, level: JumpscareLevel, onFinished: () => void): void {
    this.kind = kind;
    this.level = level;
    this.elapsed = 0;
    this.duration = kind === "caught" ? CAUGHT_SECONDS[level] : HEALTH_SECONDS;
    this.running = true;
    this.releasing = 0;
    this.glitchTimer = 0;
    this.onFinished = onFinished;
    const showHead = kind === "caught" && level !== "off";
    this.head.visible = showHead;
    if (showHead) {
      this.head.position.set(0, -0.02, -HEAD_DISTANCE - 0.35);
      this.head.scale.setScalar(0.35);
      const audio = level === "reduced" ? this.softSound : this.sound;
      const buffer = level === "reduced" ? this.softBuffer : this.buffer;
      if (buffer && audio.context.state === "running") {
        if (audio.isPlaying) audio.stop();
        audio.setBuffer(buffer);
        audio.setVolume(level === "reduced" ? 0.5 : 0.95);
        audio.play();
      }
      if (level === "normal") this.overlay.signalLoss(0.12);
    }
    log("run", { action: "end-sequence", kind, level });
  }

  /** Abandonne la séquence en cours et retire tout effet (nouvelle partie, menu principal). */
  reset(): void {
    this.running = false;
    this.onFinished = null;
    this.releasing = 0;
    this.head.visible = false;
    this.overlay.setFade(BLACK, 0);
    if (this.sound.isPlaying) this.sound.stop();
    if (this.softSound.isPlaying) this.softSound.stop();
  }

  update(deltaSeconds: number): void {
    if (!this.running) {
      if (this.releasing > 0) {
        this.releasing = Math.max(0, this.releasing - deltaSeconds);
        this.overlay.setFade(this.releaseColor, this.releasing / RELEASE_SECONDS);
      }
      return;
    }
    this.elapsed += deltaSeconds;
    const progress = Math.min(1, this.elapsed / this.duration);
    if (this.kind === "caught") this.updateCaught(deltaSeconds, progress);
    else this.updateHealth(progress);
    if (this.elapsed >= this.duration) this.finish();
  }

  private updateCaught(deltaSeconds: number, progress: number): void {
    const fadeStart = 1 - CAUGHT_FADE_SECONDS / this.duration;
    const fade = progress > fadeStart ? (progress - fadeStart) / (1 - fadeStart) : 0;
    this.overlay.setFade(BLACK, fade);
    if (!this.head.visible) return;
    const reduced = this.level === "reduced";
    // Apparition en coup de poing (zoom brutal), puis il avance lentement vers le visage.
    const pop = Math.min(1, this.elapsed / 0.14);
    const eased = 1 - Math.pow(1 - pop, 3);
    const creep = 1 + progress * (reduced ? 0.08 : 0.25);
    this.head.scale.setScalar((reduced ? 0.7 : 0.35 + 0.65 * eased) * creep);
    const shake = reduced ? 0 : 0.012 * (1 - progress * 0.5);
    this.head.position.set((Math.random() - 0.5) * shake, -0.02 + (Math.random() - 0.5) * shake, -(HEAD_DISTANCE + 0.35 * (1 - eased)));
    this.head.rotation.z = reduced ? 0 : (Math.random() - 0.5) * 0.05;
    this.led.visible = reduced ? this.elapsed % 0.6 < 0.4 : Math.random() < 0.8;
    this.overlay.triggerTrackingLoss(reduced ? 0.55 : 1);
    if (!reduced) {
      this.glitchTimer -= deltaSeconds;
      if (this.glitchTimer <= 0) {
        this.glitchTimer = 0.1 + Math.random() * 0.25;
        this.overlay.signalLoss(0.04 + Math.random() * 0.08);
      }
    }
  }

  private updateHealth(progress: number): void {
    // Rouge qui monte, puis qui noircit : la vue se vide avec la santé.
    const amount = THREE.MathUtils.smoothstep(progress, 0, 0.85);
    const darken = THREE.MathUtils.smoothstep(progress, 0.35, 1);
    this.releaseColor.copy(BLOOD).lerp(BLACK, darken);
    this.overlay.setFade(this.releaseColor, amount * (0.78 + 0.22 * darken));
    this.overlay.triggerTrackingLoss(0.15 + 0.4 * progress);
  }

  private finish(): void {
    this.running = false;
    this.head.visible = false;
    // Écran tout noir/rouge sombre au moment d'afficher le score, relâché en douceur ensuite.
    this.releaseColor.copy(this.kind === "caught" ? BLACK : this.releaseColor);
    this.overlay.setFade(this.releaseColor, 1);
    this.releasing = RELEASE_SECONDS;
    const done = this.onFinished;
    this.onFinished = null;
    done?.();
  }
}
