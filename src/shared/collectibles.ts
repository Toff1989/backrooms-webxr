/**
 * Objets de collection (fiche projet étape 6) : pool de ~50 vrais modèles CC0 distincts
 * (Poly Haven, voir `src/world/collectibleLoader.ts`), chacun avec une rareté fixe
 * (commun/rare/légendaire — la rareté est une propriété de l'objet, pas un tirage
 * indépendant), + variation d'échelle et lore FR/EN généré par templates seedés.
 * Aucune dépendance three.js ici, comme le reste de `shared/` — réutilisable tel quel
 * côté serveur (étape 7).
 */
export type CollectibleKind =
  | "photo"
  | "can"
  | "toy"
  | "wrench"
  | "alarmClock"
  | "cleaner"
  | "bleach"
  | "cigaretteCase"
  | "cigarettePack"
  | "circuitBoard"
  | "cleanerTin"
  | "combWrench"
  | "hammer"
  | "digitalWatch"
  | "football"
  | "drainCleaner"
  | "dustpan"
  | "screwdriverFlat"
  | "gamepad"
  | "lightbulb"
  | "lubricant"
  | "medicalTape"
  | "pliers"
  | "plunger"
  | "screwdriver"
  | "woodenSpoon"
  | "watch"
  | "binoculars"
  | "brassPot"
  | "magnifyingGlass"
  | "toolbox"
  | "multimeter"
  | "securityCamera"
  | "kettle"
  | "lighter"
  | "wallClock"
  | "vase"
  | "spacecraftInstrument"
  | "compass";

export type CollectibleRarity = "common" | "rare" | "legendary";

export const COLLECTIBLE_SCALE_MIN = 0.85;
export const COLLECTIBLE_SCALE_MAX = 1.3;

interface KindData {
  rarity: CollectibleRarity;
  nameFr: string;
  nameEn: string;
}

/** Une entrée par modèle : rareté fixe (propriété de l'objet) + nom de base FR/EN traduit du modèle Poly Haven d'origine. */
const KIND_DATA: Record<CollectibleKind, KindData> = {
  // Commun — objets du quotidien, très largement répandus.
  photo: { rarity: "common", nameFr: "cadre photo", nameEn: "picture frame" },
  can: { rarity: "common", nameFr: "boîte de conserve rouillée", nameEn: "rusted tin can" },
  toy: { rarity: "common", nameFr: "canard en caoutchouc", nameEn: "rubber duck" },
  wrench: { rarity: "common", nameFr: "clé à molette", nameEn: "adjustable wrench" },
  alarmClock: { rarity: "common", nameFr: "réveil", nameEn: "alarm clock" },
  cleaner: { rarity: "common", nameFr: "flacon de nettoyant", nameEn: "all-purpose cleaner" },
  bleach: { rarity: "common", nameFr: "bouteille d'eau de javel", nameEn: "bleach bottle" },
  cigaretteCase: { rarity: "common", nameFr: "étui à cigarettes", nameEn: "cigarette case" },
  cigarettePack: { rarity: "common", nameFr: "paquet de cigarettes", nameEn: "cigarette pack" },
  circuitBoard: { rarity: "common", nameFr: "carte électronique", nameEn: "circuit board" },
  cleanerTin: { rarity: "common", nameFr: "boîte de cirage", nameEn: "tin of cleaner" },
  combWrench: { rarity: "common", nameFr: "clé plate", nameEn: "combination wrench" },
  hammer: { rarity: "common", nameFr: "marteau de menuisier", nameEn: "cross-pein hammer" },
  digitalWatch: { rarity: "common", nameFr: "montre digitale", nameEn: "digital wrist watch" },
  football: { rarity: "common", nameFr: "ballon crasseux", nameEn: "dirty football" },
  drainCleaner: { rarity: "common", nameFr: "déboucheur de canalisation", nameEn: "drain cleaner" },
  dustpan: { rarity: "common", nameFr: "pelle à poussière", nameEn: "dustpan" },
  screwdriverFlat: { rarity: "common", nameFr: "tournevis plat", nameEn: "flathead screwdriver" },
  gamepad: { rarity: "common", nameFr: "manette de jeu", nameEn: "gamepad" },
  lightbulb: { rarity: "common", nameFr: "ampoule", nameEn: "lightbulb" },
  lubricant: { rarity: "common", nameFr: "bombe de lubrifiant", nameEn: "lubricant spray" },
  medicalTape: { rarity: "common", nameFr: "sparadrap", nameEn: "medical tape" },
  pliers: { rarity: "common", nameFr: "pince", nameEn: "pliers" },
  plunger: { rarity: "common", nameFr: "ventouse de plombier", nameEn: "plunger" },
  screwdriver: { rarity: "common", nameFr: "tournevis", nameEn: "screwdriver" },
  woodenSpoon: { rarity: "common", nameFr: "cuillère en bois", nameEn: "wooden spoon" },

  // Rare — objets plus inhabituels ou de valeur.
  watch: { rarity: "rare", nameFr: "montre à gousset", nameEn: "pocket watch" },
  binoculars: { rarity: "rare", nameFr: "jumelles", nameEn: "binoculars" },
  brassPot: { rarity: "rare", nameFr: "pot en laiton", nameEn: "brass pot" },
  magnifyingGlass: { rarity: "rare", nameFr: "loupe", nameEn: "magnifying glass" },
  toolbox: { rarity: "rare", nameFr: "boîte à outils", nameEn: "metal toolbox" },
  multimeter: { rarity: "rare", nameFr: "multimètre rétro", nameEn: "retro multimeter" },
  securityCamera: { rarity: "rare", nameFr: "caméra de surveillance", nameEn: "security camera" },
  kettle: { rarity: "rare", nameFr: "bouilloire électrique vintage", nameEn: "vintage electric kettle" },
  lighter: { rarity: "rare", nameFr: "briquet vintage", nameEn: "vintage lighter" },
  wallClock: { rarity: "rare", nameFr: "horloge murale", nameEn: "wall clock" },

  // Légendaire — ne devrait pas se trouver dans les Backrooms.
  vase: { rarity: "legendary", nameFr: "vase en céramique antique", nameEn: "antique ceramic vase" },
  spacecraftInstrument: { rarity: "legendary", nameFr: "instrument de vaisseau spatial", nameEn: "vintage spacecraft instrument" },
  compass: { rarity: "legendary", nameFr: "boussole de marin", nameEn: "seadog's compass" },
};

