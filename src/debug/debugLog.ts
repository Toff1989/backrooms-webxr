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

const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER = 2000;
const MAX_MEMORY = 5000;

type Entry = { t: number; type: string } & Record<string, unknown>;

const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
const pending: Entry[] = [];
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
