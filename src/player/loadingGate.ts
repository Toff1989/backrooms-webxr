import { t } from "../i18n";
import type { VhsOverlay } from "./vhsOverlay";

/** Cadence de frame (ms) sous laquelle une frame est considérée "sans à-coup". */
const MAX_FRAME_MS = 33;
/** Nombre de frames consécutives sans à-coup avant de refermer l'écran de chargement. */
const STABLE_FRAMES = 30;
/** Filet de sécurité : referme quand même l'écran passé ce délai, pour ne jamais coincer le joueur. */
const TIMEOUT_SECONDS = 8;

/**
 * Écran de chargement unique (écran bleu VHS tenu, voir `vhsOverlay.showLoading`) pour toute
 * phase où le jeu doit préparer quelque chose en arrière-plan : démarrage, changement de level,
 * aller-retour vers le niveau 0 fictif du menu principal. Deux conditions doivent être réunies
 * avant de le refermer : le travail annoncé par l'appelant est terminé (`ready`) ET quelques
 * dizaines de frames ont été rendues sans à-coup (compilation de shaders, streaming de chunks
 * encore en cours sinon) — avec un filet de sécurité (délai maximum) pour un appareil trop lent.
 */
export class LoadingGate {
  private active = false;
  private contentReady = false;
  private stableStreak = 0;
  private startedAt = 0;
  private onDone: () => void = () => this.overlay.hideLoading();

  constructor(private readonly overlay: VhsOverlay) {}

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Démarre (ou redémarre) le chargement. `onDone` : ce qui referme l'écran une fois prêt —
   * par défaut `hideLoading`, mais un changement de level y substitue le carton "NIV {n}"
   * (voir `showCard`) avant de vraiment disparaître.
   */
  start(lines: string[] = [t("blue.loading")], onDone?: () => void): void {
    this.active = true;
    this.contentReady = false;
    this.stableStreak = 0;
    this.startedAt = performance.now();
    this.onDone = onDone ?? (() => this.overlay.hideLoading());
    this.overlay.showLoading(lines);
  }

  /** Le travail de fond annoncé par l'appelant est terminé (le monde visé est reconstruit). */
  ready(): void {
    this.contentReady = true;
  }

  update(deltaSeconds: number): void {
    if (!this.active) return;
    this.stableStreak = deltaSeconds * 1000 <= MAX_FRAME_MS ? this.stableStreak + 1 : 0;
    const timedOut = performance.now() - this.startedAt >= TIMEOUT_SECONDS * 1000;
    if (!timedOut && (!this.contentReady || this.stableStreak < STABLE_FRAMES)) return;
    this.active = false;
    this.onDone();
  }
}
