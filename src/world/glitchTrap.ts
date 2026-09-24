import * as THREE from "three";
import { bandpass, brownNoise, createSamples, highpass, lowpass, makeLoopable, normalize, reverb, toBuffer } from "../assets/audio/synth";
import { addGlitchZone, GlitchKind, removeGlitchZone, type GlitchZone } from "./glitchZones";

export type GlitchTrapKind = "corruption" | "teleporter" | "loop";

const ZONE_RADIUS: Record<GlitchTrapKind, [number, number]> = {
  corruption: [1.3, 2.1],
  teleporter: [1.1, 1.4],
  loop: [1.0, 1.3],
};

const TRIGGER_RADIUS = 1.6;
/** Le téléporteur ne happe le joueur qu'au cœur de la déchirure. */
const TELEPORT_RADIUS = 0.75;
const TELEPORT_COOLDOWN_SECONDS = 4;
/** Rayon au-delà du déclenchement où la déchirure "réagit" déjà (signal avant-coureur visuel). */
const AWARENESS_RADIUS = 5;
const CORRUPTION_RATE_PER_SECOND = 0.35;

const LOOP_VOLUME = 0.45;
const REF_DISTANCE = 1.4;
const MAX_DISTANCE = 10;

export interface GlitchTrapUpdateResult {
  /** Corruption à ajouter cette frame (0 si le joueur est hors de portée de déclenchement). */
  corruptionDelta: number;
  /** Vrai la frame où le joueur entre dans le rayon de déclenchement (pour le signal haptique). */
  justTriggered: boolean;
  /** La frame où le joueur est happé : téléporteur ("random") ou boucle spatiale ("loop"). */
  teleport: "random" | "loop" | null;
}

/**
 * Piège glitch (fiche projet, étape 5). Plus de décalque posé sur le sol : le piège est une
 * zone lue par le shader VHS de toutes les surfaces (voir `glitchZones.ts`) — le carrelage,
 * la moquette, les murs et le plafond se déchirent eux-mêmes (bandes de balayage décalées,
 * blocs arrachés, trous de bruit vidéo, sommets qui tremblent).
 *
 * - "corruption" : au contact, la corruption visuelle cumulable monte (pas de mort).
 * - "teleporter" : la surface est aspirée en spirale vers un noyau noir ; y marcher
 *   téléporte le joueur ailleurs dans le niveau (jamais plus près de la sortie).
 * - "loop" (boucle spatiale) : presque invisible (une déchirure qui couve à peine) ; y
 *   passer renvoie le joueur là où il était une dizaine de secondes plus tôt — il ne s'en
 *   rend compte qu'en reconnaissant le couloir.
 */
export class GlitchTrap {
  readonly group: THREE.Group;
  readonly kind: GlitchTrapKind;

  private readonly zone: GlitchZone;
  private readonly sound: THREE.PositionalAudio;
  private readonly worldX: number;
  private readonly worldZ: number;
  private playRequested = false;
  private playerWasInside = false;
  private cooldown = 0;
  private surge = 0;
  private surgeTimer = 2 + Math.random() * 6;

  constructor(worldX: number, worldZ: number, listener: THREE.AudioListener, kind: GlitchTrapKind = "corruption") {
    this.worldX = worldX;
    this.worldZ = worldZ;
    this.kind = kind;

    this.group = new THREE.Group();
    this.group.name = `glitch-trap-${kind}`;
    this.group.position.set(worldX, 0, worldZ);

    const [minRadius, maxRadius] = ZONE_RADIUS[kind];
    this.zone = addGlitchZone({
      x: worldX,
      y: 1.3,
      z: worldZ,
      radius: minRadius + Math.random() * (maxRadius - minRadius),
      intensity: 0,
      // Seed aléatoire par instance : deux pièges ne se déchirent jamais de la même façon.
      seed: Math.random(),
      kind: kind === "teleporter" ? GlitchKind.teleporter : GlitchKind.corruption,
    });

    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setBuffer(kind === "teleporter" ? getTeleporterLoop(listener.context) : getStaticLoop(listener.context));
    // La boucle ne grésille presque pas : on ne l'entend qu'en passant tout près.
    this.sound.setLoop(true);
    this.sound.setRefDistance(REF_DISTANCE);
    this.sound.setMaxDistance(MAX_DISTANCE);
    this.sound.setRolloffFactor(1.6);
    this.sound.setVolume(kind === "loop" ? LOOP_VOLUME * 0.25 : LOOP_VOLUME);
    this.sound.position.y = 1.2;
    this.group.add(this.sound);
  }

  /** À appeler une fois la session XR démarrée (politique d'autoplay des navigateurs). */
  play(): void {
    if (this.playRequested) return;
    this.playRequested = true;
    if (this.sound.context.state === "running") this.sound.play();
  }

