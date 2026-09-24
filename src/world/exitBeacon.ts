import * as THREE from "three";
import { bandpass, createSamples, normalize, reverb, toBuffer } from "../assets/audio/synth";
import { getVhsNoiseTexture } from "./vhsNoiseTexture";
import { applyVhsEffect } from "./vhsMaterial";

const BEACON_COLOR = 0x36e8ff;
const BEACON_COLOR_VEC = new THREE.Color(BEACON_COLOR);
const BASE_EMISSIVE_INTENSITY = 1.4;
const PULSE_AMPLITUDE = 0.6;
const PULSE_SPEED = 2.4;

/** Dimensions du chambranle (porte, pas un simple anneau flottant) : le joueur marche à travers. */
const PORTAL_WIDTH = 1.1;
const PORTAL_HEIGHT = 2.3;
const FRAME_THICKNESS = 0.1;
const FRAME_DEPTH = 0.1;

const BEACON_TONE_HZ = 293;
const BEACON_OVERTONE_HZ = 297.5;
const BEACON_PULSE_DURATION_SECONDS = 2.2;
const BEACON_VOLUME = 0.5;
const BEACON_REF_DISTANCE = 2;
const BEACON_MAX_DISTANCE = 20;

const PORTAL_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PORTAL_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uPulse;
  uniform vec3 uColor;
  uniform sampler2D uNoiseMap;

  void main() {
    vec2 centered = vUv - 0.5;
    float radius = length(centered);
    float angle = atan(centered.y, centered.x);
    float swirl = angle + radius * 6.0 - uTime * 1.2;
    vec2 swirlUv = vec2(cos(swirl), sin(swirl)) * radius + 0.5;
    vec2 noiseUv = fract(swirlUv * 1.6 + vec2(uTime * 0.05, uTime * 0.03));
    float noise = texture2D(uNoiseMap, noiseUv).r;

    float vignette = smoothstep(0.62, 0.1, radius);
    float brightness = noise * vignette * uPulse;
    gl_FragColor = vec4(uColor * (0.4 + brightness * 1.6), vignette);
  }
