import * as THREE from "three";
import type { WallSegment } from "../shared/chunkLayout";
import { getVhsNoiseTexture } from "./vhsNoiseTexture";

/** Taille du décalque tirée aléatoirement dans cette plage à chaque piège (variabilité). */
const DECAL_SIZE_MIN = 0.6;
const DECAL_SIZE_MAX = 1.7;
const WALL_DECAL_HEIGHT = 1.2;
/** Distance max pour "coller" le décalque à un mur proche plutôt qu'au seul sol. */
const WALL_ATTACH_MAX_DISTANCE = 1.8;
const WALL_SURFACE_OFFSET = 0.01;

const TRIGGER_RADIUS = 1.6;
/** Rayon au-delà du déclenchement où le fragment "réagit" déjà (signal avant-coureur visuel). */
const AWARENESS_RADIUS = 4.5;
const CORRUPTION_RATE_PER_SECOND = 0.35;

const CRACKLE_DURATION_SECONDS = 1.6;
const CRACKLE_VOLUME = 0.35;
const CRACKLE_REF_DISTANCE = 1.5;
const CRACKLE_MAX_DISTANCE = 8;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uSeed;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  void main() {
    vUv = uv;
    vec3 pos = position;
    float seedOffset = uSeed * 61.0;
    float timeStep = floor(uTime * (4.0 + fract(uSeed * 11.0) * 4.0));
    float jitterX = hash21(uv * 41.0 + timeStep + seedOffset) - 0.5;
    float jitterY = hash21(uv * 53.0 + timeStep + seedOffset + 7.0) - 0.5;
    pos.x += jitterX * 0.1;
    pos.y += jitterY * 0.08;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uProximity;
  uniform float uSeed;
  uniform sampler2D uNoiseMap;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  void main() {
    float seedOffset = uSeed * 173.0;
    float timeStep = floor(uTime * (5.0 + fract(uSeed * 13.0) * 5.0));

    // Deux grilles de blocs à densités différentes, combinées : casse l'effet "quadrillage
    // propre" d'une seule grille et rend chaque piège visuellement distinct des autres.
    float blocksA = 6.0 + floor(fract(uSeed * 71.3) * 6.0);
    float blocksB = 9.0 + floor(fract(uSeed * 29.7) * 8.0);
    vec2 blockIdA = floor(vUv * blocksA);
    vec2 blockIdB = floor((vUv + 0.371) * blocksB);

    vec2 jitter = vec2(hash21(blockIdA + timeStep + seedOffset), hash21(blockIdA + timeStep + seedOffset + 91.7)) - 0.5;
    vec2 uv = fract(vUv + jitter * (0.16 + uProximity * 0.2));

    float aberration = 0.02 + uProximity * 0.05;
    float angle = seedOffset;
    vec2 dir = vec2(cos(angle), sin(angle));
    float r = texture2D(uNoiseMap, uv + dir * aberration).r;
    float g = texture2D(uNoiseMap, uv).r;
    float b = texture2D(uNoiseMap, uv - dir * aberration).r;

    // Blocs manquants (deux grilles combinées) : lu comme un fragment déchiré, pas une
    // carte pleine — et jamais deux fois le même trou d'un piège à l'autre.
    float presentA = step(0.3, hash21(blockIdA + timeStep + seedOffset + 5.0));
    float presentB = step(0.4, hash21(blockIdB + timeStep + seedOffset + 12.0));
    float blockPresent = presentA * presentB;

    float flicker = step(0.4, hash21(vec2(timeStep, seedOffset + 3.7)));
    float flash = step(0.94, hash21(blockIdA + timeStep + seedOffset + 40.0));

    vec3 color = mix(vec3(r, g, b) * vec3(0.55, 0.85, 1.0), vec3(1.0), flash);
    float alpha = blockPresent * (0.5 + flicker * 0.4) * (0.4 + uProximity * 0.6);

    gl_FragColor = vec4(color, alpha);
  }
`;

export interface GlitchTrapUpdateResult {
  /** Corruption à ajouter cette frame (0 si le joueur est hors de portée de déclenchement). */
  corruptionDelta: number;
  /** Vrai la frame où le joueur entre dans le rayon de déclenchement (pour le signal haptique). */
  justTriggered: boolean;
}

/**
 * Piège glitch (fiche projet, étape 5, type "zone de corruption") : un ou deux
 * décalques plaqués sur les surfaces existantes (sol, et mur le plus proche s'il y en
 * a un) qui échantillonnent le vrai bruit VHS (aberration chromatique, blocs
 * manquants, tremblement de sommets) plutôt qu'un simple marqueur de couleur plate —
 * lu comme un fragment de la pièce qui se corrompt sur place, pas un objet flottant.
 * Grésillement audio positionnel en signal avant-coureur. Aucune collision — au
 * contact, seule la corruption visuelle cumulable augmente (pas de mort, pas de
 * distorsion de la position/rotation caméra).
 */
export class GlitchTrap {
  readonly group: THREE.Group;

  private readonly material: THREE.ShaderMaterial;
  private readonly sound: THREE.PositionalAudio;
  private readonly worldX: number;
  private readonly worldZ: number;
  private playRequested = false;
  private playerWasInside = false;

  constructor(worldX: number, worldZ: number, listener: THREE.AudioListener, nearbyWallSegments: WallSegment[] = []) {
    this.worldX = worldX;
    this.worldZ = worldZ;

    this.group = new THREE.Group();
    this.group.name = "glitch-trap";
    this.group.position.set(worldX, 0, worldZ);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProximity: { value: 0 },
        // Seed aléatoire par instance : deux pièges ne montrent jamais exactement le même
        // motif (densité de blocs, timing, direction de l'aberration chromatique).
        uSeed: { value: Math.random() },
        uNoiseMap: { value: getVhsNoiseTexture() },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Décalque plaqué sur le sol (pas un objet flottant) : un fragment de texture qui se
    // corrompt sur la surface elle-même. Taille aléatoire : deux pièges ne se ressemblent
    // jamais tout à fait, même avec un motif proche.
    const decalSize = DECAL_SIZE_MIN + Math.random() * (DECAL_SIZE_MAX - DECAL_SIZE_MIN);
    const geometry = new THREE.PlaneGeometry(decalSize, decalSize, 8, 8);
    const floorDecal = new THREE.Mesh(geometry, this.material);
    floorDecal.rotation.x = -Math.PI / 2;
    floorDecal.position.y = 0.012;
    this.group.add(floorDecal);

    // S'il y a un mur à proximité, un second décalque s'y colle aussi (pas seulement au sol).
    const wallFace = findNearestWallFace(worldX, worldZ, nearbyWallSegments, decalSize);
    if (wallFace) {
      const wallDecal = new THREE.Mesh(geometry, this.material);
      wallDecal.rotation.y = wallFace.rotationY;
      wallDecal.position.set(wallFace.position.x - worldX, wallFace.position.y, wallFace.position.z - worldZ);
      this.group.add(wallDecal);
    }

    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setBuffer(createCrackleBuffer(listener.context));
    this.sound.setLoop(true);
    this.sound.setRefDistance(CRACKLE_REF_DISTANCE);
    this.sound.setMaxDistance(CRACKLE_MAX_DISTANCE);
    this.sound.setVolume(CRACKLE_VOLUME);
    this.sound.position.y = WALL_DECAL_HEIGHT;
    this.group.add(this.sound);
  }

  /** À appeler une fois la session XR démarrée (politique d'autoplay des navigateurs). */
  play(): void {
    if (this.playRequested) return;
    this.playRequested = true;
    if (this.sound.context.state === "running") this.sound.play();
  }

  update(playerPosition: THREE.Vector3, elapsedSeconds: number, deltaSeconds: number): GlitchTrapUpdateResult {
    const dx = playerPosition.x - this.worldX;
    const dz = playerPosition.z - this.worldZ;
    const distance = Math.hypot(dx, dz);
    const awareness = THREE.MathUtils.clamp(1 - distance / AWARENESS_RADIUS, 0, 1);

    this.material.uniforms["uTime"]!.value = elapsedSeconds;
    this.material.uniforms["uProximity"]!.value = awareness;

    if (this.playRequested && !this.sound.isPlaying && this.sound.context.state === "running") {
      this.sound.play();
    }

    const playerIsInside = distance < TRIGGER_RADIUS;
    const justTriggered = playerIsInside && !this.playerWasInside;
    this.playerWasInside = playerIsInside;

    if (!playerIsInside) return { corruptionDelta: 0, justTriggered: false };

    const triggerProximity = 1 - distance / TRIGGER_RADIUS; // 0..1, plus fort au centre
    return { corruptionDelta: CORRUPTION_RATE_PER_SECOND * triggerProximity * deltaSeconds, justTriggered };
  }

  dispose(): void {
    this.sound.stop();
    this.material.dispose();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

interface WallFace {
  position: THREE.Vector3;
  rotationY: number;
}

/** Trouve le mur le plus proche (dans un rayon donné) et la position/orientation d'un
 * décalque plaqué contre sa face tournée vers le piège. */
function findNearestWallFace(worldX: number, worldZ: number, wallSegments: WallSegment[], decalSize: number): WallFace | null {
  let best: WallSegment | null = null;
  let bestDistance = WALL_ATTACH_MAX_DISTANCE;

  for (const segment of wallSegments) {
    const closestX = THREE.MathUtils.clamp(worldX, segment.minX, segment.maxX);
    const closestZ = THREE.MathUtils.clamp(worldZ, segment.minZ, segment.maxZ);
    const distance = Math.hypot(worldX - closestX, worldZ - closestZ);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = segment;
    }
  }
  if (!best) return null;

  const width = best.maxX - best.minX;
  const depth = best.maxZ - best.minZ;
  const alongX = width >= depth;
  const wallCenterX = (best.minX + best.maxX) / 2;
  const wallCenterZ = (best.minZ + best.maxZ) / 2;
  const margin = Math.min(decalSize / 2, Math.max(width, depth) / 2 - 0.05);

  if (alongX) {
    const faceZ = worldZ < wallCenterZ ? best.minZ - WALL_SURFACE_OFFSET : best.maxZ + WALL_SURFACE_OFFSET;
    const clampedX = THREE.MathUtils.clamp(worldX, best.minX + margin, best.maxX - margin);
    return { position: new THREE.Vector3(clampedX, WALL_DECAL_HEIGHT, faceZ), rotationY: 0 };
  }

  const faceX = worldX < wallCenterX ? best.minX - WALL_SURFACE_OFFSET : best.maxX + WALL_SURFACE_OFFSET;
  const clampedZ = THREE.MathUtils.clamp(worldZ, best.minZ + margin, best.maxZ - margin);
  return { position: new THREE.Vector3(faceX, WALL_DECAL_HEIGHT, clampedZ), rotationY: Math.PI / 2 };
}

function createCrackleBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * CRACKLE_DURATION_SECONDS);
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    // Grésillement : bruit blanc en bouffées aléatoires, pas un ton continu.
    const burst = Math.random() < 0.12 ? 1 : 0.15;
    data[i] = (Math.random() * 2 - 1) * burst * 0.5;
  }

  return buffer;
}
