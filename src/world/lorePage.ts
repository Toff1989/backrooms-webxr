import * as THREE from "three";
import { loreFragment, onLanguageChange, t } from "../i18n";
import { LORE_FRAGMENT_COUNT } from "../shared/lore";
import { applyVhsEffect } from "./vhsMaterial";

/** Feuille A5 (m) : lisible tenue à 30-40 cm du visage, comme un vrai papier. */
const PAGE_WIDTH = 0.148;
const PAGE_LENGTH = 0.21;
/** Épaisseur de carton fin : une feuille réelle (0,1 mm) ferait vibrer la physique. */
const PAGE_THICKNESS = 0.003;
const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = Math.round((CANVAS_WIDTH * PAGE_LENGTH) / PAGE_WIDTH);
export const LORE_PAGE_MASS = 0.1;
/** Hauteur de pose au sol (centre de la feuille). */
export const LORE_PAGE_REST_HEIGHT = PAGE_THICKNESS / 2 + 0.004;

/**
 * Écriture manuscrite : polices système seulement (rien à télécharger) — Segoe Print / Ink Free
 * sous Windows, Dancing Script / Coming Soon sous Android (navigateur du Quest), repli cursif.
 */
export const HANDWRITING_FONT = `"Segoe Print", "Ink Free", "Dancing Script", "Coming Soon", "Bradley Hand", "Comic Sans MS", cursive`;
const INK = "#1c2753";
const RULE_SPACING = 46;
const FIRST_RULE = 150;
const MARGIN_X = 62;

/** Découpe un texte en lignes tenant dans `maxWidth` (police déjà réglée sur le contexte). */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

