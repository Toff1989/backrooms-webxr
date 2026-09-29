/**
 * Test visuel de tous les menus (panneaux `UiPanel`) : chaque panneau réel est instancié avec des
 * dépendances simulées, poussé dans chacun de ses états (pages, phases, messages de statut,
 * survols, variantes de données) et dessiné dans les deux langues. Pour chaque rendu on
 * capture le canvas (envoyé au runner `scripts/render-menus.mjs`) et on détecte automatiquement :
 * - textes rognés avec "..." / "…" (boutons, pseudos, extraits) ;
 * - phrases coupées faute de lignes (`wrapText`, via `uiDiagnostics`) ;
 * - texte qui déborde du panneau, ou du bouton qui le porte ;
 * - textes qui se chevauchent entre eux, ou qui mordent sur un bouton.
 *
 * Police : le "monospace" du navigateur varie selon la machine (Consolas ≈ 0,55 em sur Windows,
 * ≈ 0,6 em sur le Quest). On force ici une chasse de 0,6 em (pire cas) pour que ce qui tient
 * ici tienne aussi dans le casque.
 *
 * Lancer : `npm run test:visual:menus` (voir scripts/render-menus.mjs).
 */
import * as THREE from "three";
import { setLanguage, t, type Language, type TranslationKey } from "../../src/i18n";
import en from "../../src/i18n/en.json";
import fr from "../../src/i18n/fr.json";
import { setDebugMenuEnabled } from "../../src/debug/debugLog";
import { DeviceMenu } from "../../src/player/deviceMenu";
import { DebugMenu } from "../../src/player/debugMenu";
import { EndRunScreen } from "../../src/player/endRunScreen";
import { GuideMenu } from "../../src/player/guideMenu";
import { InventoryMenu } from "../../src/player/inventoryMenu";
import { Journal } from "../../src/player/journal";
import { MainMenu } from "../../src/player/mainMenu";
import { ScoresMenu } from "../../src/player/scoresMenu";
import { SettingsMenu } from "../../src/player/settingsMenu";
import { COLLECTIBLE_KINDS, generateCollectibleLore, getCollectibleRarity } from "../../src/shared/collectibles";
import { LORE_FRAGMENT_COUNT } from "../../src/shared/lore";
import { PROP_HALF_EXTENTS } from "../../src/shared/props";
import { PSEUDO_ADJECTIVE_COUNT, PSEUDO_NOUN_COUNT, generatePseudoSuggestion } from "../../src/shared/pseudoGenerator";
import { uiDiagnostics, type Rect, type UiPanel } from "../../src/ui/uiPanel";
import { CollectionStore, type CollectionEntry } from "../../src/world/collection";
import type { LoreJournal } from "../../src/world/loreJournal";

// ---------------------------------------------------------------------------------------------
// Police : chasse fixe 0,6 em (pire cas des monospace usuels).
// ---------------------------------------------------------------------------------------------
const FONT_STACK = `"Lucida Console", "Courier New", monospace`;
const fontDescriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "font")!;
Object.defineProperty(CanvasRenderingContext2D.prototype, "font", {
  get() {
    return fontDescriptor.get!.call(this) as string;
  },
  set(value: string) {
    fontDescriptor.set!.call(this, String(value).replace(/monospace/g, FONT_STACK));
  },
});

// ---------------------------------------------------------------------------------------------
// Instrumentation du dessin.
// ---------------------------------------------------------------------------------------------
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface DrawnText {
  text: string;
  box: Box;
}
interface Issue {
  lang: Language;
  panel: string;
  scenario: string;
  kind: "ellipsis" | "wrap-overflow" | "out-of-panel" | "out-of-button" | "text-overlap" | "text-on-button";
  detail: string;
}

