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
const STORAGE_KEY = "backrooms-vr:lang";
const listeners = new Set<() => void>();

function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "fr" || stored === "en") return stored;
  } catch {
    // Stockage indisponible (navigation privée) : langue du navigateur.
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

let current: Language = typeof window === "undefined" ? "fr" : detectLanguage();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Pas grave : la langue ne sera simplement pas mémorisée.
  }
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

/** Fragment n (0-based) du récit des bandes perdues, ou null au-delà du dernier. */
export function loreFragment(index: number): string | null {
  return DICTIONARIES[current]["lore.fragments"][index] ?? null;
}

export const LORE_FRAGMENT_COUNT = fr["lore.fragments"].length;
