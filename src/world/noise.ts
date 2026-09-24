/**
 * Bruits faits par le joueur ou ses objets (télé allumée, réveil, canette lancée, vase brisé) :
 * le Cadreur les entend. Un bruit fort l'appelle ; s'il est déjà là, il va voir d'où ça vient
 * — un bruit loin du joueur sert de leurre. `loudness` : 0 (à peine audible) à 1 (alarme).
 */
export interface NoiseEvent {
  x: number;
  z: number;
  loudness: number;
}

type NoiseListener = (event: NoiseEvent) => void;
const listeners = new Set<NoiseListener>();

export function onNoise(listener: NoiseListener): void {
  listeners.add(listener);
}

export function emitNoise(position: { x: number; z: number }, loudness: number): void {
  const event = { x: position.x, z: position.z, loudness: Math.max(0, Math.min(1, loudness)) };
  for (const listener of listeners) listener(event);
}