const PANEL_MARGIN = 16;
let activeCanvas: HTMLCanvasElement | null = null;
let drawn: DrawnText[] = [];
let buttons: Array<{ rect: Rect; label: string }> = [];
let pendingButton: { rect: Rect; remaining: number } | null = null;
let frameIssues: Array<{ kind: Issue["kind"]; detail: string }> = [];

const originalFillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number): void {
  if (this.canvas === activeCanvas) {
    const m = this.measureText(text);
    const box: Box = { left: x - m.actualBoundingBoxLeft, right: x + m.actualBoundingBoxRight, top: y - m.actualBoundingBoxAscent, bottom: y + m.actualBoundingBoxDescent };
    if (pendingButton) {
      const r = pendingButton.rect;
      if (--pendingButton.remaining <= 0) pendingButton = null;
      if (box.left < r.x + 8 || box.right > r.x + r.w - 8 || box.top < r.y || box.bottom > r.y + r.h) {
        frameIssues.push({ kind: "out-of-button", detail: `« ${text} » dépasse son bouton (${Math.round(box.right - box.left)}px pour ${r.w - 16}px utiles)` });
      }
    } else drawn.push({ text, box });
  }
  originalFillText.call(this, text, x, y, maxWidth as number);
};

uiDiagnostics.onButton = (rect, lines) => {
  buttons.push({ rect, label: lines.join(" ") });
  pendingButton = { rect, remaining: lines.length };
};
uiDiagnostics.onEllipsis = (original, shown) => frameIssues.push({ kind: "ellipsis", detail: `bouton « ${original} » rogné en « ${shown} »` });
uiDiagnostics.onWrapOverflow = (text, maxLines) => frameIssues.push({ kind: "wrap-overflow", detail: `phrase coupée (${maxLines} ligne(s) max) : « ${text.replace(/\n/g, " / ")} »` });

const KNOWN_TEXTS = new Set<string>(
  [...Object.values(fr), ...Object.values(en)].flatMap((value) => (Array.isArray(value) ? value : [value])).flatMap((value) => String(value).split("\n")),
);

function overlap(a: Box, b: Box): boolean {
  const shrink = 2;
  return a.left + shrink < b.right && b.left + shrink < a.right && a.top + shrink < b.bottom && b.top + shrink < a.bottom;
}

