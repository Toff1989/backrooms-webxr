/**
 * Mobilier décoratif (modèles CC0 Poly Haven, voir `src/world/propLoader.ts`), placé en amas
 * mis en scène : coin bureau, réserve, salle de classe, salle d'attente, zone abandonnée.
 * Aucune dépendance three.js ici : module partagé, génération pure.
 */
export type PropKind =
  | "chair"
  | "schoolDesk"
  | "officeDesk"
  | "cabinet"
  | "monoblocChair"
  | "armChair"
  | "sofa"
  | "coffeeTable"
  | "metalStool"
  | "metalShelves"
  | "bookshelf"
  | "storageCart"
  | "projectorScreen"
  | "chalkboard"
  | "cardboardBox"
  | "plasticCrate"
  | "wetFloorSign"
  | "television"
  | "pottedPlant";

/**
 * Demi-dimensions au sol (m) de chaque meuble, mesurées sur les modèles (x = largeur, z =
 * profondeur, face avant vers +Z) : sert à placer les meubles d'un amas sans qu'ils se
 * chevauchent — sinon la physique les éjectait et ils glissaient sans fin (corps jamais
 * endormis, coût CPU permanent) — et sans qu'ils traversent les murs de la cellule.
 */
export const PROP_HALF_EXTENTS: Record<PropKind, { x: number; z: number }> = {
  chair: { x: 0.28, z: 0.34 },
  schoolDesk: { x: 0.36, z: 0.28 },
  officeDesk: { x: 1.0, z: 0.47 },
  cabinet: { x: 0.57, z: 0.25 },
  monoblocChair: { x: 0.32, z: 0.32 },
  armChair: { x: 0.41, z: 0.5 },
  sofa: { x: 0.9, z: 0.41 },
  coffeeTable: { x: 0.3, z: 0.6 },
  metalStool: { x: 0.18, z: 0.18 },
  metalShelves: { x: 0.475, z: 0.22 },
  bookshelf: { x: 0.69, z: 0.29 },
  storageCart: { x: 0.8, z: 0.55 },
  projectorScreen: { x: 0.55, z: 0.46 },
  chalkboard: { x: 0.46, z: 0.38 },
  cardboardBox: { x: 0.19, z: 0.26 },
  plasticCrate: { x: 0.24, z: 0.13 },
  wetFloorSign: { x: 0.15, z: 0.18 },
  television: { x: 0.2, z: 0.18 },
  pottedPlant: { x: 0.09, z: 0.09 },
};

/** Hauteur (m) des caisses empilables : on les empile exactement (posées endormies, sans chute). */
const STACK_HEIGHT = { cardboardBox: 0.345, plasticCrate: 0.268 } as const;
/** Plateau (m) des meubles sur lesquels on pose un petit objet (plante, télé). */
const TABLE_TOP = { officeDesk: 0.79, coffeeTable: 0.392 } as const;

export interface PropSlot {
  kind: PropKind;
  /** Décalage local dans l'amas (m, avant rotation de l'amas). */
  dx: number;
  dz: number;
  /** Orientation propre (rad), ajoutée à celle de l'amas. */
  rotationY: number;
  /** Hauteur de pose (m) : caisses empilées, objet posé sur un bureau. */
  y?: number;
  /** Renversé : il naît éveillé, basculé, et la physique le laisse retomber. */
  tipped?: boolean;
}

type Roll = (salt: number) => number;

