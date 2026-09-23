import { get, set } from "idb-keyval";

const STORAGE_KEY = "backrooms-vr:playerId";

/** Identifiant anonyme persistant (fiche projet étape 7 : "ID anonyme généré au premier lancement, stocké en IndexedDB"). */
export async function getPlayerId(): Promise<string> {
  const existing = await get<string>(STORAGE_KEY).catch(() => undefined);
  if (existing) return existing;

  const id = crypto.randomUUID();
  await set(STORAGE_KEY, id).catch(() => {});
  return id;
}
