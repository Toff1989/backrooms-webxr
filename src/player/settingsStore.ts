import { get, set } from "idb-keyval";
import { apiCall, ensureIdentity, onIdentityChange } from "../world/playerIdentity";

/**
 * Réglages du joueur (langue, vignette, sursauts, difficulté) : gardés en IndexedDB comme tout le
 * reste du stockage local, et synchronisés avec le serveur (voir `server/src/settings.ts`) pour
 * suivre le joueur d'un appareil jumelé à l'autre. Le local est la source de vérité ; la plus
 * récente des deux versions fait foi, jamais de fusion champ à champ (comme la sauvegarde de partie).
 *
 * Les lecteurs (langue, difficulté...) sont synchrones : `loadSettings()` doit donc être terminé
 * avant de s'en servir (voir le début de `main.ts`), puis `onSettingsChange` signale un changement
 * venu du serveur.
 */
export type SettingKey = "lang" | "vignette" | "jumpscare" | "difficulty";

const SETTINGS_KEY = "backrooms-vr:settings";

interface StoredSettings {
  data: Partial<Record<SettingKey, string>>;
  updatedAt: number;
}

let current: StoredSettings = { data: {}, updatedAt: 0 };
let pendingWrites = Promise.resolve();
let syncing: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function getSetting(key: SettingKey): string | undefined {
  return current.data[key];
}

/** Enregistre un réglage (local puis serveur en arrière-plan, au mieux). */
export function setSetting(key: SettingKey, value: string): void {
  if (current.data[key] === value) return;
  current = { data: { ...current.data, [key]: value }, updatedAt: Date.now() };
  const snapshot = current;
  pendingWrites = pendingWrites.then(async () => {
    await set(SETTINGS_KEY, snapshot).catch(() => {});
    await pushRemote(snapshot);
  });
}

/** Appelé quand les réglages changent à cause du serveur (autre appareil), pas à chaque `setSetting`. */
export function onSettingsChange(listener: () => void): void {
  listeners.add(listener);
}

export async function loadSettings(): Promise<void> {
  const stored = await get<StoredSettings>(SETTINGS_KEY).catch(() => undefined);
  if (stored?.data) current = stored;
}

/** Réconcilie avec le serveur : le plus récent des deux l'emporte. Sans effet hors ligne. */
export function syncSettings(): Promise<void> {
  syncing ??= (async () => {
    if (!(await ensureIdentity())) return;
    let remote: { data: StoredSettings["data"]; updatedAt: number } | null;
    try {
      remote = await apiCall<{ data: StoredSettings["data"]; updatedAt: number } | null>("GET", "/settings");
    } catch {
      return;
    }
    if (remote && remote.updatedAt > current.updatedAt) {
      current = { data: remote.data, updatedAt: remote.updatedAt };
      await set(SETTINGS_KEY, current).catch(() => {});
      for (const listener of listeners) listener();
    } else if (current.updatedAt > 0) {
      await pushRemote(current);
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function pushRemote(stored: StoredSettings): Promise<void> {
  if (!(await ensureIdentity())) return;
  await apiCall("POST", "/settings", { data: stored.data, updatedAt: stored.updatedAt }).catch(() => {});
}

// Jumelage ou restauration par code : le joueur change, ses réglages (côté serveur) aussi.
onIdentityChange((identity) => {
  if (identity) void syncSettings();
});