export const COLLECTIBLE_KINDS = Object.keys(KIND_DATA) as CollectibleKind[];

export function getCollectibleRarity(kind: CollectibleKind): CollectibleRarity {
  return KIND_DATA[kind].rarity;
}

/** La fréquence de tirage suit la rareté : un objet légendaire est ~30x plus rare qu'un objet commun. */
const RARITY_WEIGHT: Record<CollectibleRarity, number> = {
  common: 10,
  rare: 3,
  legendary: 1,
};

export function pickCollectibleKind(roll: number): CollectibleKind {
  const total = COLLECTIBLE_KINDS.reduce((sum, kind) => sum + RARITY_WEIGHT[KIND_DATA[kind].rarity], 0);
  let threshold = roll * total;
  for (const kind of COLLECTIBLE_KINDS) {
    threshold -= RARITY_WEIGHT[KIND_DATA[kind].rarity];
    if (threshold <= 0) return kind;
  }
  return COLLECTIBLE_KINDS[COLLECTIBLE_KINDS.length - 1]!;
}

interface LoreTextPair {
  fr: string;
  en: string;
}

/** Variations de nom appliquées au nom de base du modèle : constructions sans accord de genre (pas d'adjectif épithète) pour rester correctes en français quel que soit l'objet. */
const NAME_TEMPLATES: LoreTextPair[] = [
  { fr: "{n}", en: "{n}" },
  { fr: "{n} — origine inconnue", en: "Unidentified {n}" },
  { fr: "{n}, laissé sur place", en: "{n}, left behind" },
  { fr: "{n} (état impeccable)", en: "{n} (pristine condition)" },
  { fr: "{n} retrouvé ici", en: "{n} found here" },
];

const DESCRIPTION_POOL: Record<CollectibleRarity, LoreTextPair[]> = {
  common: [
    { fr: "Personne ne se souvient l'avoir laissé ici.", en: "No one remembers leaving it here." },
    { fr: "Il traînait dans un coin, comme s'il attendait quelqu'un.", en: "It sat in a corner, as if waiting for someone." },
    { fr: "Rien d'anormal, à part l'endroit où on l'a trouvé.", en: "Nothing unusual about it, except where it was found." },
    { fr: "Un objet ordinaire, dans un endroit qui ne l'est pas.", en: "An ordinary object, in a place that isn't." },
  ],
  rare: [
    { fr: "On dirait qu'il a été déplacé récemment. Par qui ?", en: "It looks like it was moved recently. By whom?" },
    { fr: "Une légère odeur de moisi s'en dégage, comme s'il avait toujours été là.", en: "A faint musty smell clings to it, as if it had always been here." },
    { fr: "Il semble avoir traversé plusieurs niveaux avant d'arriver ici.", en: "It seems to have drifted through several levels before landing here." },
    { fr: "Quelque chose ne va pas avec les proportions de cet objet.", en: "Something about its proportions feels wrong." },
  ],
  legendary: [
    { fr: "Il n'aurait jamais dû se trouver dans les Backrooms.", en: "It was never supposed to be in the Backrooms." },
    { fr: "Sa présence ici contredit tout ce qu'on croyait savoir sur ce niveau.", en: "Its presence here contradicts everything known about this level." },
    { fr: "On raconte qu'il appartenait à quelqu'un qui n'est jamais ressorti.", en: "They say it belonged to someone who never made it out." },
    { fr: "Il semble regarder ceux qui l'observent.", en: "It seems to watch whoever is looking at it." },
  ],
};

export interface CollectibleLore {
  nameFr: string;
  nameEn: string;
  descriptionFr: string;
  descriptionEn: string;
}

/** `nameRoll`/`descriptionRoll` sont deux tirages indépendants pour éviter que le nom et la description restent toujours corrélés. */
export function generateCollectibleLore(kind: CollectibleKind, nameRoll: number, descriptionRoll: number): CollectibleLore {
  const base = KIND_DATA[kind];
  const template = NAME_TEMPLATES[Math.min(NAME_TEMPLATES.length - 1, Math.floor(nameRoll * NAME_TEMPLATES.length))]!;
  const descriptions = DESCRIPTION_POOL[base.rarity];
  const description = descriptions[Math.min(descriptions.length - 1, Math.floor(descriptionRoll * descriptions.length))]!;
  return {
    nameFr: template.fr.replace("{n}", base.nameFr),
    nameEn: template.en.replace("{n}", base.nameEn),
    descriptionFr: description.fr,
    descriptionEn: description.en,
  };
}
