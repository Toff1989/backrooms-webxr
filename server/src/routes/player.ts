import type { FastifyInstance } from "fastify";
import { LORE_FRAGMENT_COUNT } from "../../../src/shared/lore.js";
import { completePairing, pendingPairing, pollPairing, startPairing } from "../pairing.js";
import { deleteSave, mergeSaves } from "../saves.js";
import { authenticate, bestRuns, findPlayerByRecoveryCode, issueDevice, loreCount, mergePlayers, normalizeRecoveryCode, raiseLoreCount, registerPlayer, resetLore, setPseudo } from "../players.js";
import { sanitizePseudo } from "../wordFilter.js";

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
interface LoreSyncBody {
  count?: unknown;
}
interface PseudoBody {
  pseudo?: unknown;
}

/**
 * Identité anonyme (voir `players.ts`) : inscription automatique au premier lancement, profil
 * (code de cassette, archives lues, meilleures runs), récupération par code de cassette,
 * jumelage façon télé, et synchronisation des archives perdues (indépendante de toute run).
 */
export function registerPlayerRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegisterBody }>("/player/register", strict(10), async (request) => {
    const body = request.body ?? {};
    return registerPlayer(body.legacyId, body.loreCount);
  });

  app.get("/player/me", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    return { playerId: player.id, recoveryCode: player.recoveryCode, pseudo: player.pseudo, loreCount: loreCount(player.id), bestRuns: bestRuns(player.id) };
  });

  /**
   * Choisi une fois (première fin de run/victoire, voir /run/end), modifiable ensuite dans les
   * paramètres. Rejette (plutôt que retomber sur un pseudo de repli) une entrée manifestement
   * invalide : mieux vaut prévenir que remplacer silencieusement ce que le joueur vient de taper.
   */
  app.post<{ Body: PseudoBody }>("/player/pseudo", strict(10), async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const raw = request.body?.pseudo;
    if (typeof raw !== "string") return reply.code(400).send({ error: "pseudo invalide" });
    const trimmed = raw.trim();
    if (trimmed.length < 1 || trimmed.length > 40) return reply.code(400).send({ error: "pseudo invalide" });
    const clean = sanitizePseudo(trimmed);
    if (clean !== trimmed) return reply.code(400).send({ error: "pseudo refusé" });
    setPseudo(player.id, clean);
    return { pseudo: clean };
  });

  app.post<{ Body: RestoreBody }>("/player/restore", strict(5), async (request, reply) => {
    const code = normalizeRecoveryCode(request.body?.code);
    const target = code ? findPlayerByRecoveryCode(code) : null;
    if (!target) return reply.code(404).send({ error: "code inconnu" });
    const current = authenticate(request);
    if (current) {
      mergePlayers(current.id, target.id);
      mergeSaves(current.id, target.id);
    }
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
    if (pending.fromPlayerId) {
      mergePlayers(pending.fromPlayerId, player.id);
      mergeSaves(pending.fromPlayerId, player.id);
    }
    completePairing(code, issueDevice(player));
    return { ok: true };
  });

  /**
   * Uniformisé avec la sauvegarde (voir /save) : pas de run à valider, juste le nombre
   * d'archives connues localement — le plus avancé des deux fait foi, comme pour l'inventaire.
   */
  app.post<{ Body: LoreSyncBody }>("/lore/sync", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const { count } = request.body ?? {};
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > LORE_FRAGMENT_COUNT) {
      return reply.code(400).send({ error: "requête invalide" });
    }
    return { loreCount: raiseLoreCount(player.id, count) };
  });

  /**
   * Réinitialisation complète de la progression (paramètres, "recommencer à zéro") : efface les
   * archives lues et la sauvegarde en cours côté serveur — pas l'identité/le pseudo/le code de
   * cassette (compte, pas progression), pas l'historique du classement (`runs`). Le client
   * efface en plus son état local (voir `resetProgress` côté client) ; les succès (une fois
   * ajoutés) auront leur propre remise à zéro, greffée ici.
   */
  app.post("/player/reset-progress", strict(5), async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    resetLore(player.id);
    deleteSave(player.id);
    return { ok: true };
  });
}
