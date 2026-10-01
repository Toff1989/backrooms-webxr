/**
 * Journal de debug (`?debug=1`) : tout ce qui aide à comprendre un lag ou un bug en casque,
 * envoyé au serveur toutes les 5 s (`POST /api/debug-log`, écrit dans
 * `server/logs/debug-AAAA-MM-JJ.jsonl`) — le casque n'a pas de console accessible en jeu.
 *
 * Contenu : erreurs et avertissements (console, exceptions, promesses rejetées), à-coups
 * (voir PerfStats) avec leurs causes, statistiques par seconde (FPS moyen/min, pire frame,
 * CPU par section, draw calls, triangles, mémoire, état audio, position/profondeur), et
 * événements (session XR, changement de niveau, chunks, audio). Aussi en mémoire : `__log`.
 */

export const DEBUG_ENABLED = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

/**
 * Visibilité du menu debug in-game (bouton dédié dans l'inventaire) : distincte de
 * `DEBUG_ENABLED` (qui gate le journal envoyé au serveur, fixé une fois pour toutes par
 * l'URL). Celle-ci peut être basculée à la volée depuis le menu Paramètres, sans recharger la
 * page ; elle démarre alignée sur `DEBUG_ENABLED` pour que `?debug` continue de tout activer.
 */
let debugMenuEnabled = DEBUG_ENABLED;
export function isDebugMenuEnabled(): boolean {
  return debugMenuEnabled;
}
export function setDebugMenuEnabled(value: boolean): void {
  debugMenuEnabled = value;
}

/**
 * Le menu debug ne s'active depuis les Paramètres qu'avec un code à 4 chiffres : seule l'empreinte
 * SHA-256 (salée) en est stockée ici, jamais le code. Pour en changer, remplacer l'empreinte :
 * `printf 'backrooms-vr:debug:CODE' | sha256sum`.
 */
const DEBUG_CODE_HASH = "2f9a2a93ac632b71ead2cf4af3bc7039e7d4059904df40f92ec3092b8ba4ab41";
export const DEBUG_CODE_LENGTH = 4;

/** Vrai si `code` est le bon code debug (faux aussi si le navigateur n'offre pas WebCrypto). */
export async function verifyDebugCode(code: string): Promise<boolean> {
  if (code.length !== DEBUG_CODE_LENGTH || !globalThis.crypto?.subtle) return false;
  const bytes = new TextEncoder().encode(`backrooms-vr:debug:${code}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === DEBUG_CODE_HASH;
}

const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER = 2000;
const MAX_MEMORY = 5000;

type Entry = { t: number; type: string } & Record<string, unknown>;

const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
const pending: Entry[] = [];
/** Envois au serveur (nombre, taille du dernier) : PerfStats les joint aux à-coups voisins. */
export const flushStats = { count: 0, lastBytes: 0 };
const memory: Entry[] = [];
let installed = false;

/** Ajoute une entrée au journal (sans effet hors mode debug). */
export function log(type: string, data: Record<string, unknown> = {}): void {
  if (!DEBUG_ENABLED) return;
  const entry: Entry = { t: Math.round(performance.now() - startedAt), type, ...data };
  pending.push(entry);
  if (pending.length > MAX_BUFFER) pending.splice(0, pending.length - MAX_BUFFER);
  memory.push(entry);
  if (memory.length > MAX_MEMORY) memory.shift();
}

function flush(useBeacon = false): void {
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  const body = JSON.stringify({ session, entries: batch });
  flushStats.count++;
  flushStats.lastBytes = body.length;
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/debug-log", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/api/debug-log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: body.length < 60000 }).catch(() => {
    // Serveur injoignable : on remet le lot en tête pour le prochain envoi.
    pending.unshift(...batch.slice(-MAX_BUFFER));
  });
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`.slice(0, 2000);
  if (typeof value === "string") return value.slice(0, 2000);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return String(value).slice(0, 2000);
  }
}

/** Branche les captures globales (erreurs, console) et l'envoi périodique. À appeler une fois. */
export function installDebugLog(): void {
  if (!DEBUG_ENABLED || installed) return;
  installed = true;

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      log(`console.${level}`, { message: args.map(describe).join(" ") });
      original(...args);
    };
  }
  window.addEventListener("error", (event) => log("error", { message: describe(event.error ?? event.message), source: `${event.filename}:${event.lineno}` }));
  window.addEventListener("unhandledrejection", (event) => log("unhandledrejection", { message: describe(event.reason) }));
  document.addEventListener("visibilitychange", () => {
    log("visibility", { state: document.visibilityState });
    if (document.visibilityState === "hidden") flush(true);
  });

  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number };
  log("start", {
    build: __BUILD_ID__,
    url: location.href,
    userAgent: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    deviceMemory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
  });

  window.setInterval(() => flush(), FLUSH_INTERVAL_MS);
  (window as unknown as Record<string, unknown>)["__log"] = { session, entries: memory, flush };
}
