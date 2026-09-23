/**
 * Filtre de pseudos FR + EN (fiche projet étape 7 : "filtré par liste de mots interdits
 * FR + EN"). Normalisation simple (minuscules, accents retirés, séparateurs/leetspeak
 * basique réduits) avant recherche en sous-chaîne : n'attrape pas tout, mais couvre les
 * contournements les plus courants sans faux-positifs excessifs sur des mots normaux.
 */
const BANNED_SUBSTRINGS = [
  // FR
  "encule",
  "enculé",
  "connard",
  "connasse",
  "salope",
  "pute",
  "putain",
  "batard",
  "bâtard",
  "nique",
  "niquer",
  "merde",
  "foutre",
  "negre",
  "nègre",
  "pd",
  "pédé",
  "pede",
  "chinetoque",
  "bougnoule",
  // EN
  "fuck",
  "shit",
  "bitch",
  "bastard",
  "asshole",
  "cunt",
  "whore",
  "slut",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "rape",
  "nazi",
  "hitler",
];

function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents
    .replace(/[0@]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[$5]/g, "s")
    .replace(/[^a-z0-9]/g, "");
}

export function containsBannedWord(text: string): boolean {
  const normalized = normalize(text);
  return BANNED_SUBSTRINGS.some((word) => normalized.includes(normalize(word)));
}

const PSEUDO_MAX_LENGTH = 40;
const PSEUDO_MIN_LENGTH = 1;
const FALLBACK_PSEUDO = "Explorateur-Anonyme";

/** Nettoie/valide un pseudo reçu du client : longueur, caractères, et liste interdite. Retombe sur un pseudo générique si tout échoue plutôt que de rejeter la soumission du score. */
export function sanitizePseudo(raw: unknown): string {
  if (typeof raw !== "string") return FALLBACK_PSEUDO;
  const trimmed = raw.trim().slice(0, PSEUDO_MAX_LENGTH);
  if (trimmed.length < PSEUDO_MIN_LENGTH) return FALLBACK_PSEUDO;
  if (containsBannedWord(trimmed)) return FALLBACK_PSEUDO;
  return trimmed;
}
