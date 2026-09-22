/**
 * Profil de génération d'un level (fiche projet, étape 4 : seed + palette, densité de
 * murs, hauteur plafond, glitchs, textures). La palette/textures par profondeur restent
 * à faire (dépend de l'intégration des textures Poliigon) ; la difficulté progressive
 * couvre pour l'instant la densité de murs, les piliers et la distance de la sortie.
 */
export interface LevelProfile {
  seed: string;
  depth: number;
  /** Probabilité de base [0..1] qu'un bord de cellule porte un mur. */
  wallDensityBase: number;
  /** Poids [0..1] de la variation par bruit simplex (corridors/zones ouvertes organiques). */
  wallDensityNoiseInfluence: number;
  /** Fréquence spatiale du bruit (par cellule). */
  noiseFrequency: number;
  /** Probabilité [0..1] qu'une cellule porte un pilier. */
  pillarProbability: number;
  /** Distance minimale (en cellules) entre le spawn et la sortie de ce level. */
  exitMinDistanceCells: number;
  /** Probabilité [0..1] qu'une cellule porte un piège glitch. */
  glitchProbability: number;
}

/**
 * Seed de la run. Pour l'instant fixe côté client ; la vraie seed aléatoire signée par
 * le serveur (`POST /run/start`) arrive à l'étape 7 (classement + anti-triche).
 */
const RUN_SEED = "backrooms-proto";

const BASE_WALL_DENSITY = 0.24;
const WALL_DENSITY_PER_DEPTH = 0.01;
const MAX_WALL_DENSITY = 0.5;

const BASE_PILLAR_PROBABILITY = 0.04;
const PILLAR_PROBABILITY_PER_DEPTH = 0.005;
const MAX_PILLAR_PROBABILITY = 0.12;

const BASE_EXIT_DISTANCE_CELLS = 10;
const EXIT_DISTANCE_PER_DEPTH = 3;
const MAX_EXIT_DISTANCE_CELLS = 30;

const BASE_GLITCH_PROBABILITY = 0.015;
const GLITCH_PROBABILITY_PER_DEPTH = 0.003;
const MAX_GLITCH_PROBABILITY = 0.08;

/** Construit le profil du level à une profondeur donnée : seed dérivée + difficulté croissante. */
export function createLevelProfile(depth: number): LevelProfile {
  return {
    seed: `${RUN_SEED}:${depth}`,
    depth,
    wallDensityBase: Math.min(MAX_WALL_DENSITY, BASE_WALL_DENSITY + depth * WALL_DENSITY_PER_DEPTH),
    wallDensityNoiseInfluence: 0.3,
    noiseFrequency: 0.12,
    pillarProbability: Math.min(MAX_PILLAR_PROBABILITY, BASE_PILLAR_PROBABILITY + depth * PILLAR_PROBABILITY_PER_DEPTH),
    exitMinDistanceCells: Math.min(MAX_EXIT_DISTANCE_CELLS, BASE_EXIT_DISTANCE_CELLS + depth * EXIT_DISTANCE_PER_DEPTH),
    glitchProbability: Math.min(MAX_GLITCH_PROBABILITY, BASE_GLITCH_PROBABILITY + depth * GLITCH_PROBABILITY_PER_DEPTH),
  };
}
