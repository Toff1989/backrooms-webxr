import { VIGNETTE_LEVELS, type VignetteLevel } from "./comfortVignette";
import { getSetting, setSetting } from "./settingsStore";

/** Intensité des effets de sursaut (capture par le Cadreur) : option pour les personnes sensibles. */
export type JumpscareLevel = "normal" | "reduced" | "off";
export const JUMPSCARE_LEVELS: readonly JumpscareLevel[] = ["normal", "reduced", "off"];

/** Filtre VHS à l'écran (scanlines, grain, neige, perte de tracking) : option pour les personnes sensibles. */
export type VhsFilterLevel = "normal" | "reduced" | "off";
export const VHS_FILTER_LEVELS: readonly VhsFilterLevel[] = ["normal", "reduced", "off"];
/** Force appliquée aux effets VHS par niveau (1 = plein). */
export const VHS_FILTER_STRENGTH: Record<VhsFilterLevel, number> = { normal: 1, reduced: 0.4, off: 0 };

/** Mémorisés avec les autres réglages (IndexedDB + serveur, voir `settingsStore.ts`). */
export function loadVignetteLevel(): VignetteLevel {
  const stored = getSetting("vignette");
  return (VIGNETTE_LEVELS as readonly string[]).includes(stored ?? "") ? (stored as VignetteLevel) : "normal";
}

export function saveVignetteLevel(level: VignetteLevel): void {
  setSetting("vignette", level);
}

export function loadJumpscareLevel(): JumpscareLevel {
  const stored = getSetting("jumpscare");
  return (JUMPSCARE_LEVELS as readonly string[]).includes(stored ?? "") ? (stored as JumpscareLevel) : "normal";
}

export function saveJumpscareLevel(level: JumpscareLevel): void {
  setSetting("jumpscare", level);
}

export function loadVhsFilterLevel(): VhsFilterLevel {
  const stored = getSetting("vhsFilter");
  return (VHS_FILTER_LEVELS as readonly string[]).includes(stored ?? "") ? (stored as VhsFilterLevel) : "normal";
}

export function saveVhsFilterLevel(level: VhsFilterLevel): void {
  setSetting("vhsFilter", level);
}

export function nextLevel<T>(levels: readonly T[], current: T): T {
  return levels[(levels.indexOf(current) + 1) % levels.length]!;
}
