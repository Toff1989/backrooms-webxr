import * as THREE from "three";
import { bandpass, createSamples, normalize, reverb, toBuffer } from "../assets/audio/synth";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { WALL_HEIGHT } from "../shared/constants";
import { getWallMaterial } from "./materials";
import { getVhsNoiseTexture } from "./vhsNoiseTexture";
import { applyVhsEffect } from "./vhsMaterial";

/** Ouverture de la porte (le joueur marche à travers). */
const DOOR_WIDTH = 0.92;
const DOOR_HEIGHT = 2.08;
const FRAME_THICKNESS = 0.07;
const FRAME_DEPTH = 0.16;
/** Bloc de mur dans lequel la porte est encastrée (profondeur derrière la façade). */
const BLOCK_WIDTH = 1.6;
const BLOCK_DEPTH = 1.15;
const BLOCK_WALL = 0.2;
/** Angle d'entrebâillement du battant (vers l'intérieur). */
const LEAF_OPEN_ANGLE = 1.0;
/** Point de déclenchement : juste passé le seuil, dans le noir. */
const TRIGGER_DEPTH = 0.45;

const BEACON_TONE_HZ = 293;
const BEACON_OVERTONE_HZ = 297.5;
const BEACON_PULSE_DURATION_SECONDS = 2.2;
const BEACON_VOLUME = 0.6;
const BEACON_REF_DISTANCE = 3;
/** Audible de loin : c'est le principal moyen de trouver la sortie. */
const BEACON_MAX_DISTANCE = 40;
/** Faux écho de la balise (corruption forte) : distance à laquelle il est joué. */
const DECOY_DISTANCE = 12;

const VOID_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Intérieur du bloc : noir total, avec de rares flocons de neige VHS qui grésillent. */
const VOID_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uPulse;
  uniform sampler2D uNoiseMap;

  void main() {
    vec2 noiseUv = fract(vUv * vec2(1.7, 2.3) + vec2(floor(uTime * 18.0) * 0.137, uTime * 0.21));
    float noise = texture2D(uNoiseMap, noiseUv).r;
    float speck = step(0.93 - uPulse * 0.05, noise) * noise;
    gl_FragColor = vec4(vec3(speck * 0.45), 1.0);
  }