function analyze(canvas: HTMLCanvasElement): void {
  for (const item of drawn) {
    const { box, text } = item;
    if ((text.endsWith("...") || text.endsWith("…")) && !KNOWN_TEXTS.has(text) && !KNOWN_TEXTS.has(text.replace(/\s+/g, " "))) {
      // Une traduction légitime ("Envoi…") est whitelistée ; le reste est un texte rogné.
      if (![...KNOWN_TEXTS].some((known) => known.includes(text))) frameIssues.push({ kind: "ellipsis", detail: `texte rogné : « ${text} »` });
    }
    if (box.left < PANEL_MARGIN || box.right > canvas.width - PANEL_MARGIN || box.top < PANEL_MARGIN || box.bottom > canvas.height - PANEL_MARGIN) {
      frameIssues.push({ kind: "out-of-panel", detail: `« ${text.slice(0, 50)} » sort du panneau (x ${Math.round(box.left)}→${Math.round(box.right)} sur ${canvas.width}, y ${Math.round(box.top)}→${Math.round(box.bottom)} sur ${canvas.height})` });
    }
    for (const { rect } of buttons) {
      const b: Box = { left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h };
      if (overlap(box, b)) frameIssues.push({ kind: "text-on-button", detail: `« ${text.slice(0, 50)} » chevauche un bouton (${Math.round(rect.x)},${Math.round(rect.y)} ${rect.w}×${rect.h})` });
    }
  }
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      if (overlap(drawn[i]!.box, drawn[j]!.box)) frameIssues.push({ kind: "text-overlap", detail: `« ${drawn[i]!.text.slice(0, 40)} » chevauche « ${drawn[j]!.text.slice(0, 40)} »` });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Faux collaborateurs.
// ---------------------------------------------------------------------------------------------
const camera = new THREE.PerspectiveCamera();
const parent = new THREE.Group();
const sfx = { play: () => {} } as never;
const fakeHand = {} as never;
type AnyPanel = UiPanel & Record<string, any>;

interface FakeLore {
  count: number;
  serverProfile: { recoveryCode: string; pseudo: string | null; loreCount: number; bestRuns: Array<{ pseudo: string; depth: number; endedAt: number }> } | null;
  onChange(): void;
  sync(): Promise<null>;
}
function fakeLore(overrides: Partial<FakeLore> = {}): FakeLore & LoreJournal {
  return { count: 0, serverProfile: null, onChange: () => {}, sync: async () => null, ...overrides } as never;
}

const LONG_PSEUDO = "Sans-Signal-Explorateur-9999-ééééééé"; // 36 car. ; le serveur accepte jusqu'à 40
const MAX_PSEUDO = "W".repeat(40); // pire cas absolu : 40 caractères larges
const runs = (pseudo: string, count = 7) => Array.from({ length: count }, (_, i) => ({ pseudo: i === 0 ? pseudo : generatePseudoSuggestion(i * 5, i * 7, i * 1234), depth: 3 + i * 11, endedAt: 0 }));

// ---------------------------------------------------------------------------------------------
// Scénarios.
// ---------------------------------------------------------------------------------------------
interface Scenario {
  name: string;
  setup(): void;
  /** Score de "pire cas" (plus grand = plus intéressant à capturer) : seul le meilleur d'un balayage est capturé. */
  score?: number;
}
interface Group {
  panel: string;
  make(): AnyPanel;
  scenarios: Scenario[];
  /** Balayage exhaustif : variantes vérifiées mais capturées seulement si problème (ou meilleur score). */
  sweeps?: Array<{ name: string; variants: Scenario[] }>;
}

function mainMenuGroup(): Group {
  const menu = () => new MainMenu(camera, parent, sfx, { continueRun() {}, newGame() {}, openGuide() {}, openDevices() {}, openScores() {}, openSettings() {}, quit() {} }) as AnyPanel;
  let panel: AnyPanel;
  return {
    panel: "mainMenu",
    make: () => (panel = menu()),
    scenarios: [
      { name: "defaut", setup: () => (panel["quitArmedUntil"] = 0) },
      { name: "quitter-confirmation", setup: () => (panel["quitArmedUntil"] = 1) },
      {
        name: "survol-bouton-long",
        setup: () => {
          panel["quitArmedUntil"] = 0;
          panel["hovered"].set(fakeHand, "guide");
        },
      },
    ],
  };
}

function guideGroup(): Group {
  let panel: AnyPanel;
  return {
    panel: "guide",
    make: () => (panel = new GuideMenu(camera, parent, sfx, () => {}) as AnyPanel),
    scenarios: [
      { name: "controles", setup: () => (panel["page"] = "controls") },
      { name: "systemes", setup: () => (panel["page"] = "systems") },
    ],
  };
}

function deviceGroup(): Group {
  let panel: AnyPanel;
  const lore = fakeLore({ serverProfile: { recoveryCode: "K7-WWWW-WWWW", pseudo: null, loreCount: 0, bestRuns: [] } });
  const idle = (status: TranslationKey | null): void => {
    panel["pair"] = { kind: "idle" };
    panel["status"] = status ? { key: status, good: status === "pair.success" || status === "pair.confirmed" } : null;
  };
  const statuses: TranslationKey[] = ["pair.success", "pair.failed", "pair.confirmed", "pair.badCode", "pair.unavailable"];
  return {
    panel: "appareils",
    make: () => (panel = new DeviceMenu(camera, parent, lore, sfx, () => {}) as AnyPanel),
    scenarios: [
      { name: "repos", setup: () => idle(null) },
      { name: "demande-en-cours", setup: () => ((panel["pair"] = { kind: "requesting" }), (panel["status"] = null)) },
      { name: "code-affiche", setup: () => ((panel["pair"] = { kind: "showing", request: { code: "482913", cancel() {} } }), (panel["status"] = null)) },
      { name: "saisie-vide", setup: () => ((panel["pair"] = { kind: "entering", digits: "" }), (panel["status"] = null)) },
      { name: "saisie-complete", setup: () => ((panel["pair"] = { kind: "entering", digits: "482913" }), (panel["status"] = null)) },
      { name: "verification", setup: () => ((panel["pair"] = { kind: "confirming" }), (panel["status"] = null)) },
      ...statuses.map((status) => ({ name: `statut-${status.replace("pair.", "")}`, setup: () => idle(status) })),
      { name: "survol-jumeler", setup: () => (idle(null), panel["hovered"].set(fakeHand, "start")) },
    ],
  };
}

function scoresGroup(): Group {
  let panel: AnyPanel;
  let lore = fakeLore();
  return {
    panel: "classement",
    make: () => (panel = new ScoresMenu(camera, parent, (lore = fakeLore()), sfx, () => {}) as AnyPanel),
    scenarios: [
      { name: "hors-ligne", setup: () => (lore.serverProfile = null) },
      { name: "aucun-score", setup: () => (lore.serverProfile = { recoveryCode: "K7-AAAA-BBBB", pseudo: null, loreCount: 0, bestRuns: [] }) },
      { name: "sept-scores", setup: () => (lore.serverProfile = { recoveryCode: "K7-AAAA-BBBB", pseudo: null, loreCount: 0, bestRuns: runs("Silencieux-Explorateur-0042") }) },
      { name: "pseudos-40-caracteres", setup: () => (lore.serverProfile = { recoveryCode: "K7-AAAA-BBBB", pseudo: null, loreCount: 0, bestRuns: runs(MAX_PSEUDO).map((run) => ({ ...run, pseudo: MAX_PSEUDO, depth: 999 })) }) },
      { name: "pseudo-long-niveau-3-chiffres", setup: () => (lore.serverProfile = { recoveryCode: "K7-AAAA-BBBB", pseudo: null, loreCount: 0, bestRuns: runs(LONG_PSEUDO).map((run) => ({ ...run, depth: 128 })) }) },
    ],
  };
}

function settingsGroup(): Group {
  let panel: AnyPanel;
  const state = { vignette: true, pseudo: null as string | null };
  const list = (setup?: () => void) => () => {
    panel["mode"] = "list";
    panel["statusUntil"] = 0;
    state.vignette = true;
    state.pseudo = "Silencieux-Explorateur-0042";
    setDebugMenuEnabled(false);
    setup?.();
  };
  const status = (key: TranslationKey, vars: Record<string, string> = {}) =>
    list(() => {
      panel["statusMessage"] = t(key, vars);
      panel["statusUntil"] = 1;
    });
  const pseudoMode = (adjective: number, noun: number, suffix: number) => () => {
    panel["mode"] = "pseudo";
    panel["statusUntil"] = 0;
    panel["adjectiveIndex"] = adjective;
    panel["nounIndex"] = noun;
    panel["suffix"] = suffix;
  };
  const pseudoVariants: Scenario[] = [];
  for (let a = 0; a < PSEUDO_ADJECTIVE_COUNT; a++) {
    for (let n = 0; n < PSEUDO_NOUN_COUNT; n++) pseudoVariants.push({ name: `pseudo-${a}-${n}`, setup: pseudoMode(a, n, 9999), score: generatePseudoSuggestion(a, n, 9999).length });
  }
  return {
    panel: "parametres",
    make: () =>
      (panel = new SettingsMenu(camera, parent, sfx, {
        recalibrateHeight() {},
        vignetteEnabled: () => state.vignette,
        toggleVignette: () => state.vignette,
        currentPseudo: () => state.pseudo,
        setPseudo: async (pseudo: string) => pseudo,
        back() {},
      }) as AnyPanel),
    scenarios: [
      { name: "liste", setup: list() },
      { name: "sans-pseudo", setup: list(() => (state.pseudo = null)) },
      { name: "pseudo-40-caracteres", setup: list(() => (state.pseudo = MAX_PSEUDO)) },
      { name: "vignette-non", setup: list(() => (state.vignette = false)) },
      { name: "debug-active", setup: list(() => setDebugMenuEnabled(true)) },
      { name: "statut-langue", setup: status("inv.langStatus") },
      { name: "statut-vignette-on", setup: status("inv.vignetteOnStatus") },
      { name: "statut-vignette-off", setup: status("inv.vignetteOffStatus") },
      { name: "statut-hauteur", setup: status("inv.heightStatus") },
      { name: "statut-debug-on", setup: status("settings.debugOnStatus") },
      { name: "statut-debug-off", setup: status("settings.debugOffStatus") },
      { name: "statut-pseudo-enregistre", setup: status("settings.pseudoSet", { pseudo: MAX_PSEUDO }) },
      { name: "statut-pseudo-echec", setup: status("settings.pseudoFailed") },
      { name: "choix-pseudo", setup: pseudoMode(0, 0, 42) },
      { name: "survol-pseudo", setup: list(() => panel["hovered"].set(fakeHand, "pseudo")) },
    ],
    sweeps: [{ name: "choix-pseudo-toutes-combinaisons", variants: pseudoVariants }],
  };
}

const LEADERBOARD = (pseudo: string, count = 7) => runs(pseudo, count).map((run) => ({ pseudo: run.pseudo, depth: run.depth, endedAt: 0 }));

function endRunGroup(): Group {
  let panel: AnyPanel;
  const phase = (name: string, reason: string | null, setup: () => void): Scenario => ({
    name,
    setup: () => {
      panel["gameOverReason"] = reason;
      panel["depthReached"] = 12;
      panel["adjectiveIndex"] = 0;
      panel["nounIndex"] = 0;
      panel["suffix"] = 42;
      panel["submittedPseudo"] = "Silencieux-Explorateur-0042";
      panel["leaderboard"] = LEADERBOARD("Silencieux-Explorateur-0042");
      panel["errorMessage"] = t("end.error");
      setup();
    },
  });
  const reasons = [null, "health", "caught", "victory"] as const;
  return {
    panel: "fin-de-run",
    make: () => (panel = new EndRunScreen(camera, parent, sfx, async () => ({ leaderboard: [] }), () => {}, () => {}, () => null) as AnyPanel),
    scenarios: reasons.flatMap((reason) => [
      phase(`saisie-${reason ?? "volontaire"}`, reason, () => (panel["phase"] = "review")),
      phase(`resultat-${reason ?? "volontaire"}`, reason, () => (panel["phase"] = "result")),
    ]).concat([
      phase("envoi-en-cours", "caught", () => (panel["phase"] = "submitting")),
      phase("erreur-reseau", "caught", () => (panel["phase"] = "error")),
      phase("erreur-reseau-volontaire", null, () => (panel["phase"] = "error")),
      phase("resultat-pseudos-40-caracteres", "victory", () => {
        panel["phase"] = "result";
        panel["submittedPseudo"] = MAX_PSEUDO;
        panel["leaderboard"] = LEADERBOARD(MAX_PSEUDO).map((entry) => ({ ...entry, pseudo: MAX_PSEUDO, depth: 999 }));
      }),
      phase("resultat-classement-vide", null, () => {
        panel["phase"] = "result";
        panel["leaderboard"] = [];
      }),
      phase("saisie-pseudo-long", "victory", () => {
        panel["phase"] = "review";
        panel["adjectiveIndex"] = 7;
        panel["nounIndex"] = 5;
        panel["suffix"] = 9999;
      }),
    ]),
    sweeps: [
      {
        name: "saisie-toutes-combinaisons",
        variants: Array.from({ length: PSEUDO_ADJECTIVE_COUNT * PSEUDO_NOUN_COUNT }, (_, index) => {
          const a = Math.floor(index / PSEUDO_NOUN_COUNT);
          const n = index % PSEUDO_NOUN_COUNT;
          return phase(`saisie-${a}-${n}`, "victory", () => {
            panel["phase"] = "review";
            panel["adjectiveIndex"] = a;
            panel["nounIndex"] = n;
            panel["suffix"] = 9999;
          });
        }),
      },
    ],
  };
}

function debugGroup(): Group {
  let panel: AnyPanel;
  const kinds = [...COLLECTIBLE_KINDS, ...Object.keys(PROP_HALF_EXTENTS)];
  const longestKind = kinds.reduce((best, kind) => (kind.length > best.length ? kind : best), "");
  const labels = (kind: string): Array<() => string> => [() => t("debug.blackoutStop"), () => t("debug.cadreurStop"), () => t("debug.level"), () => t("debug.battery"), () => t("debug.spawn", { kind })];
  const makeActions = (kind: string) => labels(kind).map((label) => ({ label, run: () => "" }));
  const message = (key: TranslationKey, vars: Record<string, string> = {}): Scenario => ({
    name: `statut-${key.replace("debug.", "")}`,
    setup: () => {
      panel["actions"] = makeActions(longestKind);
      panel["statusMessage"] = t(key, vars);
      panel["statusUntil"] = 1;
    },
  });
  return {
    panel: "debug",
    make: () => (panel = new DebugMenu(camera, parent, sfx, makeActions(longestKind)) as AnyPanel),
    scenarios: [
      { name: "defaut", setup: () => ((panel["actions"] = makeActions("photo")), (panel["statusUntil"] = 0)) },
      { name: "spawn-nom-le-plus-long", setup: () => ((panel["actions"] = makeActions(longestKind)), (panel["statusUntil"] = 0)) },
      message("debug.blackoutStarted"),
      message("debug.blackoutStopped"),
      message("debug.cadreurCalled"),
      message("debug.cadreurDismissed"),
      message("debug.levelDone"),
      message("debug.batteryDone"),
      message("debug.spawnStarted", { kind: longestKind }),
    ],
    sweeps: [
      {
        name: "spawn-tous-les-objets",
        variants: kinds.map((kind) => ({ name: `spawn-${kind}`, score: kind.length, setup: () => ((panel["actions"] = makeActions(kind)), (panel["statusUntil"] = 0)) })),
      },
    ],
  };
}

function entryFor(kind: (typeof COLLECTIBLE_KINDS)[number], nameRoll: number, descriptionRoll: number, depth = 128): CollectionEntry {
  const lore = generateCollectibleLore(kind, nameRoll, descriptionRoll);
  return { id: `${kind}-${nameRoll}-${descriptionRoll}`, kind, rarity: getCollectibleRarity(kind), scale: 1, depth, ...lore, collectedAt: 0 };
}

function inventoryGroup(): Group {
  let panel: AnyPanel;
  let store: CollectionStore;
  let debugEnabled = false;
  const fill = (entries: CollectionEntry[]): void => {
    store["entries"] = entries;
    panel["page"] = 0;
    panel["picked"] = null;
    panel["statusUntil"] = 0;
    panel["hoverSlot"].clear();
    panel["hoverButton"].clear();
    debugEnabled = false;
  };
  const sample = (count: number): CollectionEntry[] => COLLECTIBLE_KINDS.slice(0, count).map((kind, i) => entryFor(kind, i / 5, i / 4));
  const focus = (entry: CollectionEntry, slot = 0): (() => void) => () => {
    fill([entry]);
    panel["hoverSlot"].set(fakeHand, slot);
  };
  const scenarios: Scenario[] = [
    { name: "vide", setup: () => fill([]) },
    { name: "dix-objets", setup: () => fill(sample(10)) },
    {
      name: "trois-pages",
      setup: () => {
        fill(sample(25));
        panel["page"] = 2;
      },
    },
    {
      name: "compteur-trois-chiffres",
      setup: () => {
        fill(Array.from({ length: 120 }, (_, i) => entryFor(COLLECTIBLE_KINDS[i % COLLECTIBLE_KINDS.length]!, 0, 0, 999)));
        panel["page"] = 11;
      },
    },
    { name: "debug-active", setup: () => (fill(sample(4)), (debugEnabled = true)) },
    {
      name: "objet-selectionne",
      setup: () => {
        fill(sample(4));
        panel["picked"] = 1;
        panel["statusMessage"] = t("inv.picked");
        panel["statusUntil"] = 1;
      },
    },
    { name: "statut-deplace", setup: () => (fill(sample(4)), (panel["statusMessage"] = t("inv.moved")), (panel["statusUntil"] = 1)) },
    { name: "survol-bouton-tri", setup: () => (fill(sample(4)), panel["hoverButton"].set(fakeHand, "sort")) },
  ];
  for (const mode of ["recent", "rarity", "depth", "name"] as const) {
    scenarios.push({
      name: `statut-tri-${mode}`,
      setup: () => {
        fill(sample(4));
        panel["statusMessage"] = t("inv.sortStatus", { mode: t(`sort.${mode}` as TranslationKey) });
        panel["statusUntil"] = 1;
      },
    });
  }
  // Balayage : chaque objet du catalogue × chaque gabarit de nom × chaque description, en survol.
  const variants: Scenario[] = [];
  for (const kind of COLLECTIBLE_KINDS) {
    for (let nameRoll = 0; nameRoll < 5; nameRoll++) {
      for (let descRoll = 0; descRoll < 4; descRoll++) {
        const entry = entryFor(kind, nameRoll / 5 + 0.01, descRoll / 4 + 0.01);
        variants.push({ name: `objet-${entry.id}`, setup: focus(entry), score: entry.nameFr.length + entry.descriptionFr.length + entry.nameEn.length + entry.descriptionEn.length });
      }
    }
  }
  return {
    panel: "inventaire",
    make: () => {
      store = new CollectionStore();
      panel = new InventoryMenu(
        store,
        camera,
        parent,
        { takeOut() {}, openJournal() {}, openSettings() {}, openMainMenu() {}, isDebugEnabled: () => debugEnabled, openDebugMenu() {} },
        sfx,
      ) as AnyPanel;
      return panel;
    },
    scenarios,
    sweeps: [{ name: "survol-tous-les-objets", variants }],
  };
}

function journalGroup(): Group {
  let panel: AnyPanel;
  let lore = fakeLore();
  const at = (count: number, selected: number): (() => void) => () => {
    lore.count = count;
    panel["selected"] = selected;
  };
  const variants: Scenario[] = Array.from({ length: LORE_FRAGMENT_COUNT }, (_, i) => ({ name: `archive-${i + 1}`, setup: at(LORE_FRAGMENT_COUNT, i) }));
  return {
    panel: "journal",
    make: () => (panel = new Journal(camera, parent, (lore = fakeLore()), sfx) as AnyPanel),
    scenarios: [
      { name: "aucune-archive", setup: at(0, 0) },
      { name: "une-archive", setup: at(1, 0) },
      { name: "archive-audio", setup: at(5, 4) },
      { name: "archive-non-lue-selectionnee", setup: at(5, 9) },
      { name: "recit-complet-derniere", setup: at(LORE_FRAGMENT_COUNT, LORE_FRAGMENT_COUNT - 1) },
      { name: "survol-fermer", setup: () => (at(3, 1)(), panel["hovered"].set(fakeHand, "tab:close")) },
    ],
    sweeps: [{ name: "toutes-les-archives", variants }],
  };
}

// ---------------------------------------------------------------------------------------------
// Exécution.
// ---------------------------------------------------------------------------------------------
interface Shot {
  panel: string;
  scenario: string;
  lang: Language;
  png: string;
}

const shots: Shot[] = [];
const issues: Issue[] = [];
const stats = { renders: 0 };

function render(group: Group, panel: AnyPanel, scenario: Scenario, lang: Language): { issues: Issue[]; png: string } {
  scenario.setup();
  drawn = [];
  buttons = [];
  pendingButton = null;
  frameIssues = [];
  activeCanvas = panel.canvas;
  panel["dirty"] = true;
  panel["draw"](panel["ctx"]);
  analyze(panel.canvas);
  activeCanvas = null;
  stats.renders += 1;

  // Un même défaut listé plusieurs fois (ex. deux textes qui se chevauchent) n'est rapporté qu'une fois.
  const seen = new Set<string>();
  const found: Issue[] = [];
  for (const issue of frameIssues) {
    const key = `${issue.kind}|${issue.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ lang, panel: group.panel, scenario: scenario.name, ...issue });
  }
  const composite = document.createElement("canvas");
  composite.width = panel.canvas.width;
  composite.height = panel.canvas.height;
  const cctx = composite.getContext("2d")!;
  cctx.fillStyle = "#6b6238";
  cctx.fillRect(0, 0, composite.width, composite.height);
  cctx.drawImage(panel.canvas, 0, 0);
  return { issues: found, png: composite.toDataURL("image/png") };
}

async function main(): Promise<void> {
  const advance = (() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = "100px monospace";
    return { font: ctx.font, emPerChar: ctx.measureText("MMMMMMMMMM").width / 1000, narrow: ctx.measureText("iiiiiiiiii").width / 1000 };
  })();

  const groups = [mainMenuGroup(), guideGroup(), deviceGroup(), scoresGroup(), settingsGroup(), inventoryGroup(), journalGroup(), endRunGroup(), debugGroup()];
  for (const lang of ["fr", "en"] as const) {
    setLanguage(lang);
    for (const group of groups) {
      const panel = group.make();
      for (const scenario of group.scenarios) {
        const result = render(group, panel, scenario, lang);
        issues.push(...result.issues);
        shots.push({ panel: group.panel, scenario: scenario.name, lang, png: result.png });
      }
      for (const sweep of group.sweeps ?? []) {
        let best: { scenario: Scenario; result: ReturnType<typeof render> } | null = null;
        let withIssues = 0;
        for (const variant of sweep.variants) {
          const result = render(group, panel, variant, lang);
          issues.push(...result.issues.map((issue) => ({ ...issue, scenario: `${sweep.name} › ${variant.name}` })));
          if (result.issues.length > 0 && withIssues < 3) {
            withIssues += 1;
            shots.push({ panel: group.panel, scenario: `${sweep.name}-probleme-${withIssues}-${variant.name}`, lang, png: result.png });
          }
          if (!best || (variant.score ?? 0) > (best.scenario.score ?? 0)) best = { scenario: variant, result };
        }
        if (best) shots.push({ panel: group.panel, scenario: `${sweep.name}-pire-cas-${best.scenario.name}`, lang, png: best.result.png });
      }
    }
  }
  (window as unknown as Record<string, unknown>)["__MENUS_RESULT__"] = { shots, issues, advance, renders: stats.renders };
  document.getElementById("results")!.textContent = `${stats.renders} rendus, ${shots.length} captures, ${issues.length} problème(s).`;
  (window as unknown as Record<string, unknown>)["__MENUS_DONE__"] = true;
}

main().catch((error: unknown) => {
  console.error(error);
  document.getElementById("results")!.textContent = `ERREUR : ${String(error)}`;
  (window as unknown as Record<string, unknown>)["__MENUS_ERROR__"] = String(error);
});
