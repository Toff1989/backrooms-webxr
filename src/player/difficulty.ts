import { getSetting, setSetting } from "./settingsStore";

/**
 * Difficulté : multiplicateurs appliqués aux menaces (Cadreur, folie, zones corrompues) et aux
 * ressources (pile, soin). Elle ne touche pas la génération des niveaux (sortie, archives) : la
 * validation serveur régénère le même monde quelle que soit la difficulté choisie.
 */
export type Difficulty = "easy" | "normal" | "hard";
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];

export interface DifficultyTuning {
  /** Vitesse du Cadreur hors de vue. */
  cadreurSpeed: number;
  /** Dégâts infligés par la proximité du Cadreur. */
  cadreurDamage: number;
  /** Folie gagnée (sursauts, regards, glitchs, coupures). */
  madnessGain: number;
  /** Dégâts des zones corrompues au sol. */
  hazardDamage: number;
  /** Autonomie de la lampe. */
  batteryLife: number;
  /** Recharge d'une pile ramassée. */
  batteryRecharge: number;
  /** Santé rendue par une trousse de soin. */
  heal: number;
}

const TUNING: Record<Difficulty, DifficultyTuning> = {
  easy: { cadreurSpeed: 0.78, cadreurDamage: 0.45, madnessGain: 0.55, hazardDamage: 0.45, batteryLife: 1.6, batteryRecharge: 1.4, heal: 1.5 },
  normal: { cadreurSpeed: 0.9, cadreurDamage: 0.75, madnessGain: 0.8, hazardDamage: 0.75, batteryLife: 1.2, batteryRecharge: 1.1, heal: 1.15 },
  hard: { cadreurSpeed: 1.08, cadreurDamage: 1.1, madnessGain: 1.15, hazardDamage: 1.15, batteryLife: 0.85, batteryRecharge: 0.8, heal: 0.8 },
};

/** Mémorisée avec les autres réglages (IndexedDB + serveur, voir `settingsStore.ts`). */
export function getDifficulty(): Difficulty {
  const stored = getSetting("difficulty");
  return (DIFFICULTIES as readonly string[]).includes(stored ?? "") ? (stored as Difficulty) : "normal";
}

export function setDifficulty(difficulty: Difficulty): void {
  setSetting("difficulty", difficulty);
}

export function tuning(): DifficultyTuning {
  return TUNING[getDifficulty()];
}
