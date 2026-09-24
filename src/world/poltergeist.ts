import * as THREE from "three";
import { brownNoise, createSamples, fadeEdges, lowpass, normalize, queueWarmup, reverb, toBuffer } from "../assets/audio/synth";
import type { GrabbableRegistry } from "./grabbable";

const MIN_DISTANCE = 4;
const MAX_DISTANCE = 13;
/** Au-delà de cette distance, un mouvement peut rarement avoir lieu dans le champ de vision. */
const IN_VIEW_MIN_DISTANCE = 9;

/**
 * Poltergeist : de temps en temps, un meuble proche bouge tout seul — une chaise glisse de
 * quelques dizaines de centimètres, un bureau racle, une chaise bascule. Presque toujours
 * hors du champ de vision (on entend le raclement, on se retourne, la chaise n'est plus au
 * même endroit) ; rarement, au loin, sous les yeux du joueur. Plus fréquent en profondeur et
 * dans le noir. Vraie impulsion physique (Rapier) : l'objet reste où il a été poussé.
 */
export class Poltergeist {
  private readonly sound: THREE.PositionalAudio;
  private readonly buffers: AudioBuffer[] = [];
  private timer = 30;
  private readonly viewDirection = new THREE.Vector3();
  private readonly toObject = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    listener: THREE.AudioListener,
    private readonly grabbables: GrabbableRegistry,
  ) {
    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setRefDistance(2.5);
    this.sound.setMaxDistance(20);
    scene.add(this.sound);
    for (let i = 0; i < 3; i++) queueWarmup(() => this.buffers.push(createScrapeBuffer(listener.context)));
  }

  update(deltaSeconds: number, camera: THREE.Camera, headPosition: THREE.Vector3, depth: number, darkness: number): void {
    this.timer -= deltaSeconds * (1 + depth * 0.12 + darkness * 1.2);
    if (this.timer > 0) return;
    this.timer = 25 + Math.random() * 35;

    camera.getWorldDirection(this.viewDirection);
    this.viewDirection.y = 0;
    this.viewDirection.normalize();

    const candidates = [];
    for (const grabbable of this.grabbables.all) {
      if (grabbable.heldBy || grabbable.isCollectible) continue;
      const position = grabbable.object.position;
      this.toObject.set(position.x - headPosition.x, 0, position.z - headPosition.z);
      const distance = this.toObject.length();
      if (distance < MIN_DISTANCE || distance > MAX_DISTANCE) continue;
      const inView = this.toObject.normalize().dot(this.viewDirection) > 0.35;
      if (inView && (distance < IN_VIEW_MIN_DISTANCE || Math.random() > 0.15)) continue;
      candidates.push(grabbable);
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (!target) return;

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.8 + Math.random() * 1.2;
    const mass = target.mass;
    target.body.wakeUp();
    if (mass < 10 && Math.random() < 0.3) {
      // Bascule : poussée haute plutôt que glissement.
      target.body.applyImpulseAtPoint(
        { x: Math.cos(angle) * mass * 2.5, y: 0, z: Math.sin(angle) * mass * 2.5 },
        { x: target.object.position.x, y: target.object.position.y + 0.8, z: target.object.position.z },
        true,
      );
    } else {
      target.body.applyImpulse({ x: Math.cos(angle) * mass * speed, y: 0, z: Math.sin(angle) * mass * speed }, true);
      target.body.applyTorqueImpulse({ x: 0, y: (Math.random() - 0.5) * mass * 0.6, z: 0 }, true);
    }

    if (this.buffers.length > 0 && this.sound.context.state === "running") {
      if (this.sound.isPlaying) this.sound.stop();
      this.sound.position.copy(target.object.position);
      this.sound.setBuffer(this.buffers[Math.floor(Math.random() * this.buffers.length)]!);
      this.sound.setVolume(0.8);
      this.sound.play();
    }
  }
}

/** Raclement de pieds de meuble sur la moquette : frottement saccadé (collé-glissé), sourd. */
function createScrapeBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const seconds = 0.5 + Math.random() * 0.6;
  const data = brownNoise(createSamples(sampleRate, seconds + 0.8));
  const stickRate = 18 + Math.random() * 14;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const envelope = t < seconds ? Math.sin((Math.PI * t) / seconds) : 0;
    const stickSlip = 0.4 + 0.6 * Math.abs(Math.sin(Math.PI * stickRate * t + Math.sin(t * 9) * 2));
    data[i] = data[i]! * envelope * stickSlip * 2 + Math.sin(2 * Math.PI * 95 * t) * envelope * stickSlip * 0.2;
  }
  lowpass(data, sampleRate, 900);
  reverb(data, sampleRate, 0.4, 1.5);
  return toBuffer(context, fadeEdges(normalize(data, 0.85), sampleRate, 0.01));
}