function weighted<T>(roll: number, entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let threshold = roll * total;
  for (const [value, weight] of entries) {
    threshold -= weight;
    if (threshold <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/** Pile de caisses (cartons ou caisses en plastique, 1 à 3 étages, légèrement de travers). */
function crateStack(slots: PropSlot[], r: Roll, salt: number, dx: number, dz: number): void {
  const kind: keyof typeof STACK_HEIGHT = r(salt) < 0.65 ? "cardboardBox" : "plasticCrate";
  const floors = 1 + Math.floor(r(salt + 1) * 3);
  for (let i = 0; i < floors; i++) {
    slots.push({
      kind,
      dx: dx + (r(salt + 10 + i) - 0.5) * 0.05,
      dz: dz + (r(salt + 20 + i) - 0.5) * 0.05,
      rotationY: (r(salt + 30 + i) - 0.5) * 0.35,
      y: i * STACK_HEIGHT[kind],
    });
  }
}

/** Coin bureau : bureau métallique, son siège, une plante ou une télé dessus, un meuble à côté. */
function office(r: Roll): PropSlot[] {
  const slots: PropSlot[] = [{ kind: "officeDesk", dx: 0, dz: -0.2, rotationY: 0 }];
  const seat: PropKind = r(1) < 0.5 ? "armChair" : "chair";
  slots.push({ kind: seat, dx: (r(2) - 0.5) * 0.4, dz: 0.6, rotationY: Math.PI + (r(3) - 0.5) * 0.9, tipped: r(4) < 0.12 });
  const onDesk = r(5);
  if (onDesk < 0.4) slots.push({ kind: "pottedPlant", dx: 0.6 + r(6) * 0.2, dz: -0.35, rotationY: r(7) * 6, y: TABLE_TOP.officeDesk });
  else if (onDesk < 0.7) slots.push({ kind: "television", dx: -0.55, dz: -0.4, rotationY: (r(8) - 0.5) * 0.6, y: TABLE_TOP.officeDesk });
  if (r(9) < 0.35) crateStack(slots, r, 40, 0.8, 0.55);
  return slots;
}

/** Réserve : étagère, bibliothèque ou chariot contre un bord, caisses empilées devant. */
function storage(r: Roll): PropSlot[] {
  const back = weighted<PropKind>(r(1), [
    ["metalShelves", 4],
    ["bookshelf", 3],
    ["storageCart", 2],
    ["cabinet", 2],
  ]);
  const slots: PropSlot[] = [{ kind: back, dx: (r(2) - 0.5) * 0.3, dz: -0.6 - PROP_HALF_EXTENTS[back].z, rotationY: 0 }];
  crateStack(slots, r, 40, -0.55, 0.35);
  if (r(3) < 0.75) crateStack(slots, r, 60, 0.45, 0.45);
  if (r(4) < 0.3) slots.push({ kind: "plasticCrate", dx: 0.05, dz: 0.75, rotationY: r(5) * 6, tipped: true });
  return slots;
}

/** Salle de classe : pupitres en rangées face au tableau, chaises derrière, une ou deux de travers. */
function classroom(r: Roll): PropSlot[] {
  const slots: PropSlot[] = [];
  const board: PropKind = r(1) < 0.7 ? "chalkboard" : "projectorScreen";
  slots.push({ kind: board, dx: (r(2) - 0.5) * 0.4, dz: -0.85, rotationY: (r(3) - 0.5) * 0.3 });
  for (let column = 0; column < 2; column++) {
    if (r(10 + column) < 0.12) continue;
    const dx = (column - 0.5) * 1.0;
    slots.push({ kind: "schoolDesk", dx, dz: 0.05, rotationY: Math.PI + (r(20 + column) - 0.5) * 0.15 });
    const askew = r(30 + column) < 0.3;
    slots.push({ kind: "chair", dx, dz: 0.65, rotationY: Math.PI + (askew ? (r(40 + column) - 0.5) * 1.8 : 0), tipped: askew && r(50 + column) < 0.4 });
  }
  return slots;
}

/** Salle d'attente : canapé, table basse (plante dessus), fauteuil ou chaises, télé posée au sol. */
function waitingRoom(r: Roll): PropSlot[] {
  const slots: PropSlot[] = [
    { kind: "sofa", dx: 0, dz: -0.7, rotationY: 0 },
    { kind: "coffeeTable", dx: 0, dz: 0.1, rotationY: Math.PI / 2 },
  ];
  if (r(1) < 0.6) slots.push({ kind: "pottedPlant", dx: (r(2) - 0.5) * 0.6, dz: 0.1, rotationY: r(3) * 6, y: TABLE_TOP.coffeeTable });
  if (r(4) < 0.55) slots.push({ kind: "armChair", dx: 0.85, dz: 0.55, rotationY: Math.PI * 0.75 + (r(5) - 0.5) * 0.4 });
  else slots.push({ kind: "monoblocChair", dx: -0.85, dz: 0.6, rotationY: Math.PI * 1.2 + (r(6) - 0.5) * 0.6 });
  if (r(7) < 0.4) slots.push({ kind: "television", dx: 0, dz: 0.85, rotationY: Math.PI + (r(8) - 0.5) * 0.5 });
  return slots;
}

/** Zone abandonnée : panneau "sol glissant", chaises en plastique renversées, caisses retournées. */
function abandoned(r: Roll): PropSlot[] {
  const slots: PropSlot[] = [];
  if (r(1) < 0.75) slots.push({ kind: "wetFloorSign", dx: (r(2) - 0.5) * 0.6, dz: (r(3) - 0.5) * 0.6, rotationY: r(4) * 6, tipped: r(5) < 0.25 });
  const chairs = 1 + Math.floor(r(6) * 3);
  for (let i = 0; i < chairs; i++) {
    slots.push({ kind: r(10 + i) < 0.7 ? "monoblocChair" : "metalStool", dx: (r(20 + i) - 0.5) * 1.3, dz: (r(30 + i) - 0.5) * 1.3, rotationY: r(40 + i) * 6, tipped: r(50 + i) < 0.6 });
  }
  if (r(7) < 0.45) slots.push({ kind: r(8) < 0.5 ? "cardboardBox" : "plasticCrate", dx: (r(60) - 0.5) * 1.2, dz: (r(61) - 0.5) * 1.2, rotationY: r(62) * 6, tipped: true });
  if (r(9) < 0.25) slots.push({ kind: "television", dx: (r(63) - 0.5) * 1.0, dz: (r(64) - 0.5) * 1.0, rotationY: r(65) * 6, tipped: r(66) < 0.5 });
  return slots;
}

/** Quelques meubles épars (une chaise isolée le plus souvent) — le décor "vide" des Backrooms. */
function scattered(r: Roll): PropSlot[] {
  const count = r(1) < 0.55 ? 1 : 2 + Math.floor(r(2) * 2);
  const slots: PropSlot[] = [];
  for (let i = 0; i < count; i++) {
    const kind = weighted<PropKind>(r(10 + i), [
      ["chair", 22],
      ["monoblocChair", 14],
      ["metalStool", 7],
      ["schoolDesk", 8],
      ["cabinet", 5],
      ["cardboardBox", 10],
      ["plasticCrate", 6],
      ["wetFloorSign", 5],
      ["armChair", 5],
      ["television", 4],
      ["metalShelves", 4],
      ["pottedPlant", 3],
    ]);
    const angle = r(20 + i) * Math.PI * 2;
    const radius = r(30 + i) * 0.7;
    slots.push({ kind, dx: Math.cos(angle) * radius, dz: Math.sin(angle) * radius, rotationY: r(40 + i) * Math.PI * 2, tipped: kind === "monoblocChair" && r(50 + i) < 0.2 });
  }
  return slots;
}

/**
 * Amas de mobilier d'une cellule : une mise en scène tirée au sort, ou quelques meubles épars.
 * L'amas entier est tourné d'un quart de tour aléatoire : une même scène ne se présente jamais
 * pareil. `r(salt)` : tirage déterministe [0..1) propre à la cellule.
 */
export function composePropCluster(r: Roll): { slots: PropSlot[]; rotationY: number } {
  const scene = weighted<(r: Roll) => PropSlot[]>(r(0), [
    [scattered, 36],
    [office, 17],
    [storage, 15],
    [abandoned, 13],
    [classroom, 10],
    [waitingRoom, 9],
  ]);
  return { slots: scene((salt) => r(100 + salt)), rotationY: Math.floor(r(1) * 4) * (Math.PI / 2) };
}
