import { VIGNETTE_LEVELS, type VignetteLevel } from "./comfortVignette";

/** Intensité des effets de sursaut (capture par le Cadreur) : option pour les personnes sensibles. */
export type JumpscareLevel = "normal" | "reduced" | "off";
export const JUMPSCARE_LEVELS: readonly JumpscareLevel[] = ["normal", "reduced", "off"];

const VIGNETTE_KEY = "backrooms-vr:vignette";
const JUMPSCARE_KEY = "backrooms-vr:jumpscare";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Stockage indisponible : réglage valable pour cette session seulement.
  }
}

/** Les anciennes préférences étaient "on"/"off" : "on" devient le niveau normal. */
export function loadVignetteLevel(): VignetteLevel {
  const stored = read(VIGNETTE_KEY);
  if (stored === "on") return "normal";
  return (VIGNETTE_LEVELS as readonly string[]).includes(stored ?? "") ? (stored as VignetteLevel) : "normal";
}

export function saveVignetteLevel(level: VignetteLevel): void {
  write(VIGNETTE_KEY, level);
}

export function loadJumpscareLevel(): JumpscareLevel {
  const stored = read(JUMPSCARE_KEY);
  return (JUMPSCARE_LEVELS as readonly string[]).includes(stored ?? "") ? (stored as JumpscareLevel) : "normal";
}

export function saveJumpscareLevel(level: JumpscareLevel): void {
  write(JUMPSCARE_KEY, level);
}

export function nextLevel<T>(levels: readonly T[], current: T): T {
  return levels[(levels.indexOf(current) + 1) % levels.length]!;
}
