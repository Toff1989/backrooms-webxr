import { apiCall, ensureIdentity } from "./playerIdentity";

/**
 * Client de l'API de classement (fiche projet étape 7). Chemins relatifs `/api/...` :
 * en dev, `vite.config.ts` proxie vers le serveur Node local ; en prod, le même domaine
 * sert le front (statique) et l'API depuis un seul process (voir `server/src/server.ts`).
 */
export interface RunSessionInfo {
  runId: string;
  token: string;
  seed: string;
}

export interface LeaderboardEntry {
  pseudo: string;
  depth: number;
  endedAt: number;
}

const pendingLevelReports = new WeakMap<RunSessionInfo, Promise<void>>();

/** Démarre une run côté serveur (rattachée à l'identité de l'appareil) : seed + token signé. */
export async function startRun(): Promise<RunSessionInfo> {
  if (!(await ensureIdentity())) throw new Error("Serveur injoignable : pas d'identité");
  return apiCall<RunSessionInfo>("POST", "/run/start", {});
}

/** Signale un passage de level pour la validation anti-triche serveur — best-effort, ne bloque jamais le jeu local. */
export function reportLevel(session: RunSessionInfo, depth: number): void {
  const previous = pendingLevelReports.get(session) ?? Promise.resolve();
  const report = previous.catch(() => {}).then(() => apiCall("POST", "/run/level", { runId: session.runId, token: session.token, depth })).then(() => undefined);
  pendingLevelReports.set(session, report);
  void report.catch(() => {});
}

/** Clôture la run ("STOP REC") avec le pseudo choisi ; renvoie le classement mis à jour. */
export async function endRun(session: RunSessionInfo, pseudo: string): Promise<{ leaderboard: LeaderboardEntry[] }> {
  await pendingLevelReports.get(session)?.catch(() => {});
  return apiCall("POST", "/run/end", { runId: session.runId, token: session.token, pseudo });
}