`;

/**
 * Marqueur de sortie du level : un vrai chambranle de porte (pas un simple anneau
 * flottant) rempli d'un tourbillon de bruit VHS (même texture que l'overlay caméscope,
 * voir `vhsNoiseTexture.ts`) dans la couleur du signal — le joueur marche à travers,
 * cohérent avec la direction artistique VHS. + balise sonore positionnelle — "sortie...
 * signalée par des indices (son, lumière différente)" (fiche projet).
 */
export class ExitBeacon {
  readonly group: THREE.Group;

  private readonly frameMaterial: THREE.MeshStandardMaterial;
  private readonly portalMaterial: THREE.ShaderMaterial;
  private readonly sound: THREE.PositionalAudio;
  private playRequested = false;

  constructor(worldX: number, worldZ: number, listener: THREE.AudioListener) {
    this.group = new THREE.Group();
    this.group.name = "exit-beacon";
    this.group.position.set(worldX, 0, worldZ);

    this.frameMaterial = new THREE.MeshStandardMaterial({
      color: BEACON_COLOR,
      emissive: BEACON_COLOR,
      emissiveIntensity: BASE_EMISSIVE_INTENSITY,
      roughness: 0.4,
    });
    applyVhsEffect(this.frameMaterial, { zoneLighting: false });

    const halfWidth = PORTAL_WIDTH / 2 + FRAME_THICKNESS / 2;
    const postGeometry = new THREE.BoxGeometry(FRAME_THICKNESS, PORTAL_HEIGHT + FRAME_THICKNESS, FRAME_DEPTH);
    const leftPost = new THREE.Mesh(postGeometry, this.frameMaterial);
    leftPost.position.set(-halfWidth, PORTAL_HEIGHT / 2, 0);
    const rightPost = new THREE.Mesh(postGeometry, this.frameMaterial);
    rightPost.position.set(halfWidth, PORTAL_HEIGHT / 2, 0);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(PORTAL_WIDTH + FRAME_THICKNESS * 2, FRAME_THICKNESS, FRAME_DEPTH), this.frameMaterial);
    lintel.position.set(0, PORTAL_HEIGHT, 0);
    this.group.add(leftPost, rightPost, lintel);

    this.portalMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPulse: { value: 1 },
        uColor: { value: BEACON_COLOR_VEC },
        uNoiseMap: { value: getVhsNoiseTexture() },
      },
      vertexShader: PORTAL_VERTEX_SHADER,
      fragmentShader: PORTAL_FRAGMENT_SHADER,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const portalPlane = new THREE.Mesh(new THREE.PlaneGeometry(PORTAL_WIDTH, PORTAL_HEIGHT), this.portalMaterial);
    portalPlane.position.set(0, PORTAL_HEIGHT / 2, 0);
    this.group.add(portalPlane);

    this.sound = new THREE.PositionalAudio(listener);
    beaconBuffer ??= createBeaconBuffer(listener.context);
    this.sound.setBuffer(beaconBuffer);
    this.sound.setLoop(true);
    this.sound.setRefDistance(BEACON_REF_DISTANCE);
    this.sound.setMaxDistance(BEACON_MAX_DISTANCE);
    this.sound.setVolume(BEACON_VOLUME);
    this.sound.position.y = PORTAL_HEIGHT / 2;
    this.group.add(this.sound);
  }

  /** À appeler une fois la session XR démarrée (politique d'autoplay des navigateurs). */
  play(): void {
    if (this.playRequested) return;
    this.playRequested = true;
    if (this.sound.context.state === "running") this.sound.play();
  }

  update(elapsedSeconds: number): void {
    const pulse = BASE_EMISSIVE_INTENSITY + Math.sin(elapsedSeconds * PULSE_SPEED) * PULSE_AMPLITUDE;
    this.frameMaterial.emissiveIntensity = pulse;
    this.portalMaterial.uniforms["uTime"]!.value = elapsedSeconds;
    this.portalMaterial.uniforms["uPulse"]!.value = pulse / BASE_EMISSIVE_INTENSITY;
    if (this.playRequested && !this.sound.isPlaying && this.sound.context.state === "running") {
      this.sound.play();
    }
  }

  dispose(): void {
    this.sound.stop();
    this.frameMaterial.dispose();
    this.portalMaterial.dispose();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

let beaconBuffer: AudioBuffer | null = null;

/**
 * Balise : une radio mal réglée quelque part — porteuse grave désaccordée, qui pleure
 * (wow de bande), noyée dans le souffle. Reconnaissable et localisable, mais pas un carillon.
 */
function createBeaconBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const data = createSamples(sampleRate, BEACON_PULSE_DURATION_SECONDS);
  let phaseA = 0;
  let phaseB = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const envelope = Math.pow(Math.max(0, Math.sin((t / BEACON_PULSE_DURATION_SECONDS) * Math.PI)), 2);
    const wow = 1 + Math.sin(2 * Math.PI * 0.9 * t) * 0.012 + Math.sin(2 * Math.PI * 5.3 * t) * 0.003;
    phaseA += (2 * Math.PI * BEACON_TONE_HZ * wow) / sampleRate;
    phaseB += (2 * Math.PI * BEACON_OVERTONE_HZ * wow) / sampleRate;
    const carrier = Math.tanh((Math.sin(phaseA) + Math.sin(phaseB) * 0.7) * 1.8) * 0.5;
    const dropout = Math.random() < 0.0015 ? 0 : 1;
    data[i] = (carrier * dropout + (Math.random() * 2 - 1) * 0.12) * envelope;
  }
  bandpass(data, sampleRate, 700, 0.9);
  reverb(data, sampleRate, 0.35, 1.4);
  return toBuffer(context, normalize(data, 0.7));
}
