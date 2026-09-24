import { get, set } from "idb-keyval";
import { loreFragment, t } from "../i18n";
import { LORE_FRAGMENT_COUNT, LORE_FRAGMENTS, loreFormat } from "../shared/lore";

/**
 * Dessin des bandes perdues sur canvas, commun aux objets du monde (feuille, polaroid) et au
 * journal : note manuscrite sur papier de cahier, fiche de montage tapée à la machine, polaroid
 * (photo développée + légende au dos), transcription d'une cassette.
 */

/**
 * Écriture manuscrite : polices système seulement (rien à télécharger) — Segoe Print / Ink Free
 * sous Windows, Dancing Script / Coming Soon sous Android (navigateur du Quest), repli cursif.
 */
export const HANDWRITING_FONT = `"Segoe Print", "Ink Free", "Dancing Script", "Coming Soon", "Bradley Hand", "Comic Sans MS", cursive`;
const TYPEWRITER_FONT = `"Courier New", monospace`;
const INK = "#1c2753";
const RED_INK = "#a3221b";
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

/** Papier jauni, lignes de cahier, marge, pli, taches — commun aux pages, au journal et à l'inventaire. */
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

/** En-tête commun : titre de la bande tapé à la machine et numéro sur le total. */
function drawHeader(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, fragment: number): void {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#3a2f22";
  ctx.font = `bold 28px ${TYPEWRITER_FONT}`;
  ctx.fillText(t("lore.title", { n: fragment + 1 }), x + MARGIN_X, y + 64);
  ctx.font = `22px ${TYPEWRITER_FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(`${fragment + 1}/${LORE_FRAGMENT_COUNT}`, x + width - 26, y + 104);
  ctx.textAlign = "left";
}

/** Note manuscrite du monteur, posée sur les lignes du cahier. */
export function drawLoreText(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, fragment: number, fontSize = 38): void {
  ctx.save();
  drawHeader(ctx, x, y, width, fragment);
  ctx.fillStyle = INK;
  ctx.font = `${fontSize}px ${HANDWRITING_FONT}`;
  const text = loreFragment(fragment) ?? t("lore.end");
  wrapLines(ctx, text, width - MARGIN_X - 30).forEach((line, index) => {
    // Écriture un peu penchée et irrégulière.
    ctx.save();
    ctx.translate(x + MARGIN_X + (index % 2) * 3, y + FIRST_RULE + RULE_SPACING * (index + 1) - 9);
    ctx.rotate(-0.012 + (index % 3) * 0.006);
    ctx.fillText(line, 0, 0);
    ctx.restore();
  });
  ctx.restore();
}

/** Première ligne d'une bande (pour l'index du journal), sans le locuteur d'une cassette. */
export function loreExcerpt(fragment: number): string {
  const lines = (loreFragment(fragment) ?? "").split("\n");
  return (lines[0]?.startsWith("[") ? lines[1] : lines[0]) ?? "";
}

/**
 * Fiche de montage : formulaire tapé à la machine (bobine, plan, time-code, description) et
 * note du monteur au stylo rouge — raturée quand elle commence par une parenthèse.
 */
export function drawFiche(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, fragment: number): void {
  const meta = LORE_FRAGMENTS[fragment] ?? { format: "fiche" };
  const [description = "", note = ""] = (loreFragment(fragment) ?? "").split("\n");
  const s = width / 512;
  const pad = 34 * s;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#2b241a";
  ctx.font = `bold ${30 * s}px ${TYPEWRITER_FONT}`;
  ctx.fillText(t("fiche.title"), x + pad, y + 56 * s);
  ctx.font = `${17 * s}px ${TYPEWRITER_FONT}`;
  ctx.fillText(t("fiche.film"), x + pad, y + 84 * s);
  ctx.textAlign = "right";
  ctx.fillText(`${fragment + 1}/${LORE_FRAGMENT_COUNT}`, x + width - pad, y + 56 * s);
  ctx.textAlign = "left";

  // Tableau bobine / plan / time-code.
  const top = y + 104 * s;
  const rowH = 70 * s;
  const cols = [0.24, 0.3, 0.46].map((part) => part * (width - 2 * pad));
  ctx.strokeStyle = "rgba(43, 36, 26, 0.75)";
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(x + pad, top, width - 2 * pad, rowH);
  let cellX = x + pad;
  const values = [String(meta.reel ?? "—"), meta.full ? `${meta.shot ?? "—"} ${t("fiche.full")}` : (meta.shot ?? "—"), meta.timecode ?? "—"];
  [t("fiche.reel"), t("fiche.shot"), t("fiche.tc")].forEach((label, index) => {
    if (index > 0) {
      ctx.beginPath();
      ctx.moveTo(cellX, top);
      ctx.lineTo(cellX, top + rowH);
      ctx.stroke();
    }
    ctx.font = `bold ${13 * s}px ${TYPEWRITER_FONT}`;
    ctx.fillStyle = "#5a4a36";
    ctx.fillText(label, cellX + 8 * s, top + 20 * s);
    ctx.font = `bold ${(index === 2 ? 21 : 26) * s}px ${TYPEWRITER_FONT}`;
    ctx.fillStyle = "#1a1510";
    ctx.fillText(values[index]!, cellX + 8 * s, top + 54 * s);
    cellX += cols[index]!;
  });

  // Description tapée.
  let cursor = top + rowH + 34 * s;
  ctx.font = `bold ${13 * s}px ${TYPEWRITER_FONT}`;
  ctx.fillStyle = "#5a4a36";
  ctx.fillText(t("fiche.description"), x + pad, cursor);
  cursor += 28 * s;
  ctx.font = `${20 * s}px ${TYPEWRITER_FONT}`;
  ctx.fillStyle = "#1a1510";
  const descriptionLines = wrapLines(ctx, description, width - 2 * pad);
  descriptionLines.forEach((line, index) => ctx.fillText(line, x + pad, cursor + index * 27 * s));
  cursor += descriptionLines.length * 27 * s + 30 * s;

  // Note du monteur au stylo rouge.
  ctx.font = `bold ${13 * s}px ${TYPEWRITER_FONT}`;
  ctx.fillStyle = "#5a4a36";
  ctx.fillText(t("fiche.note"), x + pad, cursor);
  ctx.beginPath();
  ctx.moveTo(x + pad, cursor + 8 * s);
  ctx.lineTo(x + width - pad, cursor + 8 * s);
  ctx.stroke();
  cursor += 50 * s;
  const crossedOut = note.startsWith("(");
  ctx.fillStyle = crossedOut ? "rgba(163, 34, 27, 0.55)" : RED_INK;
  ctx.font = `${34 * s}px ${HANDWRITING_FONT}`;
  const noteLines = wrapLines(ctx, note, width - 2 * pad - 10 * s);
  noteLines.forEach((line, index) => {
    ctx.save();
    ctx.translate(x + pad + 6 * s, cursor + index * 42 * s);
    ctx.rotate(-0.03);
    ctx.fillText(line, 0, 0);
    if (crossedOut) {
      // Rature : gribouillis serré par-dessus le texte.
      const lineWidth = ctx.measureText(line).width;
      ctx.strokeStyle = RED_INK;
      ctx.lineWidth = 3 * s;
      ctx.beginPath();
      for (let px = 0; px < lineWidth; px += 9 * s) {
        ctx.lineTo(px, -26 * s + ((px / (9 * s)) % 2) * 22 * s);
      }
      ctx.stroke();
    }
    ctx.restore();
  });
  ctx.restore();
}

/** Couleur de la photo pas encore développée (chimie polaroid : brun-vert sombre). */
const UNDEVELOPED = "#2e3528";

/**
 * Recto d'un polaroid : cadre blanc, photo (développée à `develop` de 0 à 1), numéro écrit au
 * feutre dans la marge du bas. `photo` null : photo encore vierge.
 */
export function drawPolaroidFront(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, photo: CanvasImageSource | null, develop: number, fragment: number): void {
  const height = width * (107 / 88);
  const border = width * (4.5 / 88);
  const image = width - 2 * border;
  ctx.save();
  ctx.fillStyle = "#f1eee6";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "rgba(120, 110, 90, 0.08)";
  ctx.fillRect(x, y + height * 0.8, width, height * 0.2);
  ctx.fillStyle = UNDEVELOPED;
  ctx.fillRect(x + border, y + border, image, image);
  if (photo && develop > 0) {
    ctx.globalAlpha = Math.min(1, develop);
    ctx.drawImage(photo, x + border, y + border, image, image);
    // Dominante chaude qui s'estompe à la fin du développement.
    ctx.globalAlpha = (1 - Math.min(1, develop)) * 0.6;
    ctx.fillStyle = "#6b4b2a";
    ctx.fillRect(x + border, y + border, image, image);
    ctx.globalAlpha = 1;
  }
  // Vignettage et reflet : ça reste une photo chimique.
  const vignette = ctx.createRadialGradient(x + width / 2, y + border + image / 2, image * 0.3, x + width / 2, y + border + image / 2, image * 0.75);
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.45)");
  ctx.fillStyle = vignette;
  ctx.fillRect(x + border, y + border, image, image);
  ctx.fillStyle = INK;
  ctx.font = `${width * 0.075}px ${HANDWRITING_FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.fillText(`n°${fragment + 1}`, x + width - border * 1.5, y + border + image + (height - border - image) / 2);
  ctx.restore();
}

/** Verso d'un polaroid : la légende écrite à la main. */
export function drawPolaroidBack(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, fragment: number): void {
  const height = width * (107 / 88);
  ctx.save();
  ctx.fillStyle = "#d9d6cf";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
  for (let stripe = 0; stripe < height; stripe += 6) ctx.fillRect(x, y + stripe, width, 2);
  ctx.fillStyle = INK;
  ctx.font = `${width * 0.07}px ${HANDWRITING_FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  wrapLines(ctx, loreFragment(fragment) ?? "", width * 0.84).forEach((line, index) => {
    ctx.fillText(line, x + width * 0.08, y + width * 0.16 + index * width * 0.095);
  });
  ctx.restore();
}

/** Page de transcription d'une cassette : étiquette, locuteur, répliques. */
export function drawTranscript(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, fragment: number): void {
  const lines = (loreFragment(fragment) ?? "").split("\n");
  const speaker = lines[0]?.startsWith("[") ? lines.shift()!.slice(1, -1) : "";
  const s = width / 512;
  ctx.save();
  // Étiquette de cassette.
  const labelX = x + 40 * s;
  const labelW = width - 80 * s;
  ctx.fillStyle = "#f4efdf";
  ctx.fillRect(labelX, y + 34 * s, labelW, 86 * s);
  ctx.fillStyle = "#c0392b";
  ctx.fillRect(labelX, y + 44 * s, labelW, 6 * s);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
  ctx.strokeRect(labelX, y + 34 * s, labelW, 86 * s);
  ctx.fillStyle = INK;
  ctx.font = `${30 * s}px ${HANDWRITING_FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(t("audio.label", { n: fragment + 1 }), labelX + 16 * s, y + 100 * s);

  ctx.fillStyle = "#5a4a36";
  ctx.font = `bold ${13 * s}px ${TYPEWRITER_FONT}`;
  ctx.fillText(t("audio.transcript"), x + 40 * s, y + 158 * s);
  ctx.fillStyle = "#1a1510";
  ctx.font = `bold ${19 * s}px ${TYPEWRITER_FONT}`;
  ctx.fillText(speaker, x + 40 * s, y + 188 * s);
  ctx.font = `${20 * s}px ${TYPEWRITER_FONT}`;
  let cursor = y + 226 * s;
  for (const line of lines) {
    for (const wrapped of wrapLines(ctx, `— ${line}`, width - 80 * s)) {
      ctx.fillText(wrapped, x + 40 * s, cursor);
      cursor += 27 * s;
    }
    cursor += 8 * s;
  }
  ctx.restore();
}

/**
 * Une bande entière sur une page (journal) : papier, puis le contenu selon sa forme. Le polaroid
 * est posé de travers sur la page, sa légende recopiée dessous.
 */
export function drawLoreFragment(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fragment: number): void {
  const format = loreFormat(fragment);
  drawAgedPaper(ctx, x, y, width, height, 202 + fragment, format === "journal");
  if (format === "journal") drawLoreText(ctx, x, y, width, fragment, 34);
  else if (format === "fiche") drawFiche(ctx, x, y, width, fragment);
  else if (format === "audio") drawTranscript(ctx, x, y, width, fragment);
  else {
    const photo = getLorePhoto(fragment);
    const polaroidWidth = width * 0.5;
    ctx.save();
    ctx.translate(x + width * 0.25, y + 30);
    ctx.rotate(-0.04);
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#f1eee6";
    ctx.fillRect(0, 0, polaroidWidth, polaroidWidth * (107 / 88));
    ctx.shadowColor = "transparent";
    drawPolaroidFront(ctx, 0, 0, polaroidWidth, photo, photo ? 1 : 0, fragment);
    ctx.restore();
    const textTop = y + 50 + polaroidWidth * (107 / 88);
    ctx.save();
    ctx.fillStyle = "#5a4a36";
    ctx.font = `bold 15px ${TYPEWRITER_FONT}`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(photo ? t("polaroid.back") : t("polaroid.undeveloped"), x + 34, textTop);
    ctx.fillStyle = INK;
    ctx.font = `26px ${HANDWRITING_FONT}`;
    wrapLines(ctx, loreFragment(fragment) ?? "", width - 68).forEach((line, index) => ctx.fillText(line, x + 34, textTop + 36 + index * 32));
    ctx.restore();
  }
}

// ---------- Photos développées (polaroids) ----------

const PHOTO_KEY = (fragment: number): string => `backrooms-vr:lore-photo:${fragment}`;
const photos = new Map<number, CanvasImageSource>();
const photoRequests = new Set<number>();
const photoListeners = new Set<() => void>();

export function onLorePhotoChange(listener: () => void): void {
  photoListeners.add(listener);
}

/** Photo développée d'un polaroid (chargée à la demande depuis l'appareil), ou null. */
export function getLorePhoto(fragment: number): CanvasImageSource | null {
  const cached = photos.get(fragment);
  if (cached) return cached;
  if (!photoRequests.has(fragment)) {
    photoRequests.add(fragment);
    get<string>(PHOTO_KEY(fragment))
      .then((dataUrl) => {
        if (!dataUrl || photos.has(fragment)) return;
        const image = new Image();
        image.onload = () => {
          photos.set(fragment, image);
          for (const listener of photoListeners) listener();
        };
        image.src = dataUrl;
      })
      .catch(() => {});
  }
  return null;
}

/** Garde la photo d'un polaroid qui vient d'être développé (journal, autres runs). */
export function saveLorePhoto(fragment: number, canvas: HTMLCanvasElement): void {
  photos.set(fragment, canvas);
  photoRequests.add(fragment);
  void set(PHOTO_KEY(fragment), canvas.toDataURL("image/jpeg", 0.82)).catch(() => {});
  for (const listener of photoListeners) listener();
}
