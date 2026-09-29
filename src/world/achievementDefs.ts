import type { TranslationKey } from "../i18n";

/**
 * Définitions des succès : chacun est une simple fonction pure des statistiques cumulées
 * (`AchievementStats`) — aucune condition n'est évaluée côté serveur (voir `server/src/
 * achievements.ts`), qui ne fait que stocker/synchroniser stats et succès débloqués. Le bonus
 * permanent (`perk`) de chaque succès débloqué se cumule dans `computeAchievementPerks`
 * (achievements.ts), fusionné avec les perks de run (voir collectionPerks.ts) dans `applyPerks`.
 */

export type AchievementCategory = "exploration" | "survival" | "collection" | "lore" | "mastery" | "account" | "secret";
/** 1 = facile, 4 = très difficile (juste indicatif, sert au tri/affichage). */
export type AchievementTier = 1 | 2 | 3 | 4;

/** Toutes les statistiques cumulées suivies pour les succès — jamais de "compteur qui recule" :
 * chaque champ ne fait que monter (voir `AchievementTracker.raise` dans achievements.ts). */
export interface AchievementStats {
  depthMax: number;
  deaths: number;
  catches: number;
  victories: number;
  runsEnded: number;
  itemsTotal: number;
  itemsCommon: number;
  itemsRare: number;
  itemsLegendary: number;
  maxItemsHeldInRun: number;
  archivesRead: number;
  archiveStreakLevels: number;
  photosCount: number;
  tapesPlayed: number;
  batteriesPicked: number;
  blackoutsTriggered: number;
  cadreurSightings: number;
  levelsNoDamage: number;
  runsNoFlashlightOff: number;
  reachedDepth10NoBattery: number;
  victoryWithoutPriorDeath: number;
  fastDepth10: number;
  secondDevicePaired: number;
  pseudoChanged: number;
  recoveryCodeRestored: number;
}

export function defaultStats(): AchievementStats {
  return {
    depthMax: 0,
    deaths: 0,
    catches: 0,
    victories: 0,
    runsEnded: 0,
    itemsTotal: 0,
    itemsCommon: 0,
    itemsRare: 0,
    itemsLegendary: 0,
    maxItemsHeldInRun: 0,
    archivesRead: 0,
    archiveStreakLevels: 0,
    photosCount: 0,
    tapesPlayed: 0,
    batteriesPicked: 0,
    blackoutsTriggered: 0,
    cadreurSightings: 0,
    levelsNoDamage: 0,
    runsNoFlashlightOff: 0,
    reachedDepth10NoBattery: 0,
    victoryWithoutPriorDeath: 0,
    fastDepth10: 0,
    secondDevicePaired: 0,
    pseudoChanged: 0,
    recoveryCodeRestored: 0,
  };
}

/**
 * Bonus permanent d'un succès débloqué : mêmes dimensions que les perks de run
 * (collectionPerks.ts), additives — jamais de dimension nouvelle à câbler ailleurs. `cosmetic`
 * documente un bonus non mécanique (juste affiché comme tel dans le menu des succès).
 */
export interface AchievementPerk {
  batteryCapacity?: number;
  sprintRecovery?: number;
  corruptionDecay?: number;
  beaconSteadiness?: number;
  cosmetic?: string;
}

export interface AchievementDefinition {
  id: string;
  category: AchievementCategory;
  tier: AchievementTier;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  condition(stats: Readonly<AchievementStats>): boolean;
  perk?: AchievementPerk;
}

const def = (
  id: string,
  category: AchievementCategory,
  tier: AchievementTier,
  condition: (stats: Readonly<AchievementStats>) => boolean,
  perk?: AchievementPerk,
): AchievementDefinition => ({
  id,
  category,
  tier,
  // Clés ajoutées dans fr.json/en.json (`achv.<id>.title`/`.desc`) pour chaque succès défini
  // ci-dessous : le gabarit n'est pas vérifiable littéralement par TranslationKey (id dynamique),
  // d'où le contournement de type ici plutôt qu'à chaque site d'appel de `t()`.
  titleKey: `achv.${id}.title` as TranslationKey,
  descriptionKey: `achv.${id}.desc` as TranslationKey,
  condition,
  perk,
});

