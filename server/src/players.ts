import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { LORE_FRAGMENT_COUNT } from "../../src/shared/lore.js";
import { db } from "./db.js";

/**
 * Identité anonyme des joueurs, sans compte : chaque appareil reçoit un secret aléatoire (on
 * n'en garde que l'empreinte SHA-256) qui le rattache à un joueur. Un joueur peut avoir
 * plusieurs appareils (jumelage façon télé, ou code de cassette) ; ses runs et sa progression
 * des bandes perdues lui sont rattachées.
 *
 * Le code de cassette (récupération) est gardé en clair : c'est un code de sauvegarde de jeu,
 * affiché au joueur sur chacun de ses appareils, comme les mots de passe des vieilles consoles.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    recovery_code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS player_devices (
    secret_hash TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lore_unlocks (
    player_id TEXT NOT NULL REFERENCES players(id),
    fragment INTEGER NOT NULL,
    run_id TEXT,
    depth INTEGER,
    unlocked_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, fragment)
  );

  CREATE INDEX IF NOT EXISTS idx_runs_player ON runs (player_id, status, depth DESC);
  CREATE INDEX IF NOT EXISTS idx_lore_run ON lore_unlocks (run_id);
`);

export interface Player {
  id: string;
  recoveryCode: string;
}

export interface Credentials {
  playerId: string;
  secret: string;
  recoveryCode: string;
}

/** Alphabet sans 0/O ni 1/I : un code se recopie sans ambiguïté. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function randomRecoveryCode(): string {
  let body = "";
  for (let i = 0; i < 8; i++) body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `K7-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Saisie libre ("k7 4f9q m2xr", "4F9QM2XR"...) → forme canonique `K7-XXXX-XXXX`, ou null. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let compact = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (compact.length === 10 && compact.startsWith("K7")) compact = compact.slice(2);
  if (compact.length !== 8 || [...compact].some((char) => !CODE_ALPHABET.includes(char))) return null;
  return `K7-${compact.slice(0, 4)}-${compact.slice(4)}`;
}

const insertPlayer = db.prepare<{ id: string; code: string; createdAt: number }>(
  `INSERT INTO players (id, recovery_code, created_at) VALUES (@id, @code, @createdAt)`,
);
const playerById = db.prepare<{ id: string }, { id: string; recovery_code: string }>(`SELECT id, recovery_code FROM players WHERE id = @id`);
const playerByCode = db.prepare<{ code: string }, { id: string; recovery_code: string }>(`SELECT id, recovery_code FROM players WHERE recovery_code = @code`);
const codeTaken = db.prepare<{ code: string }, { n: number }>(`SELECT COUNT(*) AS n FROM players WHERE recovery_code = @code`);
const insertDevice = db.prepare<{ hash: string; playerId: string; createdAt: number }>(
  `INSERT INTO player_devices (secret_hash, player_id, created_at) VALUES (@hash, @playerId, @createdAt)`,
);
const playerByDevice = db.prepare<{ hash: string }, { id: string; recovery_code: string }>(
  `SELECT p.id, p.recovery_code FROM player_devices d JOIN players p ON p.id = d.player_id WHERE d.secret_hash = @hash`,
);
const loreCountStmt = db.prepare<{ playerId: string }, { n: number }>(`SELECT COUNT(*) AS n FROM lore_unlocks WHERE player_id = @playerId`);
const loreAtLevelStmt = db.prepare<{ runId: string; depth: number }, { n: number }>(
  `SELECT COUNT(*) AS n FROM lore_unlocks WHERE run_id = @runId AND depth = @depth`,
);
const insertUnlock = db.prepare<{ playerId: string; fragment: number; runId: string | null; depth: number | null; at: number }>(
  `INSERT OR IGNORE INTO lore_unlocks (player_id, fragment, run_id, depth, unlocked_at) VALUES (@playerId, @fragment, @runId, @depth, @at)`,
);
const bestRunsStmt = db.prepare<{ playerId: string; limit: number }, { pseudo: string; depth: number; ended_at: number }>(
  `SELECT pseudo, depth, ended_at FROM runs WHERE player_id = @playerId AND status = 'ended' AND pseudo IS NOT NULL ORDER BY depth DESC, ended_at ASC LIMIT @limit`,
);

const toPlayer = (row: { id: string; recovery_code: string }): Player => ({ id: row.id, recoveryCode: row.recovery_code });

/** Nouvel appareil pour ce joueur : renvoie le secret (le seul moment où il existe en clair). */
export function issueDevice(player: Player): Credentials {
  const secret = randomBytes(32).toString("base64url");
  insertDevice.run({ hash: hashSecret(secret), playerId: player.id, createdAt: Date.now() });
  return { playerId: player.id, secret, recoveryCode: player.recoveryCode };
}

