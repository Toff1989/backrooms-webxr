import * as THREE from "three";
import { getSetting, onSettingsChange, setSetting, type SettingKey } from "../player/settingsStore";

/**
 * Mixage : un volume général et quatre canaux réglables dans les paramètres. Chaque canal est un
 * `AudioListener` de service (non placé dans la scène) dont la sortie passe par le volume général :
 * les sons y sont branchés comme sur le listener principal, sans que leur code ait à connaître les
 * réglages. Les volumes se règlent en pourcentage, par pas de `VOLUME_STEP`.
 */
export type VolumeChannel = "master" | "music" | "ambient" | "effects" | "threats";
export const VOLUME_CHANNELS: readonly VolumeChannel[] = ["master", "music", "ambient", "effects", "threats"];
export const VOLUME_STEP = 10;

/** Volumes de départ : volontairement bas, le jeu se joue au casque, de près. */
const DEFAULT_VOLUME: Record<VolumeChannel, number> = { master: 60, music: 50, ambient: 70, effects: 80, threats: 80 };
const SETTING_KEY: Record<VolumeChannel, SettingKey> = {
  master: "volMaster",
  music: "volMusic",
  ambient: "volAmbient",
  effects: "volEffects",
  threats: "volThreats",
};

/** Volume d'un canal, en pourcentage [0..100]. */
export function getVolume(channel: VolumeChannel): number {
  const stored = Number(getSetting(SETTING_KEY[channel]));
  return Number.isFinite(stored) && getSetting(SETTING_KEY[channel]) !== undefined ? Math.min(100, Math.max(0, Math.round(stored))) : DEFAULT_VOLUME[channel];
}

export function setVolume(channel: VolumeChannel, percent: number): void {
  const clamped = Math.min(100, Math.max(0, Math.round(percent / VOLUME_STEP) * VOLUME_STEP));
  setSetting(SETTING_KEY[channel], String(clamped));
  for (const mixer of mixers) mixer.apply();
}

const mixers = new Set<AudioMixer>();

export class AudioMixer {
  readonly music: THREE.AudioListener;
  readonly ambient: THREE.AudioListener;
  readonly effects: THREE.AudioListener;
  readonly threats: THREE.AudioListener;

  constructor(private readonly master: THREE.AudioListener) {
    this.music = this.createBus();
    this.ambient = this.createBus();
    this.effects = this.createBus();
    this.threats = this.createBus();
    mixers.add(this);
    onSettingsChange(() => this.apply());
    this.apply();
  }

  /** Canal secondaire : sa sortie passe par le volume général au lieu d'aller droit aux haut-parleurs. */
  private createBus(): THREE.AudioListener {
    const bus = new THREE.AudioListener();
    bus.gain.disconnect();
    bus.gain.connect(this.master.getInput());
    return bus;
  }

  /** Relit les réglages et les applique aux gains. */
  apply(): void {
    this.master.setMasterVolume(getVolume("master") / 100);
    this.music.setMasterVolume(getVolume("music") / 100);
    this.ambient.setMasterVolume(getVolume("ambient") / 100);
    this.effects.setMasterVolume(getVolume("effects") / 100);
    this.threats.setMasterVolume(getVolume("threats") / 100);
  }
}
