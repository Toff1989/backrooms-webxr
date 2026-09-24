/**
 * Types de mobilier décoratif (chaises/bureaux/meubles), placés en amas — fiche projet
 * étape 6, décor inspiré des images de référence (pièces avec chaises éparses et
 * empilements de meubles dans un coin). Aucune dépendance three.js ici : les modèles
 * 3D réels vivent dans `src/world/propLoader.ts`.
 */
export type PropKind = "chair" | "schoolDesk" | "officeDesk" | "cabinet";

/** Poids relatifs de tirage : les chaises dominent, les meubles plus imposants sont rares. */
export const PROP_KIND_WEIGHTS: Array<{ kind: PropKind; weight: number }> = [
  { kind: "chair", weight: 55 },
  { kind: "schoolDesk", weight: 20 },
  { kind: "officeDesk", weight: 15 },
  { kind: "cabinet", weight: 10 },
];

export function pickPropKind(roll: number): PropKind {
  const total = PROP_KIND_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  let threshold = roll * total;
  for (const entry of PROP_KIND_WEIGHTS) {
    threshold -= entry.weight;
    if (threshold <= 0) return entry.kind;
  }
  return PROP_KIND_WEIGHTS[PROP_KIND_WEIGHTS.length - 1]!.kind;
}

/**
 * Rayon d'encombrement au sol (m, cercle englobant approximatif du modèle) : sert à espacer
 * les meubles d'un amas — sans lui, des chaises naissaient dans les bureaux, la physique les
 * éjectait et elles glissaient sans fin (corps jamais endormis, coût CPU permanent).
 */
export const PROP_FOOTPRINT_RADIUS: Record<PropKind, number> = {
  chair: 0.33,
  schoolDesk: 0.5,
  officeDesk: 0.75,
  cabinet: 0.55,
};