/**
 * Nouveau joueur. `legacyId` : ancien identifiant local (avant les identités serveur) — repris
 * s'il est libre, pour garder les runs déjà jouées ; `legacyLoreCount` : bandes déjà lues sur
 * cet appareil, importées une fois (récit solo, sans enjeu de classement).
 */
export const registerPlayer = db.transaction((legacyId: unknown, legacyLoreCount: unknown): Credentials => {
  const id = typeof legacyId === "string" && UUID_PATTERN.test(legacyId) && !playerById.get({ id: legacyId }) ? legacyId : randomUUID();
  let code = randomRecoveryCode();
  while (codeTaken.get({ code })!.n > 0) code = randomRecoveryCode();
  const now = Date.now();
  insertPlayer.run({ id, code, createdAt: now });
  const imported = typeof legacyLoreCount === "number" && Number.isInteger(legacyLoreCount) ? Math.max(0, Math.min(LORE_FRAGMENT_COUNT, legacyLoreCount)) : 0;
  for (let fragment = 0; fragment < imported; fragment++) insertUnlock.run({ playerId: id, fragment, runId: null, depth: null, at: now });
  return issueDevice({ id, recoveryCode: code });
});

/** Joueur authentifié par l'en-tête `Authorization: Bearer <secret de l'appareil>`, ou null. */
export function authenticate(request: FastifyRequest): Player | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const secret = header.slice("Bearer ".length).trim();
  if (secret.length < 20 || secret.length > 100) return null;
  const row = playerByDevice.get({ hash: hashSecret(secret) });
  return row ? toPlayer(row) : null;
}

export function findPlayerByRecoveryCode(code: string): Player | null {
  const row = playerByCode.get({ code });
  return row ? toPlayer(row) : null;
}

export function loreCount(playerId: string): number {
  return loreCountStmt.get({ playerId })!.n;
}

/** Une bande a-t-elle déjà été débloquée à ce level de cette run ? (une seule page par level) */
export function loreUnlockedAtLevel(runId: string, depth: number): boolean {
  return loreAtLevelStmt.get({ runId, depth })!.n > 0;
}

/** Enregistre les bandes jusqu'à `fragment` inclus (comble l'écart des bandes lues hors ligne). */
export const unlockLoreUpTo = db.transaction((playerId: string, fragment: number, runId: string, depth: number): number => {
  const now = Date.now();
  for (let index = loreCount(playerId); index <= fragment; index++) insertUnlock.run({ playerId, fragment: index, runId, depth, at: now });
  return loreCount(playerId);
});

export function bestRuns(playerId: string, limit = 5): Array<{ pseudo: string; depth: number; endedAt: number }> {
  return bestRunsStmt.all({ playerId, limit }).map((row) => ({ pseudo: row.pseudo, depth: row.depth, endedAt: row.ended_at }));
}

/**
 * Fusionne un joueur dans un autre (jumelage ou code de cassette saisi sur un appareil qui avait
 * déjà sa propre identité) : runs, bandes lues et appareils passent au joueur cible, qui garde
 * son code de cassette. Les bandes forment toujours un préfixe 0..n-1 : l'union en est un aussi.
 */
export const mergePlayers = db.transaction((fromId: string, intoId: string): void => {
  if (fromId === intoId) return;
  db.prepare(`UPDATE runs SET player_id = ? WHERE player_id = ?`).run(intoId, fromId);
  db.prepare(
    `INSERT OR IGNORE INTO lore_unlocks (player_id, fragment, run_id, depth, unlocked_at)
     SELECT ?, fragment, run_id, depth, unlocked_at FROM lore_unlocks WHERE player_id = ?`,
  ).run(intoId, fromId);
  db.prepare(`DELETE FROM lore_unlocks WHERE player_id = ?`).run(fromId);
  db.prepare(`UPDATE player_devices SET player_id = ? WHERE player_id = ?`).run(intoId, fromId);
  db.prepare(`DELETE FROM players WHERE id = ?`).run(fromId);
});
