import * as THREE from "three";

const VOICES = 4;

/**
 * Petit groupe de voix 3D partagées pour les sons ponctuels du monde (murs-pièges...). Avant,
 * chaque mur-piège possédait sa propre PositionalAudio : des centaines de nœuds de
 * spatialisation HRTF branchés en permanence sur 25 chunks — trop pour le thread audio du
 * Quest (son haché ou muet). Ici : 4 voix, réutilisées à tour de rôle.
 */
class WorldSound {
  private readonly voices: THREE.PositionalAudio[] = [];
  private next = 0;

  init(scene: THREE.Scene, listener: THREE.AudioListener): void {
    if (this.voices.length > 0) return;
    for (let i = 0; i < VOICES; i++) {
      const voice = new THREE.PositionalAudio(listener);
      voice.setRefDistance(2);
      voice.setMaxDistance(14);
      scene.add(voice);
      this.voices.push(voice);
    }
  }

  playAt(buffer: AudioBuffer, position: THREE.Vector3, volume: number): void {
    const voice = this.voices[this.next];
    if (!voice || voice.context.state !== "running") return;
    this.next = (this.next + 1) % this.voices.length;
    if (voice.isPlaying) voice.stop();
    voice.position.copy(position);
    voice.setBuffer(buffer);
    voice.setLoop(false);
    voice.setVolume(volume);
    voice.play();
  }
}

export const worldSound = new WorldSound();