/** Petit générateur déterministe : chaque page garde ses taches et son grain d'une fois sur l'autre. */
function seededRandom(seed: number): () => number {
  let state = (seed * 2654435761 + 12345) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Papier jauni, lignes de cahier, marge, pli, taches — commun à la page et au journal. */
export function drawAgedPaper(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, seed: number, ruled = true): void {
  const random = seededRandom(seed);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  const gradient = ctx.createRadialGradient(x + width / 2, y + height / 2, width * 0.1, x + width / 2, y + height / 2, Math.max(width, height) * 0.75);
  gradient.addColorStop(0, "#efe4c8");
  gradient.addColorStop(1, "#cdb98f");
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, width, height);

  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(90, 70, 40, ${random() * 0.06})`;
    ctx.fillRect(x + random() * width, y + random() * height, 1 + random() * 2, 1 + random() * 2);
  }
  if (ruled) {
    ctx.strokeStyle = "rgba(70, 105, 160, 0.32)";
    ctx.lineWidth = 2;
    for (let ruleY = y + FIRST_RULE; ruleY < y + height - 20; ruleY += RULE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x, ruleY);
      ctx.lineTo(x + width, ruleY);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(190, 60, 60, 0.4)";
    ctx.beginPath();
    ctx.moveTo(x + MARGIN_X - 12, y);
    ctx.lineTo(x + MARGIN_X - 12, y + height);
    ctx.stroke();
  }
  // Pli de la feuille (pliée en trois pour tenir dans une poche).
  const foldY = y + height * (0.3 + random() * 0.06);
  ctx.strokeStyle = "rgba(255, 250, 235, 0.45)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, foldY);
  ctx.lineTo(x + width, foldY + (random() - 0.5) * 8);
  ctx.stroke();
  // Auréole de café et une tache d'humidité.
  const ringX = x + width * (0.55 + random() * 0.35);
  const ringY = y + height * (0.6 + random() * 0.3);
  const ringRadius = width * (0.12 + random() * 0.06);
  ctx.strokeStyle = "rgba(120, 75, 30, 0.28)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(ringX, ringY, ringRadius, random() * 2, random() * 2 + 5.4);
  ctx.stroke();
  const dampX = x + width * (0.15 + random() * 0.7);
  const dampY = y + height * (0.2 + random() * 0.7);
  const damp = ctx.createRadialGradient(dampX, dampY, 5, dampX, dampY, width * 0.35);
  damp.addColorStop(0, "rgba(110, 90, 50, 0.18)");
  damp.addColorStop(1, "rgba(110, 90, 50, 0)");
  ctx.fillStyle = damp;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

/** Texte d'une bande perdue écrit à la main sur la page (en-tête tapé à la machine). */
export function drawLoreText(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, fragment: number, fontSize = 38): void {
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#3a2f22";
  ctx.font = `bold 28px "Courier New", monospace`;
  ctx.fillText(t("lore.title", { n: fragment + 1 }), x + MARGIN_X, y + 64);
  ctx.font = `22px "Courier New", monospace`;
  ctx.textAlign = "right";
  ctx.fillText(`${fragment + 1}/${LORE_FRAGMENT_COUNT}`, x + width - 26, y + 104);

  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `${fontSize}px ${HANDWRITING_FONT}`;
  const text = loreFragment(fragment) ?? t("lore.end");
  const lines = wrapLines(ctx, text, width - MARGIN_X - 30);
  lines.forEach((line, index) => {
    // Écriture un peu penchée et irrégulière, posée sur les lignes du cahier.
    ctx.save();
    ctx.translate(x + MARGIN_X + (index % 2) * 3, y + FIRST_RULE + RULE_SPACING * (index + 1) - 9);
    ctx.rotate(-0.012 + (index % 3) * 0.006);
    ctx.fillText(line, 0, 0);
    ctx.restore();
  });
  ctx.restore();
}

interface LivePage {
  fragment: number;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
}

const livePages = new Set<LivePage>();
onLanguageChange(() => {
  for (const page of livePages) redraw(page);
});

function redraw(page: LivePage): void {
  drawAgedPaper(page.ctx, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, page.fragment + 7);
  drawLoreText(page.ctx, 0, 0, CANVAS_WIDTH, page.fragment);
  page.texture.needsUpdate = true;
}

let shared: { template: THREE.Group; edgeGeometry: THREE.BoxGeometry; faceGeometry: THREE.PlaneGeometry; edge: THREE.Material; back: THREE.Material } | null = null;

function sharedAssets(): NonNullable<typeof shared> {
  if (shared) return shared;
  const edgeGeometry = new THREE.BoxGeometry(PAGE_WIDTH, PAGE_THICKNESS, PAGE_LENGTH);
  const faceGeometry = new THREE.PlaneGeometry(PAGE_WIDTH, PAGE_LENGTH);
  const edge = new THREE.MeshStandardMaterial({ color: 0xd9c9a3, roughness: 0.95 });
  applyVhsEffect(edge);
  const backCanvas = document.createElement("canvas");
  backCanvas.width = CANVAS_WIDTH / 2;
  backCanvas.height = CANVAS_HEIGHT / 2;
  drawAgedPaper(backCanvas.getContext("2d")!, 0, 0, backCanvas.width, backCanvas.height, 3, false);
  const backTexture = new THREE.CanvasTexture(backCanvas);
  backTexture.colorSpace = THREE.SRGBColorSpace;
  const back = new THREE.MeshStandardMaterial({ map: backTexture, roughness: 0.95 });
  applyVhsEffect(back);
  // Forme physique : la boîte fine seule (les faces texturées sont collées dessus).
  const template = new THREE.Group();
  template.add(new THREE.Mesh(edgeGeometry, edge));
  shared = { template, edgeGeometry, faceGeometry, edge, back };
  return shared;
}

/**
 * Page de bande perdue : une feuille de cahier arrachée, texte manuscrit sur le recto (face +Y,
 * haut du texte vers -Z). Légèrement luminescente : on la devine dans la pénombre, et on la
 * lit en l'approchant du visage. `dispose` libère sa texture quand elle quitte le monde.
 */
export function createLorePageModel(fragment: number): { model: THREE.Group; template: THREE.Object3D; dispose: () => void } {
  const assets = sharedAssets();
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const page: LivePage = { fragment, ctx, texture };
  redraw(page);
  livePages.add(page);

  const front = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.28, roughness: 0.9 });
  applyVhsEffect(front);

  const model = new THREE.Group();
  model.name = "lore-page";
  model.add(new THREE.Mesh(assets.edgeGeometry, assets.edge));
  const recto = new THREE.Mesh(assets.faceGeometry, front);
  recto.rotation.x = -Math.PI / 2;
  recto.position.y = PAGE_THICKNESS / 2 + 0.0004;
  const verso = new THREE.Mesh(assets.faceGeometry, assets.back);
  verso.rotation.x = Math.PI / 2;
  verso.position.y = -PAGE_THICKNESS / 2 - 0.0004;
  model.add(recto, verso);

  return {
    model,
    template: assets.template,
    dispose: () => {
      livePages.delete(page);
      texture.dispose();
      front.dispose();
    },
  };
}
