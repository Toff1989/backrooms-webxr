/**
 * Pseudos suggérés en fin de run (fiche projet étape 7 : "saisie du pseudo"). Pas de
 * clavier virtuel en VR : le joueur fait défiler quelques suggestions générées (adjectif
 * + nom, thème VHS/Backrooms) plutôt que de taper du texte. Toujours filtrées ensuite
 * par la liste de mots interdits côté serveur (`server/src/wordFilter.ts`) avant stockage.
 */
const ADJECTIVES = [
  "Silencieux",
  "Égaré",
  "Jaunâtre",
  "Statique",
  "Oublié",
  "Fluorescent",
  "Moite",
  "Sans-Signal",
  "Rembobiné",
  "Vacant",
  "Décalé",
  "Poussiéreux",
];

const NOUNS = [
  "Explorateur",
  "Témoin",
  "Arpenteur",
  "Cassette",
  "Locataire",
  "Signal",
  "Rôdeur",
  "Survivant",
  "Fantôme",
  "Visiteur",
  "Écho",
  "Intrus",
];

export function generatePseudoSuggestion(adjectiveIndex: number, nounIndex: number, suffix: number): string {
  const adjective = ADJECTIVES[((adjectiveIndex % ADJECTIVES.length) + ADJECTIVES.length) % ADJECTIVES.length]!;
  const noun = NOUNS[((nounIndex % NOUNS.length) + NOUNS.length) % NOUNS.length]!;
  const suffixDigits = ((suffix % 10000) + 10000) % 10000;
  return `${adjective}-${noun}-${suffixDigits.toString().padStart(4, "0")}`;
}

export const PSEUDO_ADJECTIVE_COUNT = ADJECTIVES.length;
export const PSEUDO_NOUN_COUNT = NOUNS.length;
