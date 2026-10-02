import { VIGNETTE_LEVELS, type VignetteLevel } from "./comfortVignette";
import { getSetting, setSetting } from "./settingsStore";

/** Intensité des effets de sursaut (capture par le Cadreur) : option pour les personnes sensibles. */
export type JumpscareLevel = "normal" | "reduced" | "off";
export const JUMPSCARE_LEVELS: readonly JumpscareLevel[] = ["normal", "reduced", "off"];

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

export function nextLevel<T>(levels: readonly T[], current: T): T {
  return levels[(levels.indexOf(current) + 1) % levels.length]!;
}
