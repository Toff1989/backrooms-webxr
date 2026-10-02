import { db } from "./db.js";
// player_id référence players(id) : voir la remarque équivalente dans saves.ts.
import "./players.js";

/**
 * Réglages du joueur (langue, vignette, sursauts, difficulté) et photos développées des polaroïds
 * (archives perdues) : synchronisés entre les appareils d'un même joueur. Le contenu des réglages
 * est un JSON opaque ; la plus récente écriture (`updated_at`) l'emporte, jamais de fusion champ à
 * champ. Les photos sont des JPEG en data URL, une par fragment.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    player_id TEXT PRIMARY KEY REFERENCES players(id),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lore_photos (
    player_id TEXT NOT NULL REFERENCES players(id),
    fragment INTEGER NOT NULL,
    image TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, fragment)
  );
`);

export interface SettingsRow {
  data: string;
  updated_at: number;
}

const getSettingsStmt = db.prepare<{ playerId: string }, SettingsRow>(`SELECT data, updated_at FROM settings WHERE player_id = @playerId`);
const upsertSettingsStmt = db.prepare<{ playerId: string; data: string; updatedAt: number }>(
  `INSERT INTO settings (player_id, data, updated_at) VALUES (@playerId, @data, @updatedAt)
   ON CONFLICT(player_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
   WHERE excluded.updated_at >= settings.updated_at`,
);
const deleteSettingsStmt = db.prepare<{ playerId: string }>(`DELETE FROM settings WHERE player_id = @playerId`);

export function getSettings(playerId: string): SettingsRow | null {
  return getSettingsStmt.get({ playerId }) ?? null;
}

export function putSettings(playerId: string, data: string, updatedAt: number): void {
  upsertSettingsStmt.run({ playerId, data, updatedAt });
}

export interface PhotoRow {
  fragment: number;
  image: string;
  updated_at: number;
}

const listPhotosStmt = db.prepare<{ playerId: string }, PhotoRow>(`SELECT fragment, image, updated_at FROM lore_photos WHERE player_id = @playerId ORDER BY fragment`);
const upsertPhotoStmt = db.prepare<{ playerId: string; fragment: number; image: string; updatedAt: number }>(
  `INSERT INTO lore_photos (player_id, fragment, image, updated_at) VALUES (@playerId, @fragment, @image, @updatedAt)
   ON CONFLICT(player_id, fragment) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at
   WHERE excluded.updated_at >= lore_photos.updated_at`,
);
const deletePhotosStmt = db.prepare<{ playerId: string }>(`DELETE FROM lore_photos WHERE player_id = @playerId`);

export function listPhotos(playerId: string): PhotoRow[] {
  return listPhotosStmt.all({ playerId });
}

export function putPhoto(playerId: string, fragment: number, image: string, updatedAt: number): void {
  upsertPhotoStmt.run({ playerId, fragment, image, updatedAt });
}

/** Réinitialisation de la progression : les photos vont avec les archives, pas les réglages. */
export function deletePhotos(playerId: string): void {
  deletePhotosStmt.run({ playerId });
}

/** Jumelage/code de cassette : réglages les plus récents et photos les plus récentes l'emportent. */
export const mergeSettingsAndPhotos = db.transaction((fromId: string, intoId: string): void => {
  const from = getSettings(fromId);
  const into = getSettings(intoId);
  if (from && (!into || from.updated_at > into.updated_at)) putSettings(intoId, from.data, from.updated_at);
  deleteSettingsStmt.run({ playerId: fromId });
  for (const photo of listPhotos(fromId)) putPhoto(intoId, photo.fragment, photo.image, photo.updated_at);
  deletePhotos(fromId);
});
