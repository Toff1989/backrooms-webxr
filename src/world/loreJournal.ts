import { get, set } from "idb-keyval";
import { LORE_FRAGMENT_COUNT } from "../shared/lore";
import { fetchProfile, LORE_PROGRESS_KEY, syncLoreCount, type PlayerProfile } from "./playerIdentity";

/**
 * Journal des archives perdues : combien de fragments du récit le joueur a lus (toujours les
 * premiers, dans l'ordre). Permanent, contrairement à l'inventaire/la sauvegarde de run (voir
 * saveManager.ts) qui eux repartent de zéro à chaque nouvelle partie — mais uniformisé avec le
 * même principe local d'abord (IndexedDB), synchronisé par identité en arrière-plan, sans
 * dépendre d'une run active. Le plus avancé des deux (local/serveur) fait foi.
 */
export class LoreJournal {
  private unlocked = 0;
  private profile: PlayerProfile | null = null;
  private readonly listeners = new Set<() => void>();

  /** À attendre avant de construire le premier level : la page posée dépend de la progression. */
  async load(): Promise<void> {
    const stored = await get<number>(LORE_PROGRESS_KEY).catch(() => undefined);
    this.raiseTo(stored ?? 0);
  }

  /** Nombre de bandes lues (fragments 0..count-1). */
  get count(): number {
    return this.unlocked;
  }

  /** Prochaine bande à trouver, ou null si le récit est complet. */
  get nextFragment(): number | null {
    return this.unlocked < LORE_FRAGMENT_COUNT ? this.unlocked : null;
  }

  /** Dernier profil serveur connu (code de cassette, meilleures runs), null hors ligne. */
  get serverProfile(): PlayerProfile | null {
    return this.profile;
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /**
   * Page ramassée : si c'est l'archive attendue, elle entre au journal et part au serveur en
   * arrière-plan (best effort, indépendant de toute run active). Renvoie vrai pour une nouvelle
   * archive, faux si elle était déjà lue.
   */
  read(fragment: number): boolean {
    if (fragment !== this.unlocked || fragment >= LORE_FRAGMENT_COUNT) return false;
    this.raiseTo(fragment + 1);
    syncLoreCount(this.unlocked)
      .then((serverCount) => {
        if (serverCount !== null) this.raiseTo(serverCount);
      })
      .catch(() => {});
    return true;
  }

  /** Relit le profil serveur (au démarrage, à l'ouverture du journal, après un jumelage). */
  async sync(): Promise<PlayerProfile | null> {
    const profile = await fetchProfile();
    if (profile) {
      this.profile = profile;
      this.raiseTo(profile.loreCount);
      this.emit();
    }
    return profile;
  }

  private raiseTo(count: number): void {
    const next = Math.min(LORE_FRAGMENT_COUNT, Math.max(this.unlocked, count));
    if (next === this.unlocked) return;
    this.unlocked = next;
    void set(LORE_PROGRESS_KEY, next).catch(() => {});
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
