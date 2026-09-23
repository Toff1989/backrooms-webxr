import { get, set } from "idb-keyval";
import type { CollectiblePlacement } from "../shared/chunkLayout";

const STORAGE_KEY = "backrooms-vr:collection";

export interface CollectionEntry {
  id: string;
  kind: CollectiblePlacement["kind"];
  rarity: CollectiblePlacement["rarity"];
  scale: number;
  /** Profondeur du level où l'objet a été trouvé (fait partie du souvenir, pas de la progression courante). */
  depth: number;
  nameFr: string;
  nameEn: string;
  descriptionFr: string;
  descriptionEn: string;
  collectedAt: number;
}

/**
 * Collection persistante (fiche projet étape 6, "Persistance") : seule cette liste
 * survit entre les runs (IndexedDB via `idb-keyval`) — la progression (profondeur,
 * position) repart de zéro à chaque run, voir `LevelManager`. Chargée une fois au
 * démarrage puis tenue à jour en mémoire, pour que le menu poignet n'ait jamais besoin
 * de relire le disque pendant une run.
 */
export class CollectionStore {
  private entries: CollectionEntry[] = [];
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = get<CollectionEntry[]>(STORAGE_KEY)
      .then((stored) => {
        this.entries = stored ?? [];
      })
      .catch(() => {
        this.entries = [];
      });
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  getAll(): readonly CollectionEntry[] {
    return this.entries;
  }

  get count(): number {
    return this.entries.length;
  }

  /** Ajoute une entrée et persiste immédiatement (best-effort : jamais bloquant pour le gameplay si l'écriture échoue). */
  add(entry: CollectionEntry): void {
    this.entries.push(entry);
    void set(STORAGE_KEY, this.entries).catch(() => {});
  }
}

/** Construit l'entrée à persister à partir des infos générées au placement (voir `chunkLayout.ts`) + du contexte de ramassage. */
export function toCollectionEntry(placement: CollectiblePlacement, depth: number): CollectionEntry {
  return {
    id: placement.id,
    kind: placement.kind,
    rarity: placement.rarity,
    scale: placement.scale,
    depth,
    nameFr: placement.nameFr,
    nameEn: placement.nameEn,
    descriptionFr: placement.descriptionFr,
    descriptionEn: placement.descriptionEn,
    collectedAt: Date.now(),
  };
}