export const ACHIEVEMENTS: AchievementDefinition[] = [
  // Exploration — profondeur atteinte (cumulée, meilleure run).
  def("depth5", "exploration", 1, (s) => s.depthMax >= 5, { batteryCapacity: 0.05 }),
  def("depth10", "exploration", 1, (s) => s.depthMax >= 10, { sprintRecovery: 0.05 }),
  def("depth20", "exploration", 2, (s) => s.depthMax >= 20, { corruptionDecay: 0.05 }),
  def("depth35", "exploration", 3, (s) => s.depthMax >= 35, { batteryCapacity: 0.1 }),
  def("depth50", "exploration", 4, (s) => s.depthMax >= 50, { cosmetic: "vhsTintGold" }),

  // Survie.
  def("firstDeath", "survival", 1, (s) => s.deaths >= 1),
  def("blackoutSurvived", "survival", 1, (s) => s.blackoutsTriggered >= 1, { corruptionDecay: 0.03 }),
  def("cadreurSighted10", "survival", 2, (s) => s.cadreurSightings >= 10, { sprintRecovery: 0.05 }),
  def("levelNoDamage", "survival", 2, (s) => s.levelsNoDamage >= 1),
  def("runNoFlashlightOff", "survival", 2, (s) => s.runsNoFlashlightOff >= 1, { batteryCapacity: 0.05 }),
  def("depth10NoBattery", "survival", 3, (s) => s.reachedDepth10NoBattery >= 1, { batteryCapacity: 0.1 }),

  // Collection.
  def("items10", "collection", 1, (s) => s.itemsTotal >= 10),
  def("items50", "collection", 2, (s) => s.itemsTotal >= 50, { beaconSteadiness: 0.1 }),
  def("items150", "collection", 3, (s) => s.itemsTotal >= 150, { beaconSteadiness: 0.15 }),
  def("allRarities", "collection", 2, (s) => s.itemsCommon >= 1 && s.itemsRare >= 1 && s.itemsLegendary >= 1),
  def("legendaryFound", "collection", 3, (s) => s.itemsLegendary >= 1, { cosmetic: "vhsTintPurple" }),
  def("bagFull20", "collection", 2, (s) => s.maxItemsHeldInRun >= 20),

  // Archives / récit.
  def("archive1", "lore", 1, (s) => s.archivesRead >= 1),
  def("archive8", "lore", 2, (s) => s.archivesRead >= 8),
  def("archiveAll", "lore", 3, (s) => s.archivesRead >= 16, { corruptionDecay: 0.1 }),
  def("archiveStreak5", "lore", 3, (s) => s.archiveStreakLevels >= 5),

  // Maîtrise.
  def("victory", "mastery", 3, (s) => s.victories >= 1, { cosmetic: "vhsTintGreen" }),
  def("victoryNoDeath", "mastery", 4, (s) => s.victoryWithoutPriorDeath >= 1, { cosmetic: "vhsTintRainbow" }),
  def("fastDepth10", "mastery", 3, (s) => s.fastDepth10 >= 1, { sprintRecovery: 0.1 }),
  def("runs10", "mastery", 2, (s) => s.runsEnded >= 10),

  // Compte / social.
  def("paired", "account", 1, (s) => s.secondDevicePaired >= 1),
  def("pseudoChanged", "account", 1, (s) => s.pseudoChanged >= 1),
  def("recoveryCodeUsed", "account", 1, (s) => s.recoveryCodeRestored >= 1),

  // Secrets / fun.
  def("photos20", "secret", 2, (s) => s.photosCount >= 20),
  def("tapes10", "secret", 2, (s) => s.tapesPlayed >= 10),
];

export const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]));
