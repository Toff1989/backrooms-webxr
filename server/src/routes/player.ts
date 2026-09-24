import type { FastifyInstance } from "fastify";
import { LORE_FRAGMENT_COUNT } from "../../../src/shared/lore.js";
import { findRun } from "../db.js";
import { completePairing, pendingPairing, pollPairing, startPairing } from "../pairing.js";
import {
  authenticate,
  bestRuns,
  findPlayerByRecoveryCode,
  issueDevice,
  loreCount,
  loreUnlockedAtLevel,
  mergePlayers,
  normalizeRecoveryCode,
  registerPlayer,
  unlockLoreUpTo,
} from "../players.js";
import { verifyRunToken } from "../token.js";

/** Bandes lues hors ligne (non envoyées) qu'une lecture en ligne peut rattraper d'un coup. */
const OFFLINE_LORE_SLACK = 3;
const PAIR_CODE_PATTERN = /^\d{6}$/;

/** Limites plus strictes que le quota général de l'API sur les routes qui testent un code. */
const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

interface RegisterBody {
  legacyId?: unknown;
  loreCount?: unknown;
}
interface RestoreBody {
  code?: unknown;
}
interface PollBody {
  code?: unknown;
  pollToken?: unknown;
}
interface ConfirmBody {
  code?: unknown;
}
interface UnlockBody {
  runId?: unknown;
  token?: unknown;
  fragment?: unknown;
}

/**
 * Identité anonyme (voir `players.ts`) : inscription automatique au premier lancement, profil
 * (code de cassette, bandes lues, meilleures runs), récupération par code de cassette, jumelage
 * façon télé, et déblocage des bandes perdues validé contre la run en cours.
 */
export function registerPlayerRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegisterBody }>("/player/register", strict(10), async (request) => {
    const body = request.body ?? {};
    return registerPlayer(body.legacyId, body.loreCount);
  });

  app.get("/player/me", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    return { playerId: player.id, recoveryCode: player.recoveryCode, loreCount: loreCount(player.id), bestRuns: bestRuns(player.id) };
  });

  app.post<{ Body: RestoreBody }>("/player/restore", strict(5), async (request, reply) => {
    const code = normalizeRecoveryCode(request.body?.code);
    const target = code ? findPlayerByRecoveryCode(code) : null;
    if (!target) return reply.code(404).send({ error: "code inconnu" });
    const current = authenticate(request);
    if (current) mergePlayers(current.id, target.id);
    return issueDevice(target);
  });

  app.post("/pair/start", strict(10), async (request, reply) => {
    const pairing = startPairing(authenticate(request)?.id ?? null);
    if (!pairing) return reply.code(503).send({ error: "trop de jumelages en cours" });
    return pairing;
  });

  app.post<{ Body: PollBody }>("/pair/poll", async (request, reply) => {
    const { code, pollToken } = request.body ?? {};
    if (typeof code !== "string" || typeof pollToken !== "string") return reply.code(400).send({ error: "requête invalide" });
    const result = pollPairing(code, pollToken);
    if (!result) return reply.code(404).send({ status: "expired" });
    return result.status === "pending" ? result : { status: "done", ...result.credentials };
  });

  app.post<{ Body: ConfirmBody }>("/pair/confirm", strict(10), async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const code = request.body?.code;
    if (typeof code !== "string" || !PAIR_CODE_PATTERN.test(code)) return reply.code(400).send({ error: "code invalide" });
    const pending = pendingPairing(code);
    if (!pending) return reply.code(404).send({ error: "code inconnu ou expiré" });
    if (pending.fromPlayerId) mergePlayers(pending.fromPlayerId, player.id);
    completePairing(code, issueDevice(player));
    return { ok: true };
  });

  app.post<{ Body: UnlockBody }>("/lore/unlock", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const { runId, token, fragment } = request.body ?? {};
    if (typeof runId !== "string" || typeof token !== "string" || typeof fragment !== "number" || !Number.isInteger(fragment)) {
      return reply.code(400).send({ error: "requête invalide" });
    }
    if (fragment < 0 || fragment >= LORE_FRAGMENT_COUNT) return reply.code(400).send({ error: "bande inconnue" });
    if (!verifyRunToken(runId, token)) return reply.code(403).send({ error: "token invalide" });
    const run = findRun(runId);
    if (!run || run.status !== "active" || run.player_id !== player.id) return reply.code(404).send({ error: "run introuvable" });

    const known = loreCount(player.id);
    if (fragment < known) return { loreCount: known };
    if (fragment > known + OFFLINE_LORE_SLACK) return reply.code(409).send({ error: "bande hors séquence" });
    if (loreUnlockedAtLevel(runId, run.depth)) return reply.code(409).send({ error: "une seule bande par niveau" });
    return { loreCount: unlockLoreUpTo(player.id, fragment, runId, run.depth) };
  });
}
