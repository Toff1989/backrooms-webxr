import { del, get, set } from "idb-keyval";
import type { CollectionEntry } from "./collection";
import { apiCall, ensureIdentity } from "./playerIdentity";

const SAVE_KEY = "backrooms-vr:save";

export interface SaveData {
  seed: string;
  depth: number;
  take: number;
  health: number;
  madness: number;
  flashlightBattery: number;
  position: { x: number; z: number };
  inventory: CollectionEntry[];
}

interface StoredSave extends SaveData {
  updatedAt: number;
}

/**
 * Sauvegarde de la partie en cours (seed, profondeur, inventaire, santé/folie, batterie,
 * position) : gardée en local (IndexedDB, source de vérité — même pattern que
 * `playerIdentity.ts`/`loreJournal.ts`), synchronisée en arrière-plan avec le serveur pour la
 * retrouver sur un autre appareil jumelé (voir `server/src/saves.ts`) — la plus récente des deux
 * fait foi, jamais de fusion champ à champ (comme le code de cassette pour l'identité).
 */
export class SaveManager {
  private current: StoredSave | null = null;

  /** À appeler avant de décider de reprendre une partie ou d'en démarrer une neuve. */
  async load(): Promise<SaveData | null> {
    const local = (await get<StoredSave>(SAVE_KEY).catch(() => undefined)) ?? null;
    this.current = local;
    const remote = await this.fetchRemote();
    if (remote && (!local || remote.updatedAt > local.updatedAt)) {
      this.current = remote;
      void set(SAVE_KEY, remote).catch(() => {});
    } else if (local) {
      // Local plus avancé (ou serveur injoignable) : on le pousse, au cas où le serveur aurait
      // encore une version périmée (ou rien du tout, premier appareil jumelé).
      void this.pushRemote(local);
    }
    return this.current;
  }

  /** Dernière sauvegarde connue (après `load()`), sans relire le serveur. */
  get(): SaveData | null {
    return this.current;
  }

  /** Écrase la sauvegarde locale et la pousse au serveur en arrière-plan (best effort). */
  save(data: SaveData): void {
    const stored: StoredSave = { ...data, updatedAt: Date.now() };
    this.current = stored;
    void set(SAVE_KEY, stored).catch(() => {});
    void this.pushRemote(stored);
  }

  /** Partie terminée (game over ou STOP REC) : plus rien à reprendre. */
  clear(): void {
    this.current = null;
    void del(SAVE_KEY).catch(() => {});
    void ensureIdentity().then((identity) => {
      if (identity) void apiCall("POST", "/save/clear", {}).catch(() => {});
    });
  }

  private async fetchRemote(): Promise<StoredSave | null> {
    if (!(await ensureIdentity())) return null;
    try {
      const result = await apiCall<{ data: SaveData; updatedAt: number } | null>("GET", "/save");
      return result ? { ...result.data, updatedAt: result.updatedAt } : null;
    } catch {
      return null;
    }
  }

  private async pushRemote(stored: StoredSave): Promise<void> {
    if (!(await ensureIdentity())) return;
    const { updatedAt, ...data } = stored;
    await apiCall("POST", "/save", { data, updatedAt }).catch(() => {});
  }
}
