import { del } from "idb-keyval";
import type { CollectiblePlacement } from "../shared/chunkLayout";

/** Anciennes clés : l'inventaire était conservé d'une run à l'autre (effacées au lancement). */
const LEGACY_KEYS = ["backrooms-vr:collection", "backrooms-vr:manual-order"];

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

export type CollectionSortMode = "recent" | "rarity" | "depth" | "name";
export const SORT_MODES: CollectionSortMode[] = ["recent", "rarity", "depth", "name"];

/**
 * Inventaire de la run : ce que le joueur a rangé pendant la partie en cours. Il est vidé à
 * chaque début de partie (`clear`) ; les bandes perdues ont leur propre journal, indépendant
 * (voir `loreJournal.ts`). Un objet sorti de
 * l'inventaire (en main, puis posé/jeté dans le monde) n'en fait plus partie tant qu'il n'y
 * est pas remis : laissé au sol quand on change de level, il est perdu.
 */
export class CollectionStore {
  private entries: CollectionEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor() {
    for (const key of LEGACY_KEYS) void del(key).catch(() => {});
  }

  getAll(): readonly CollectionEntry[] {
    return this.entries;
  }

  get count(): number {
    return this.entries.length;
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id);
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Début de partie : inventaire vide. */
  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.emit();
  }

  /** Range un objet ; `index` : case précise où le poser (lâché sur une case), sinon en tête. */
  add(entry: CollectionEntry, index: number | null = null): void {
    if (this.has(entry.id)) return;
    const stored = { ...entry, collectedAt: entry.collectedAt || Date.now() };
    // Par défaut en tête de l'inventaire ; lâché sur une case : à cette place.
    if (index === null) this.entries.unshift(stored);
    else this.entries.splice(Math.min(Math.max(0, index), this.entries.length), 0, stored);
    this.emit();
  }

  /** Déplace l'objet d'index `from` à l'index `to` (réorganisation manuelle de l'inventaire). */
  move(from: number, to: number): void {
    if (from === to || from < 0 || from >= this.entries.length) return;
    const [entry] = this.entries.splice(from, 1);
    if (!entry) return;
    this.entries.splice(Math.min(Math.max(0, to), this.entries.length), 0, entry);
    this.emit();
  }

  /** Trie tout l'inventaire (l'ordre obtenu reste modifiable à la main). */
  sort(mode: CollectionSortMode): void {
    const rarityRank = { legendary: 0, rare: 1, common: 2 } as const;
    const compare: Record<CollectionSortMode, (a: CollectionEntry, b: CollectionEntry) => number> = {
      recent: (a, b) => b.collectedAt - a.collectedAt,
      rarity: (a, b) => rarityRank[a.rarity] - rarityRank[b.rarity] || b.collectedAt - a.collectedAt,
      depth: (a, b) => b.depth - a.depth || b.collectedAt - a.collectedAt,
      name: (a, b) => a.nameFr.localeCompare(b.nameFr),
    };
    this.entries.sort(compare[mode]);
    this.emit();
  }

  /** Retire (sort de l'inventaire) et renvoie l'entrée, pour la reposer telle quelle si elle y revient. */
  remove(id: string): CollectionEntry | null {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [entry] = this.entries.splice(index, 1);
    this.emit();
    return entry ?? null;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Données d'inventaire d'un objet trouvé dans le monde (horodatage posé au rangement). */
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
    collectedAt: 0,
  };
}
