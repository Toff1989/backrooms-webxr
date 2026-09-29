import { get, set } from "idb-keyval";
import { ACHIEVEMENTS, defaultStats, type AchievementDefinition, type AchievementPerk, type AchievementStats } from "./achievementDefs";
import { apiCall, ensureIdentity } from "./playerIdentity";

const STATS_KEY = "backrooms-vr:achievement-stats";
const UNLOCKED_KEY = "backrooms-vr:achievements-unlocked";

export interface AchievementPerks {
  batteryCapacity: number;
  sprintRecovery: number;
  corruptionDecay: number;
  beaconSteadiness: number;
}

/**
 * Succès : ~30 défis permanents (voir achievementDefs.ts), évalués localement à partir de
 * statistiques cumulées — jamais de logique de condition côté serveur, qui ne fait que stocker
 * et synchroniser (voir server/src/achievements.ts). Même principe local d'abord que les
 * archives/la sauvegarde : IndexedDB en source de vérité, synchro par identité en arrière-plan,
 * "le plus avancé des deux fait foi" par statistique — une statistique ne recule jamais, un
 * succès débloqué ne se reverrouille jamais.
 */
export class AchievementTracker {
  private stats: AchievementStats = defaultStats();
  private unlocked = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly unlockListeners = new Set<(def: AchievementDefinition) => void>();

  /** À appeler au démarrage, avant toute instrumentation (sinon les premiers événements repartiraient de zéro). */
  async load(): Promise<void> {
    const storedStats = await get<AchievementStats>(STATS_KEY).catch(() => undefined);
    const storedUnlocked = await get<string[]>(UNLOCKED_KEY).catch(() => undefined);
    if (storedStats) this.stats = { ...defaultStats(), ...storedStats };
    if (storedUnlocked) this.unlocked = new Set(storedUnlocked);
    this.evaluate();
  }

  get all(): ReadonlyArray<{ def: AchievementDefinition; unlocked: boolean }> {
    return ACHIEVEMENTS.map((def) => ({ def, unlocked: this.unlocked.has(def.id) }));
  }

  get unlockedCount(): number {
    return this.unlocked.size;
  }

  get unlockedIds(): ReadonlySet<string> {
    return this.unlocked;
  }

  /** Valeur actuelle d'une statistique (pour une condition qui dépend de "avant cet événement"). */
  get(key: keyof AchievementStats): number {
    return this.stats[key];
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Un nouveau succès vient d'être débloqué (notification HUD, voir main.ts). */
  onUnlock(listener: (def: AchievementDefinition) => void): void {
    this.unlockListeners.add(listener);
  }

  /** Ne fait jamais reculer une statistique — cumulée d'une run à l'autre, comme les archives. */
  raise(key: keyof AchievementStats, value: number): void {
    if (value <= this.stats[key]) return;
    this.stats = { ...this.stats, [key]: value };
    this.evaluate();
    this.persistLocal();
    void this.pushRemote();
  }

  /** Incrémente d'une unité (raccourci pour les compteurs simples). */
  bump(key: keyof AchievementStats, by = 1): void {
    this.raise(key, this.stats[key] + by);
  }

  /**
   * Remise à zéro locale (paramètres, "recommencer à zéro") : l'appel serveur qui efface
   * réellement (voir /player/reset-progress) fait partie du même flux, à part.
   */
  reset(): void {
    this.stats = defaultStats();
    this.unlocked = new Set();
    void set(STATS_KEY, this.stats).catch(() => {});
    void set(UNLOCKED_KEY, []).catch(() => {});
    this.emit();
  }

  /** Relit/pousse l'état serveur (au démarrage, après un jumelage) : le plus avancé des deux fait foi. */
  async sync(): Promise<void> {
    if (!(await ensureIdentity())) return;
    try {
      const result = await apiCall<{ stats: Record<string, number>; unlockedIds: string[] }>("POST", "/achievements/sync", {
        stats: this.stats,
        unlockedIds: [...this.unlocked],
      });
      for (const [key, value] of Object.entries(result.stats)) {
        if (key in this.stats) this.raiseQuiet(key as keyof AchievementStats, value);
      }
      for (const id of result.unlockedIds) this.unlocked.add(id);
      this.evaluate();
      this.persistLocal();
    } catch {
      // Hors ligne : l'état local (déjà évalué) reste valable, on réessaiera au prochain sync.
    }
  }

  private raiseQuiet(key: keyof AchievementStats, value: number): void {
    if (value > this.stats[key]) this.stats = { ...this.stats, [key]: value };
  }

  private persistLocal(): void {
    void set(STATS_KEY, this.stats).catch(() => {});
    void set(UNLOCKED_KEY, [...this.unlocked]).catch(() => {});
  }

  private async pushRemote(): Promise<void> {
    if (!(await ensureIdentity())) return;
    await apiCall("POST", "/achievements/sync", { stats: this.stats, unlockedIds: [...this.unlocked] }).catch(() => {});
  }

  private evaluate(): void {
    let changed = false;
    for (const definition of ACHIEVEMENTS) {
      if (this.unlocked.has(definition.id) || !definition.condition(this.stats)) continue;
      this.unlocked.add(definition.id);
      changed = true;
      for (const listener of this.unlockListeners) listener(definition);
    }
    if (changed) this.persistLocal();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const PERK_CAPS: AchievementPerks = { batteryCapacity: 0.4, sprintRecovery: 0.3, corruptionDecay: 0.3, beaconSteadiness: 0.3 };

/**
 * Bonus permanents cumulés de tous les succès débloqués — fusionnés dans `applyPerks` (main.ts)
 * avec les perks de run (voir collectionPerks.ts). Plafonnés à part des perks de run : un joueur
 * très avancé en succès ne doit pas dépasser ce qu'un inventaire chargé apporte déjà à lui seul.
 */
export function computeAchievementPerks(unlockedIds: ReadonlySet<string>): AchievementPerks {
  const perks: AchievementPerks = { batteryCapacity: 0, sprintRecovery: 0, corruptionDecay: 0, beaconSteadiness: 0 };
  for (const definition of ACHIEVEMENTS) {
    if (!unlockedIds.has(definition.id) || !definition.perk) continue;
    const perk: AchievementPerk = definition.perk;
    perks.batteryCapacity += perk.batteryCapacity ?? 0;
    perks.sprintRecovery += perk.sprintRecovery ?? 0;
    perks.corruptionDecay += perk.corruptionDecay ?? 0;
    perks.beaconSteadiness += perk.beaconSteadiness ?? 0;
  }
  perks.batteryCapacity = Math.min(perks.batteryCapacity, PERK_CAPS.batteryCapacity);
  perks.sprintRecovery = Math.min(perks.sprintRecovery, PERK_CAPS.sprintRecovery);
  perks.corruptionDecay = Math.min(perks.corruptionDecay, PERK_CAPS.corruptionDecay);
  perks.beaconSteadiness = Math.min(perks.beaconSteadiness, PERK_CAPS.beaconSteadiness);
  return perks;
}
