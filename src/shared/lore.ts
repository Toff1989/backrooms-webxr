import { CELL_SIZE, EXIT_CLEARANCE_CELLS } from "./constants.js";
import { getExitLocation } from "./exit.js";
import type { LevelProfile } from "./levelProfile.js";
import { coordinateHash01, stringSeedToInt } from "./rng.js";

/**
 * Archives perdues : un récit en fragments numérotés, lus dans l'ordre d'une run à l'autre. Le
 * texte vit dans les traductions (`src/i18n`) ; le serveur n'a besoin que du nombre.
 */
export const LORE_FRAGMENT_COUNT = 16;

/**
 * Forme d'une archive : note manuscrite, fiche de montage (bobine, plan, time-code),
 * photo polaroid (développée au ramassage), ou cassette audio (grésillement + transcription).
 */
/** Premier et dernier niveau où une archive peut se trouver : les 16 fragments s'étalent entre les deux. */
export const LORE_FIRST_DEPTH = 1;
export const LORE_LAST_DEPTH = 20;

/**
 * Niveau à partir duquel le fragment `fragment` peut apparaître (jamais avant : la 7e archive ne
 * se trouve pas au niveau 1). Étalées du niveau 1 au niveau 20 ; au-delà, plus d'archive à
 * chercher, les niveaux sont du bonus (succès).
 */
export function loreMinDepth(fragment: number): number {
  const last = Math.max(1, LORE_FRAGMENT_COUNT - 1);
  return LORE_FIRST_DEPTH + Math.round((Math.min(fragment, last) * (LORE_LAST_DEPTH - LORE_FIRST_DEPTH)) / last);
}

export type LoreFormat = "journal" | "fiche" | "polaroid" | "audio";

export interface LoreFragmentMeta {
  format: LoreFormat;
  /** Fiche de montage : références du rush (identiques dans toutes les langues). */
  reel?: number;
  shot?: string;
  timecode?: string;
  /** Le plan en entier, sans coupe (dernière archive). */
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

/** Distance minimale (cellules) entre le spawn et l'archive : ~50 m. */
const LORE_MIN_DISTANCE_CELLS = 20;

export interface LorePageLocation {
  cellX: number;
  cellZ: number;
  /** Position monde (m) et orientation de la feuille posée au sol. */
  x: number;
  z: number;
  rotationY: number;
}

/**
 * Cellule où repose la page d'archive perdue du level : fonction pure de la seed. Hors de la
 * ligne droite vers la sortie (il faut s'écarter du chemin pour la trouver), loin du spawn —
 * au moins aussi loin que la sortie, souvent au-delà : la trouver demande d'explorer et de
 * prendre des risques — jamais dans le dégagement de la sortie. La cellule est laissée libre de tout
 * pilier/meuble et ses quatre bords sont ouverts (voir `chunkLayout.ts`).
 */
export function getLorePageLocation(profile: LevelProfile): LorePageLocation {
  const seedInt = stringSeedToInt(`${profile.seed}:lore`);
  const exit = getExitLocation(profile);
  const exitAngle = Math.atan2(exit.cellZ, exit.cellX);
  const exitDistance = Math.hypot(exit.cellX, exit.cellZ);
  const side = coordinateHash01(seedInt, 0, 0, 1) < 0.5 ? -1 : 1;
  const angle = exitAngle + side * (0.6 + coordinateHash01(seedInt, 0, 0, 2) * 1.2);
  const minDistance = Math.max(LORE_MIN_DISTANCE_CELLS, exitDistance + 2);
  const distance = minDistance + coordinateHash01(seedInt, 0, 0, 3) * (exitDistance * 0.6 + 8);
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
