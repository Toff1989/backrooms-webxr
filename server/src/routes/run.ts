import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createRun, endRun as endRunRow, findRun, getLeaderboard, latestCheckpointTime, recordLevel } from "../db.js";
import { signRunToken, verifyRunToken } from "../token.js";
import { sanitizePseudo } from "../wordFilter.js";
import { computeMinPlausibleMillis } from "../validation.js";

/** Marge de tolérance sur le temps minimum plausible (horloge/latence réseau) — le plancher physique reste `distance / PLAYER_MOVE_SPEED`, voir `validation.ts`. */
const TIMING_TOLERANCE = 0.85;
const LEADERBOARD_SIZE = 50;

interface StartBody {
  playerId?: unknown;
}
interface LevelBody {
  runId?: unknown;
  token?: unknown;
  depth?: unknown;
}
interface EndBody {
  runId?: unknown;
  token?: unknown;
  pseudo?: unknown;
}

export function registerRunRoutes(app: FastifyInstance): void {
  app.post<{ Body: StartBody }>("/run/start", async (request, reply) => {
    const { playerId } = request.body;
    if (typeof playerId !== "string" || playerId.length === 0) {
      return reply.code(400).send({ error: "playerId manquant" });
    }

    const seed = randomUUID();
    const run = createRun(playerId, seed);
    return { runId: run.id, token: signRunToken(run.id), seed: run.seed };
  });

  app.post<{ Body: LevelBody }>("/run/level", async (request, reply) => {
    const { runId, token, depth } = request.body;
    if (typeof runId !== "string" || typeof token !== "string" || typeof depth !== "number" || !Number.isInteger(depth)) {
      return reply.code(400).send({ error: "requête invalide" });
    }
    if (!verifyRunToken(runId, token)) return reply.code(403).send({ error: "token invalide" });

    const run = findRun(runId);
    if (!run || run.status !== "active") return reply.code(404).send({ error: "run introuvable ou déjà close" });
    if (depth !== run.depth + 1) return reply.code(409).send({ error: "profondeur non séquentielle" });

    const minPlausibleMillis = computeMinPlausibleMillis(run.seed, run.depth);
    const elapsedMillis = Date.now() - latestCheckpointTime(run);
    if (elapsedMillis < minPlausibleMillis * TIMING_TOLERANCE) {
      return reply.code(422).send({ error: "temps de passage implausible" });
    }

    recordLevel(runId, depth);
    return { ok: true, depth };
  });

  app.post<{ Body: EndBody }>("/run/end", async (request, reply) => {
    const { runId, token, pseudo } = request.body;
    if (typeof runId !== "string" || typeof token !== "string") {
      return reply.code(400).send({ error: "requête invalide" });
    }
    if (!verifyRunToken(runId, token)) return reply.code(403).send({ error: "token invalide" });

    const run = findRun(runId);
    if (!run || run.status !== "active") return reply.code(404).send({ error: "run introuvable ou déjà close" });

    const cleanPseudo = sanitizePseudo(pseudo);
    endRunRow(runId, cleanPseudo);

    return { pseudo: cleanPseudo, depth: run.depth, leaderboard: getLeaderboard(LEADERBOARD_SIZE) };
  });
}

export function registerLeaderboardRoute(app: FastifyInstance): void {
  app.get("/leaderboard", async () => ({ leaderboard: getLeaderboard(LEADERBOARD_SIZE) }));
}
