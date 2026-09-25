import type { CollectionEntry } from "./collection";

/**
 * Bonus passifs tirés de l'inventaire de la run (vidé à chaque partie) : ce qu'on a ramassé
 * sert réellement. Bonus thématiques, liés à l'objet :
 * - briquet +10 % d'autonomie de la lampe, et +1 % par objet quelconque (plafond : ×2,5) ;
 * - caméra de surveillance : la corruption visuelle se dissipe 15 % plus vite chacune
 *   (plafond +75 %) — "têtes de lecture propres" ;
 * - boussole : la balise de sortie n'est plus brouillée que de moitié.
 */
export interface CollectionPerks {
  batteryCapacity: number;
  corruptionDecay: number;
  beaconSteadiness: number;
}

export function computePerks(entries: readonly CollectionEntry[]): CollectionPerks {
  const count = (kinds: string[]): number => entries.filter((entry) => kinds.includes(entry.kind)).length;
  const batteryCapacity = Math.min(2.5, 1 + count(["lighter"]) * 0.1 + entries.length * 0.01);
  const corruptionDecay = Math.min(1.75, 1 + count(["securityCamera"]) * 0.15);
  const beaconSteadiness = count(["compass"]) > 0 ? 0.5 : 0;
  return { batteryCapacity, corruptionDecay, beaconSteadiness };
}
