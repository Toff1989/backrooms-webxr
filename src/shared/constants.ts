/**
 * Constantes de la grille du monde, partagées entre la génération (client/serveur)
 * et le rendu. Aucune dépendance three.js ici : ce module doit rester réutilisable
 * tel quel côté serveur pour la validation anti-triche (étape 7 de la roadmap).
 */
export const CELL_SIZE = 2.5;
export const CHUNK_CELLS = 8;
export const CHUNK_SIZE = CELL_SIZE * CHUNK_CELLS;
export const WALL_HEIGHT = 2.7;
export const WALL_THICKNESS = 0.15;
export const PILLAR_SIZE = 0.4;

/** Rayon de streaming en chunks autour du joueur (distance de Chebyshev). */
export const STREAM_RADIUS_CHUNKS = 2;

/** Rayon (en cellules) autour de l'origine du monde toujours dégagé, pour le spawn. */
export const SPAWN_CLEARANCE_CELLS = 2;

/** Rayon (en cellules) autour de la sortie toujours dégagé. */
export const EXIT_CLEARANCE_CELLS = 1;

/** Vitesse de déplacement fluide (m/s, voir `player/locomotion.ts`) — partagée avec la
 * validation anti-triche serveur (étape 7) : borne physique de vitesse max du joueur. */
export const PLAYER_MOVE_SPEED = 2.2;
