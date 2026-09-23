import { getPlayerId } from "./playerId";

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

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} a répondu ${response.status}`);
  return (await response.json()) as T;
}

/** Démarre une run côté serveur : seed + token signé, source de vérité pour le classement. */
export async function startRun(): Promise<RunSessionInfo> {
  const playerId = await getPlayerId();
  return postJson<RunSessionInfo>("/api/run/start", { playerId });
}

/** Signale un passage de level pour la validation anti-triche serveur — best-effort, ne bloque jamais le jeu local. */
export function reportLevel(session: RunSessionInfo, depth: number): void {
  postJson("/api/run/level", { runId: session.runId, token: session.token, depth }).catch(() => {});
}

/** Clôture la run ("STOP REC") avec le pseudo choisi ; renvoie le classement mis à jour. */
export async function endRun(session: RunSessionInfo, pseudo: string): Promise<{ leaderboard: LeaderboardEntry[] }> {
  return postJson("/api/run/end", { runId: session.runId, token: session.token, pseudo });
}

export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  const response = await fetch("/api/leaderboard");
  if (!response.ok) throw new Error(`leaderboard a répondu ${response.status}`);
  const data = (await response.json()) as { leaderboard: LeaderboardEntry[] };
  return data.leaderboard;
}