  update(playerPosition: THREE.Vector3, _elapsedSeconds: number, deltaSeconds: number): GlitchTrapUpdateResult {
    const dx = playerPosition.x - this.worldX;
    const dz = playerPosition.z - this.worldZ;
    const distance = Math.hypot(dx, dz);
    const awareness = THREE.MathUtils.clamp(1 - distance / AWARENESS_RADIUS, 0, 1);
    this.cooldown = Math.max(0, this.cooldown - deltaSeconds);

    // Au repos, la déchirure couve à peine (on peut la rater) ; par à-coups elle "se réveille".
    this.surgeTimer -= deltaSeconds;
    if (this.surgeTimer <= 0) {
      this.surge = 1;
      this.surgeTimer = 1.5 + Math.random() * 7;
    }
    this.surge = Math.max(0, this.surge - deltaSeconds * 2.5);
    const idle = this.kind === "teleporter" ? 0.45 : this.kind === "loop" ? 0.1 : 0.22;
    const reaction = this.kind === "loop" ? 0.25 : 0.6;
    const flicker = Math.random() < 0.08 ? 0.4 : 1;
    this.zone.intensity = Math.min(1, (idle + awareness * reaction + this.surge * (this.kind === "loop" ? 0.2 : 0.5)) * flicker);

    if (this.playRequested && !this.sound.isPlaying && this.sound.context.state === "running") {
      this.sound.play();
    }

    const playerIsInside = distance < TRIGGER_RADIUS;
    const justTriggered = playerIsInside && !this.playerWasInside;
    this.playerWasInside = playerIsInside;

    if (this.kind !== "corruption") {
      const happens = distance < TELEPORT_RADIUS && this.cooldown === 0;
      if (happens) this.cooldown = TELEPORT_COOLDOWN_SECONDS;
      // La boucle ne prévient pas (pas de vibration à l'approche) : c'est tout son principe.
      return { corruptionDelta: 0, justTriggered: this.kind === "teleporter" && justTriggered, teleport: happens ? (this.kind === "loop" ? "loop" : "random") : null };
    }

    if (!playerIsInside) return { corruptionDelta: 0, justTriggered: false, teleport: null };

    const triggerProximity = 1 - distance / TRIGGER_RADIUS; // 0..1, plus fort au centre
    return { corruptionDelta: CORRUPTION_RATE_PER_SECOND * triggerProximity * deltaSeconds, justTriggered, teleport: null };
  }

  dispose(): void {
    this.sound.stop();
    removeGlitchZone(this.zone);
  }
}

// Buffers partagés entre toutes les instances (générés une seule fois).
let staticLoop: AudioBuffer | null = null;
let teleporterLoop: AudioBuffer | null = null;

/** Grésillement de bande magnétique bégayé + bourdon secteur saturé, étouffé. */
function getStaticLoop(context: BaseAudioContext): AudioBuffer {
  if (staticLoop) return staticLoop;
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, 3.4);
  let gate = 1;
  let gateLength = 0;
  for (let i = 0; i < data.length; i++) {
    if (--gateLength <= 0) {
      gate = Math.random() < 0.6 ? 0.2 + Math.random() * 0.8 : 0;
      gateLength = Math.floor(sampleRate * (0.015 + Math.random() * 0.12));
    }
    const t = i / sampleRate;
    const buzz = Math.tanh(Math.sin(2 * Math.PI * 50 * t) * 6) * 0.18;
    data[i] = (Math.random() * 2 - 1) * gate * 0.6 + buzz * (gate > 0 ? 1 : 0.2);
  }
  bandpass(data, sampleRate, 1800, 0.6);
  highpass(data, sampleRate, 90);
  staticLoop = toBuffer(context, normalize(makeLoopable(data, sampleRate), 0.7));
  return staticLoop;
}

/** Aspiration sourde : sub-grave qui pulse, souffle grave en "respiration", grésillement lointain. */
function getTeleporterLoop(context: BaseAudioContext): AudioBuffer {
  if (teleporterLoop) return teleporterLoop;
  const sampleRate = context.sampleRate;
  const seconds = 4;
  const data = createSamples(sampleRate, seconds);
  const air = brownNoise(createSamples(sampleRate, seconds));
  lowpass(air, sampleRate, 380);
  const hiss = createSamples(sampleRate, seconds);
  for (let i = 0; i < hiss.length; i++) hiss[i] = (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 1 : 0);
  bandpass(hiss, sampleRate, 3000, 1.2);
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / seconds);
    const sub = Math.sin(2 * Math.PI * 36 * t + Math.sin(2 * Math.PI * 0.5 * t) * 2) * 0.5;
    data[i] = sub * (0.4 + breath * 0.6) + air[i]! * breath * 1.2 + hiss[i]! * 0.08;
  }
  reverb(data, sampleRate, 0.3, 1.4);
  teleporterLoop = toBuffer(context, normalize(makeLoopable(data, sampleRate, 0.5), 0.8));
  return teleporterLoop;
}