`;

/**
 * Sortie du level : une porte de bureau banale, entrouverte, encastrée dans un bloc de mur
 * (même papier peint que le reste). Derrière le battant, le noir complet où grésillent quelques
 * flocons de neige — rien de lumineux, rien de "magique" : on la trouve surtout à l'oreille,
 * grâce à la balise (une radio mal réglée). Le joueur passe le seuil pour descendre.
 * La façade est tournée vers le spawn. Le bloc a de vraies collisions.
 */
export class ExitBeacon {
  readonly group: THREE.Group;
  /** Point à atteindre (juste derrière le seuil), en coordonnées monde. */
  readonly triggerPosition: THREE.Vector3;

  private readonly doorMaterial: THREE.MeshStandardMaterial;
  private readonly signMaterial: THREE.MeshStandardMaterial;
  private readonly voidMaterial: THREE.ShaderMaterial;
  private readonly leaf: THREE.Object3D;
  private readonly sound: THREE.PositionalAudio;
  private readonly decoy: THREE.PositionalAudio;
  private readonly body: RAPIER.RigidBody;
  private playRequested = false;
  private dropoutSeconds = 0;
  private decoyTimer = 10;

  constructor(
    worldX: number,
    worldZ: number,
    listener: THREE.AudioListener,
    private readonly physics: PhysicsWorld,
    /** Rotation Y de la façade (la porte regarde vers +Z local). */
    facing: number,
  ) {
    this.group = new THREE.Group();
    this.group.name = "exit-beacon";
    this.group.position.set(worldX, 0, worldZ);
    this.group.rotation.y = facing;

    const wallMaterial = getWallMaterial();
    this.doorMaterial = new THREE.MeshStandardMaterial({ color: 0x3e3a33, roughness: 0.8, metalness: 0.1 });
    applyVhsEffect(this.doorMaterial);

    // Bloc : deux joues, fond, et linteau au-dessus de la porte, en papier peint des murs.
    const sideWidth = (BLOCK_WIDTH - DOOR_WIDTH) / 2;
    const pieces: Array<[number, number, number, number, number, number]> = [
      // largeur, hauteur, profondeur, x, y, z (z négatif = derrière la façade)
      [sideWidth, WALL_HEIGHT, BLOCK_DEPTH, -(DOOR_WIDTH + sideWidth) / 2, WALL_HEIGHT / 2, -BLOCK_DEPTH / 2],
      [sideWidth, WALL_HEIGHT, BLOCK_DEPTH, (DOOR_WIDTH + sideWidth) / 2, WALL_HEIGHT / 2, -BLOCK_DEPTH / 2],
      [DOOR_WIDTH, WALL_HEIGHT, BLOCK_WALL, 0, WALL_HEIGHT / 2, -BLOCK_DEPTH + BLOCK_WALL / 2],
      [DOOR_WIDTH, WALL_HEIGHT - DOOR_HEIGHT, BLOCK_WALL, 0, DOOR_HEIGHT + (WALL_HEIGHT - DOOR_HEIGHT) / 2, -BLOCK_WALL / 2],
    ];
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    for (const [width, height, depth, x, y, z] of pieces) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), wallMaterial);
      mesh.position.set(x, y, z);
      this.group.add(mesh);
      physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2)
          .setTranslation(worldX + x * cos + z * sin, y, worldZ - x * sin + z * cos)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing))
          .setCollisionGroups(CollisionGroups.static),
        this.body,
      );
    }

    // Chambranle.
    const halfOpening = DOOR_WIDTH / 2;
    const post = new THREE.BoxGeometry(FRAME_THICKNESS, DOOR_HEIGHT + FRAME_THICKNESS, FRAME_DEPTH);
    const left = new THREE.Mesh(post, this.doorMaterial);
    left.position.set(-halfOpening + FRAME_THICKNESS / 2, (DOOR_HEIGHT + FRAME_THICKNESS) / 2, 0.02);
    const right = new THREE.Mesh(post, this.doorMaterial);
    right.position.set(halfOpening - FRAME_THICKNESS / 2, (DOOR_HEIGHT + FRAME_THICKNESS) / 2, 0.02);
    const top = new THREE.Mesh(new THREE.BoxGeometry(DOOR_WIDTH, FRAME_THICKNESS, FRAME_DEPTH), this.doorMaterial);
    top.position.set(0, DOOR_HEIGHT + FRAME_THICKNESS / 2, 0.02);
    this.group.add(left, right, top);

    // Battant entrouvert vers l'intérieur, charnière à gauche, avec sa poignée.
    const leafWidth = DOOR_WIDTH - FRAME_THICKNESS * 2;
    this.leaf = new THREE.Group();
    this.leaf.position.set(-halfOpening + FRAME_THICKNESS, 0, -0.03);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(leafWidth, DOOR_HEIGHT - 0.02, 0.04), this.doorMaterial);
    panel.position.set(leafWidth / 2, DOOR_HEIGHT / 2, 0);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8), this.doorMaterial);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(leafWidth - 0.1, 1.0, 0.05);
    this.leaf.add(panel, handle);
    this.leaf.rotation.y = LEAF_OPEN_ANGLE;
    this.group.add(this.leaf);

    // Vieux panneau de sortie de secours au-dessus de la porte : presque éteint, il grésille
    // faiblement — le portail doit rester sombre ; on le trouve surtout à l'oreille (balise)
    // et au signal du caméscope.
    const signTexture = createExitSignTexture();
    this.signMaterial = new THREE.MeshStandardMaterial({
      map: signTexture,
      emissive: 0xffffff,
      emissiveMap: signTexture,
      emissiveIntensity: 0.3,
      roughness: 0.6,
    });
    applyVhsEffect(this.signMaterial, { zoneLighting: false });
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.05), this.signMaterial);
    sign.position.set(0, DOOR_HEIGHT + 0.3, 0.03);
    this.group.add(sign);

    // Intérieur noir (faces intérieures d'une boîte) : ce qu'on voit par l'entrebâillement.
    this.voidMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPulse: { value: 0 }, uNoiseMap: { value: getVhsNoiseTexture() } },
      vertexShader: VOID_VERTEX_SHADER,
      fragmentShader: VOID_FRAGMENT_SHADER,
      side: THREE.BackSide,
    });
    const innerDepth = BLOCK_DEPTH - BLOCK_WALL;
    const inside = new THREE.Mesh(new THREE.BoxGeometry(DOOR_WIDTH - 0.01, DOOR_HEIGHT - 0.01, innerDepth), this.voidMaterial);
    inside.position.set(0, DOOR_HEIGHT / 2, -innerDepth / 2 - 0.001);
    this.group.add(inside);

    this.triggerPosition = new THREE.Vector3(worldX - sin * TRIGGER_DEPTH, 0, worldZ - cos * TRIGGER_DEPTH);

    beaconBuffer ??= createBeaconBuffer(listener.context);
    this.sound = createBeaconVoice(listener, beaconBuffer, BEACON_VOLUME);
    this.sound.position.set(0, DOOR_HEIGHT / 2, -0.5);
    this.group.add(this.sound);
    // Faux écho : même balise, jouée d'une mauvaise direction quand la corruption est forte.
    this.decoy = createBeaconVoice(listener, beaconBuffer, 0);
    this.decoy.setLoop(false);
  }

  /** À appeler une fois la session XR démarrée (politique d'autoplay des navigateurs). */
  play(): void {
    if (this.playRequested) return;
    this.playRequested = true;
    if (this.sound.context.state === "running") this.sound.play();
  }

  /**
   * Balise brouillée par la corruption : décrochages, désaccord (vitesse de lecture qui
   * dérive) et, au-delà de 0,6, un faux écho qui joue d'une autre direction.
   */
  update(elapsedSeconds: number, deltaSeconds: number, corruption: number, listenerPosition: THREE.Vector3, scene: THREE.Scene): void {
    const pulse = 0.5 + 0.5 * Math.sin(elapsedSeconds * 2.4);
    // Tube fatigué : quelques micro-coupures, jamais éteint longtemps.
    this.signMaterial.emissiveIntensity = Math.random() < 0.08 ? 0.05 : 0.3;
    this.voidMaterial.uniforms["uTime"]!.value = elapsedSeconds;
    this.voidMaterial.uniforms["uPulse"]!.value = pulse;
    // Le battant frémit à peine, comme poussé par un courant d'air venu du noir.
    this.leaf.rotation.y = LEAF_OPEN_ANGLE + Math.sin(elapsedSeconds * 0.7) * 0.015 + Math.sin(elapsedSeconds * 2.3) * 0.005;

    if (this.playRequested && !this.sound.isPlaying && this.sound.context.state === "running") {
      this.sound.play();
    }

    this.dropoutSeconds = Math.max(0, this.dropoutSeconds - deltaSeconds);
    if (corruption > 0.3 && Math.random() < deltaSeconds * corruption * 1.5) this.dropoutSeconds = 0.2 + Math.random() * 0.8 * corruption;
    this.sound.setVolume(this.dropoutSeconds > 0 ? 0 : BEACON_VOLUME);
    if (this.sound.source) this.sound.setPlaybackRate(1 + Math.sin(elapsedSeconds * 1.7) * 0.06 * corruption);

    this.decoyTimer -= deltaSeconds;
    if (corruption > 0.6 && this.decoyTimer <= 0 && this.decoy.context.state === "running" && !this.decoy.isPlaying) {
      this.decoyTimer = 6 + Math.random() * 8;
      const angle = Math.random() * Math.PI * 2;
      if (!this.decoy.parent) scene.add(this.decoy);
      this.decoy.position.set(listenerPosition.x + Math.cos(angle) * DECOY_DISTANCE, 1, listenerPosition.z + Math.sin(angle) * DECOY_DISTANCE);
      this.decoy.setVolume(BEACON_VOLUME * 0.8);
      this.decoy.play();
    }
  }

  dispose(): void {
    this.sound.stop();
    if (this.decoy.isPlaying) this.decoy.stop();
    this.decoy.removeFromParent();
    this.doorMaterial.dispose();
    this.signMaterial.map?.dispose();
    this.signMaterial.dispose();
    this.voidMaterial.dispose();
    this.physics.world.removeRigidBody(this.body);
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

/** Panneau "EXIT" pictogramme (bonhomme qui court vers une porte), vert sur fond clair. */
function createExitSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0f8a3c";
  ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = "#e8fff0";
  ctx.font = "bold 46px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("EXIT", 104, 50);
  // Bonhomme stylisé qui court (tête, corps, jambes, bras) + porte.
  ctx.strokeStyle = "#e8fff0";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(52, 22, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.moveTo(48, 34);
  ctx.lineTo(40, 58);
  ctx.moveTo(40, 58);
  ctx.lineTo(56, 78);
  ctx.moveTo(40, 58);
  ctx.lineTo(24, 76);
  ctx.moveTo(46, 40);
  ctx.lineTo(64, 48);
  ctx.moveTo(46, 40);
  ctx.lineTo(30, 44);
  ctx.stroke();
  ctx.strokeRect(70, 14, 22, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBeaconVoice(listener: THREE.AudioListener, buffer: AudioBuffer, volume: number): THREE.PositionalAudio {
  const voice = new THREE.PositionalAudio(listener);
  voice.setBuffer(buffer);
  voice.setLoop(true);
  voice.setRefDistance(BEACON_REF_DISTANCE);
  voice.setMaxDistance(BEACON_MAX_DISTANCE);
  voice.setVolume(volume);
  return voice;
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
