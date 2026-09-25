import { CELL_SIZE, SPAWN_CLEARANCE_CELLS, EXIT_CLEARANCE_CELLS } from "./constants.js";
import { getExitLocation } from "./exit.js";
import type { LevelProfile } from "./levelProfile.js";
import { coordinateHash01, stringSeedToInt } from "./rng.js";

/**
 * Bandes perdues : un récit en fragments numérotés, lus dans l'ordre d'une run à l'autre. Le
 * texte vit dans les traductions (`src/i18n`) ; le serveur n'a besoin que du nombre.
 */
export const LORE_FRAGMENT_COUNT = 16;

/**
 * Forme d'une bande : note manuscrite, fiche de montage (bobine, plan, time-code),
 * photo polaroid (développée au ramassage), ou cassette audio (grésillement + transcription).
 */
export type LoreFormat = "journal" | "fiche" | "polaroid" | "audio";

export interface LoreFragmentMeta {
  format: LoreFormat;
  /** Fiche de montage : références du rush (identiques dans toutes les langues). */
  reel?: number;
  shot?: string;
  timecode?: string;
  /** Le plan en entier, sans coupe (dernière bande). */
  full?: boolean;
}

/**
 * Récit générique, sans personnage nommé ni incident précis : des fragments anonymes laissés
 * par d'autres explorateurs des Backrooms, sous forme de notes, fiches, photos et cassettes.
 */
export const LORE_FRAGMENTS: readonly LoreFragmentMeta[] = [
  { format: "journal" },
  { format: "fiche", reel: 1, shot: "6", timecode: "00:41:12:03" },
  { format: "journal" },
  { format: "polaroid" },
  { format: "audio" },
  { format: "fiche", reel: 4, shot: "14B", timecode: "01:12:44:08" },
  { format: "journal" },
  { format: "polaroid" },
  { format: "fiche", reel: 4, shot: "14C", timecode: "01:13:02:17" },
  { format: "audio" },
  { format: "journal" },
  { format: "polaroid" },
  { format: "fiche", reel: 4, shot: "14D", timecode: "01:13:40:00" },
  { format: "audio" },
  { format: "journal" },
  { format: "fiche", reel: 4, shot: "14", timecode: "01:11:58:00", full: true },
];

export function loreFormat(fragment: number): LoreFormat {
  return LORE_FRAGMENTS[fragment]?.format ?? "journal";
}

export interface LorePageLocation {
  cellX: number;
  cellZ: number;
  /** Position monde (m) et orientation de la feuille posée au sol. */
  x: number;
  z: number;
  rotationY: number;
}

/**
 * Cellule où repose la page de bande perdue du level : fonction pure de la seed. Hors de la
 * ligne droite vers la sortie (il faut s'écarter du chemin pour la trouver), à bonne distance
 * du spawn, jamais dans le dégagement de la sortie. La cellule est laissée libre de tout
 * pilier/meuble et ses quatre bords sont ouverts (voir `chunkLayout.ts`).
 */
export function getLorePageLocation(profile: LevelProfile): LorePageLocation {
  const seedInt = stringSeedToInt(`${profile.seed}:lore`);
  const exit = getExitLocation(profile);
  const exitAngle = Math.atan2(exit.cellZ, exit.cellX);
  const exitDistance = Math.hypot(exit.cellX, exit.cellZ);
  const side = coordinateHash01(seedInt, 0, 0, 1) < 0.5 ? -1 : 1;
  const angle = exitAngle + side * (0.6 + coordinateHash01(seedInt, 0, 0, 2) * 1.2);
  const minDistance = SPAWN_CLEARANCE_CELLS + 2;
  const distance = minDistance + coordinateHash01(seedInt, 0, 0, 3) * Math.max(1, exitDistance * 0.7 - minDistance);
  let cellX = Math.round(Math.cos(angle) * distance);
  let cellZ = Math.round(Math.sin(angle) * distance);
  if (Math.abs(cellX - exit.cellX) <= EXIT_CLEARANCE_CELLS + 1 && Math.abs(cellZ - exit.cellZ) <= EXIT_CLEARANCE_CELLS + 1) {
    cellX = -cellX;
    cellZ = -cellZ;
  }
  const jitter = (salt: number): number => (coordinateHash01(seedInt, cellX, cellZ, salt) - 0.5) * CELL_SIZE * 0.35;
  return {
    cellX,
    cellZ,
    x: cellX * CELL_SIZE + CELL_SIZE / 2 + jitter(4),
    z: cellZ * CELL_SIZE + CELL_SIZE / 2 + jitter(5),
    rotationY: coordinateHash01(seedInt, cellX, cellZ, 6) * Math.PI * 2,
  };
}
