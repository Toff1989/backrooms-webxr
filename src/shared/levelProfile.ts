/**
 * Profil de génération d'un level (fiche projet, étape 4 : seed + palette, densité de
 * murs, hauteur plafond, glitchs, textures). Pour l'étape 2, un seul profil par défaut
 * couvre un monde infini ; la progression par profondeur arrive à l'étape 4.
 */
export interface LevelProfile {
  seed: string;
  /** Probabilité de base [0..1] qu'un bord de cellule porte un mur. */
  wallDensityBase: number;
  /** Poids [0..1] de la variation par bruit simplex (corridors/zones ouvertes organiques). */
  wallDensityNoiseInfluence: number;
  /** Fréquence spatiale du bruit (par cellule). */
  noiseFrequency: number;
  /** Probabilité [0..1] qu'une cellule porte un pilier. */
  pillarProbability: number;
}

export const DEFAULT_PROFILE: LevelProfile = {
  seed: "backrooms-proto",
  wallDensityBase: 0.24,
  wallDensityNoiseInfluence: 0.3,
  noiseFrequency: 0.12,
  pillarProbability: 0.04,
};
