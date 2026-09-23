import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = process.env["DB_PATH"] ?? "./data/backrooms.sqlite";

const dir = dirname(DB_PATH);
if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/** Schéma (fiche projet étape 7). `runs.status` : "active" tant que la run est en cours, "ended" une fois le score soumis. */
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    seed TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    depth INTEGER NOT NULL DEFAULT 0,
    pseudo TEXT,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS levels (
    run_id TEXT NOT NULL REFERENCES runs(id),
    idx INTEGER NOT NULL,
    reached_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, idx)
  );

  CREATE INDEX IF NOT EXISTS idx_runs_leaderboard ON runs (status, depth DESC, ended_at ASC);
`);

export interface RunRow {
  id: string;
  player_id: string;
  seed: string;
  started_at: number;
  ended_at: number | null;
  depth: number;
  pseudo: string | null;
  status: "active" | "ended";
}

const insertRun = db.prepare<{ id: string; playerId: string; seed: string; startedAt: number }>(
  `INSERT INTO runs (id, player_id, seed, started_at, depth, status) VALUES (@id, @playerId, @seed, @startedAt, 0, 'active')`,
);
const getRun = db.prepare<{ id: string }, RunRow>(`SELECT * FROM runs WHERE id = @id`);
const updateRunDepth = db.prepare<{ id: string; depth: number }>(`UPDATE runs SET depth = @depth WHERE id = @id`);
const endRunStmt = db.prepare<{ id: string; pseudo: string; endedAt: number }>(
  `UPDATE runs SET pseudo = @pseudo, ended_at = @endedAt, status = 'ended' WHERE id = @id`,
);
const insertLevel = db.prepare<{ runId: string; idx: number; reachedAt: number }>(
  `INSERT OR IGNORE INTO levels (run_id, idx, reached_at) VALUES (@runId, @idx, @reachedAt)`,
);
const getLatestLevel = db.prepare<{ runId: string }, { idx: number; reached_at: number }>(
  `SELECT idx, reached_at FROM levels WHERE run_id = @runId ORDER BY idx DESC LIMIT 1`,
);
const leaderboardStmt = db.prepare<{ limit: number }, { pseudo: string; depth: number; ended_at: number }>(
  `SELECT pseudo, depth, ended_at FROM runs WHERE status = 'ended' AND pseudo IS NOT NULL ORDER BY depth DESC, ended_at ASC LIMIT @limit`,
);

export function createRun(playerId: string, seed: string): RunRow {
  const id = randomUUID();
  const startedAt = Date.now();
  insertRun.run({ id, playerId, seed, startedAt });
  return getRun.get({ id })!;
}

export function findRun(id: string): RunRow | undefined {
  return getRun.get({ id });
}

/** Dernier level validé (ou la run elle-même, pour le tout premier passage) : sert de référence de temps pour la validation anti-triche. */
export function latestCheckpointTime(run: RunRow): number {
  const latest = getLatestLevel.get({ runId: run.id });
  return latest ? latest.reached_at : run.started_at;
}

export function recordLevel(runId: string, depth: number): void {
  insertLevel.run({ runId, idx: depth, reachedAt: Date.now() });
  updateRunDepth.run({ id: runId, depth });
}

export function endRun(runId: string, pseudo: string): void {
  endRunStmt.run({ id: runId, pseudo, endedAt: Date.now() });
}

export function getLeaderboard(limit: number): Array<{ pseudo: string; depth: number; endedAt: number }> {
  return leaderboardStmt.all({ limit }).map((row) => ({ pseudo: row.pseudo, depth: row.depth, endedAt: row.ended_at }));
}
