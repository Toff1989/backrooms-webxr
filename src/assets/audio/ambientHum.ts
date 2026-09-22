import * as THREE from "three";

const HUM_VOLUME = 0.12;
const BUFFER_DURATION_SECONDS = 2;

/**
 * Bourdonnement ambiant des néons : généré procéduralement (pas de fichier audio externe
 * pour l'instant, en attendant le pipeline d'assets audio de la fiche projet).
 */
export class AmbientHum {
  private readonly sound: THREE.Audio;
  private started = false;

  constructor(private readonly listener: THREE.AudioListener) {
    this.sound = new THREE.Audio(listener);
    this.sound.setBuffer(createHumBuffer(listener.context));
    this.sound.setLoop(true);
    this.sound.setVolume(HUM_VOLUME);
  }

  /**
   * À appeler suite à un geste utilisateur (ex. entrée en session XR) : les navigateurs
   * bloquent la lecture audio automatique hors interaction utilisateur.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.listener.context.state === "suspended") {
      this.listener.context.resume().catch(() => {});
    }
    this.sound.play();
  }
}

function createHumBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * BUFFER_DURATION_SECONDS);
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const hum = Math.sin(2 * Math.PI * 60 * t) * 0.4 + Math.sin(2 * Math.PI * 121 * t) * 0.15;
    const hiss = (Math.random() * 2 - 1) * 0.03;
    data[i] = (hum + hiss) * 0.5;
  }

  return buffer;
}
