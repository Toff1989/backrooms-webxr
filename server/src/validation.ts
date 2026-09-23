import { CELL_SIZE, PLAYER_MOVE_SPEED } from "../../src/shared/constants.js";
import { getExitWorldPosition } from "../../src/shared/exit.js";
import { createLevelProfile } from "../../src/shared/levelProfile.js";

/**
 * Validation anti-triche (fiche projet étape 7) : régénère le level *sortant* (celui que
 * le joueur vient de quitter) à partir de la seed de run — même code de génération pur
 * que le client (`src/shared/`) — et calcule la distance spawn→sortie en ligne droite.
 * Le temps minimum plausible pour la traverser est `distance / PLAYER_MOVE_SPEED` : c'est
 * une borne physique absolue (le vrai trajet dans un labyrinthe ne peut être QUE plus
 * long que la ligne droite, jamais plus court), donc un temps mesuré en dessous est
 * matériellement impossible — pas une histoire d'heuristique de difficulté.
 */
export function computeMinPlausibleMillis(seed: string, fromDepth: number): number {
  const profile = createLevelProfile(fromDepth, seed);
  const exit = getExitWorldPosition(profile);
  const spawnX = CELL_SIZE / 2;
  const spawnZ = CELL_SIZE / 2;
  const distance = Math.hypot(exit.x - spawnX, exit.z - spawnZ);
  return (distance / PLAYER_MOVE_SPEED) * 1000;
}
