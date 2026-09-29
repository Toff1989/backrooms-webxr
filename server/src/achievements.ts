import { db } from "./db.js";
// Même mésaventure d'ordre d'import que saves.ts/lore_unlocks : s'assurer que players(id) existe déjà.
import "./players.js";

/**
 * Statistiques cumulées (voir `src/world/achievementStats.ts` côté client, qui définit les clés
 * connues) et succès débloqués — jamais de logique de condition ici, seulement le stockage et la
 * synchro par identité : le client évalue ses ~30 succès localement à partir des statistiques, et
 * pousse ici le résultat. Même principe que les archives (`lore_unlocks`) : "le plus avancé des
 * deux fait foi", une statistique ne peut jamais reculer, un succès débloqué ne se reverrouille
 * jamais.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS player_stats (
    player_id TEXT NOT NULL REFERENCES players(id),
    key TEXT NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (player_id, key)
  );

  CREATE TABLE IF NOT EXISTS achievements_unlocked (
    player_id TEXT NOT NULL REFERENCES players(id),
    achievement_id TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, achievement_id)
  );
`);

const statsStmt = db.prepare<{ playerId: string }, { key: string; value: number }>(`SELECT key, value FROM player_stats WHERE player_id = @playerId`);
// La clause WHERE rend l'upsert atomique et sans lecture préalable, comme pour `saves.ts` :
// jamais de valeur qui recule, même si deux appareils poussent en même temps.
const raiseStatStmt = db.prepare<{ playerId: string; key: string; value: number }>(
  `INSERT INTO player_stats (player_id, key, value) VALUES (@playerId, @key, @value)
   ON CONFLICT(player_id, key) DO UPDATE SET value = excluded.value WHERE excluded.value > player_stats.value`,
);
const deleteStatsStmt = db.prepare<{ playerId: string }>(`DELETE FROM player_stats WHERE player_id = @playerId`);

const unlockedStmt = db.prepare<{ playerId: string }, { achievement_id: string }>(
  `SELECT achievement_id FROM achievements_unlocked WHERE player_id = @playerId`,
);
const insertUnlockedStmt = db.prepare<{ playerId: string; achievementId: string; at: number }>(
  `INSERT OR IGNORE INTO achievements_unlocked (player_id, achievement_id, unlocked_at) VALUES (@playerId, @achievementId, @at)`,
);
const deleteUnlockedStmt = db.prepare<{ playerId: string }>(`DELETE FROM achievements_unlocked WHERE player_id = @playerId`);

export function getStats(playerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of statsStmt.all({ playerId })) out[row.key] = row.value;
  return out;
}

export function getUnlockedAchievements(playerId: string): string[] {
  return unlockedStmt.all({ playerId }).map((row) => row.achievement_id);
}

/**
 * Fusionne les statistiques et succès envoyés par le client avec ceux déjà connus (le plus
 * avancé des deux fait foi, comme `raiseLoreCount`) et renvoie l'état canonique résultant — le
 * client s'aligne dessus (utile si un autre appareil jumelé a progressé plus loin).
 */
export const syncAchievements = db.transaction(
  (playerId: string, stats: Record<string, number>, unlockedIds: string[]): { stats: Record<string, number>; unlockedIds: string[] } => {
    const now = Date.now();
    for (const [key, value] of Object.entries(stats)) raiseStatStmt.run({ playerId, key, value });
    for (const achievementId of unlockedIds) insertUnlockedStmt.run({ playerId, achievementId, at: now });
    return { stats: getStats(playerId), unlockedIds: getUnlockedAchievements(playerId) };
  },
);

/** Réinitialisation depuis les paramètres ("recommencer à zéro") : voir `resetLore`/`deleteSave`. */
export function resetAchievements(playerId: string): void {
  deleteStatsStmt.run({ playerId });
  deleteUnlockedStmt.run({ playerId });
}

/**
 * Jumelage/code de cassette : les statistiques du joueur source montent celles du joueur cible
 * (max par clé, comme `raiseStatStmt`), les succès débloqués s'ajoutent (union) — jamais de perte
 * de progression en fusionnant deux appareils d'un même joueur.
 */
export function mergeAchievements(fromId: string, intoId: string): void {
  for (const [key, value] of Object.entries(getStats(fromId))) raiseStatStmt.run({ playerId: intoId, key, value });
  const now = Date.now();
  for (const achievementId of getUnlockedAchievements(fromId)) insertUnlockedStmt.run({ playerId: intoId, achievementId, at: now });
  deleteStatsStmt.run({ playerId: fromId });
  deleteUnlockedStmt.run({ playerId: fromId });
}
