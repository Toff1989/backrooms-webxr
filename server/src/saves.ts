import { db } from "./db.js";
// La colonne player_id référence players(id) : s'assurer que cette table existe déjà, plutôt que
// de dépendre de l'ordre d'import du module appelant (import non utilisé, juste pour l'ordre
// d'évaluation — voir la mésaventure similaire de players.ts avec runs/levels de db.ts).
import "./players.js";

/**
 * Sauvegarde de la partie en cours (seed, profondeur, inventaire, santé/folie, batterie,
 * position — voir `src/world/saveManager.ts` côté client, qui garde le détail du contenu en
 * JSON opaque ici). Une seule ligne par joueur : contrairement aux runs (qui s'enchaînent et
 * finissent au classement), il n'y a qu'une seule partie "en cours" à la fois. Le local
 * (IndexedDB) reste la source de vérité pour un seul appareil ; ceci ne sert qu'à synchroniser
 * plusieurs appareils d'un même joueur (jumelage, code de cassette) — la plus récente des deux
 * (`updated_at`) l'emporte, jamais de fusion champ à champ.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS saves (
    player_id TEXT PRIMARY KEY REFERENCES players(id),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export interface SaveRow {
  data: string;
  updated_at: number;
}

const getSaveStmt = db.prepare<{ playerId: string }, SaveRow>(`SELECT data, updated_at FROM saves WHERE player_id = @playerId`);
// La clause WHERE rend l'upsert atomique et sans lecture préalable : si la ligne existante est
// déjà plus récente (un autre appareil vient d'écrire entre-temps), cette écriture est un no-op.
const upsertSaveStmt = db.prepare<{ playerId: string; data: string; updatedAt: number }>(
  `INSERT INTO saves (player_id, data, updated_at) VALUES (@playerId, @data, @updatedAt)
   ON CONFLICT(player_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
   WHERE excluded.updated_at >= saves.updated_at`,
);
const deleteSaveStmt = db.prepare<{ playerId: string }>(`DELETE FROM saves WHERE player_id = @playerId`);

export function getSave(playerId: string): SaveRow | null {
  return getSaveStmt.get({ playerId }) ?? null;
}

export function putSave(playerId: string, data: string, updatedAt: number): void {
  upsertSaveStmt.run({ playerId, data, updatedAt });
}

export function deleteSave(playerId: string): void {
  deleteSaveStmt.run({ playerId });
}

/** Jumelage/code de cassette : la sauvegarde la plus récente des deux appareils l'emporte. */
export function mergeSaves(fromId: string, intoId: string): void {
  const from = getSave(fromId);
  const into = getSave(intoId);
  if (from && (!into || from.updated_at > into.updated_at)) putSave(intoId, from.data, from.updated_at);
  deleteSaveStmt.run({ playerId: fromId });
}
