import { LORE_FRAGMENT_COUNT } from "../shared/lore";
import { getSetting, onSettingsChange, setSetting } from "../player/settingsStore";
import en from "./en.json";
import fr from "./fr.json";

/**
 * Traductions FR/EN (fiche projet : "Langues : français + anglais (UI et lore)"). Langue du
 * navigateur par défaut, modifiable dans les options ou le menu d'inventaire, mémorisée
 * localement. Les panneaux 3D (HUD, menus) se redessinent via `onLanguageChange`.
 */
export type Language = "fr" | "en";
type Dictionary = typeof fr;
export type TranslationKey = { [K in keyof Dictionary]: Dictionary[K] extends string ? K : never }[keyof Dictionary];

const DICTIONARIES: Record<Language, Dictionary> = { fr, en };
const listeners = new Set<() => void>();

/** Langue mémorisée (IndexedDB, voir `settingsStore.ts`), sinon celle du navigateur. */
function detectLanguage(): Language {
  const stored = getSetting("lang");
  if (stored === "fr" || stored === "en") return stored;
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

let current: Language = typeof window === "undefined" ? "fr" : detectLanguage();

/**
 * Les réglages se chargent après l'évaluation de ce module (IndexedDB est asynchrone) : à appeler
 * une fois `loadSettings()` terminé, et automatiquement quand le serveur apporte une autre langue.
 */
export function applyStoredLanguage(): void {
  const language = detectLanguage();
  if (language === current) return;
  current = language;
  document.documentElement.lang = language;
  for (const listener of listeners) listener();
}
onSettingsChange(applyStoredLanguage);

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  setSetting("lang", language);
  document.documentElement.lang = language;
  for (const listener of listeners) listener();
}

export function onLanguageChange(listener: () => void): void {
  listeners.add(listener);
}

/** Texte traduit, avec remplacement des `{variables}`. */
export function t(key: TranslationKey, variables: Record<string, string | number> = {}): string {
  const template = DICTIONARIES[current][key] as string;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name] ?? `{${name}}`));
}

type ListKey = { [K in keyof Dictionary]: Dictionary[K] extends string[] ? K : never }[keyof Dictionary];

/** Liste de textes traduits (messages à la craie, notes de production...). */
export function tList(key: ListKey): readonly string[] {
  return DICTIONARIES[current][key] as string[];
}

/** Fragment n (0-based) du récit des archives perdues, ou null au-delà du dernier. */
export function loreFragment(index: number): string | null {
  return DICTIONARIES[current]["lore.fragments"][index] ?? null;
}

if (fr["lore.fragments"].length !== LORE_FRAGMENT_COUNT || en["lore.fragments"].length !== LORE_FRAGMENT_COUNT) {
  throw new Error(`Archives perdues : ${LORE_FRAGMENT_COUNT} fragments attendus dans chaque langue`);
}
