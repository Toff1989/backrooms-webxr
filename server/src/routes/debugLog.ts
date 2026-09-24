import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Dossier des journaux de debug (un fichier JSONL par jour), hors du dépôt (voir .gitignore). */
const LOG_DIR = process.env["DEBUG_LOG_DIR"] ?? join(__dirname, "../../logs");
/** Jeton requis pour relire les journaux (GET) ; sans lui, la relecture est désactivée. */
const READ_TOKEN = process.env["DEBUG_LOG_TOKEN"] ?? "";
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_DAY_FILE_BYTES = 50 * 1024 * 1024;

function dayFile(date = new Date()): string {
  return join(LOG_DIR, `debug-${date.toISOString().slice(0, 10)}.jsonl`);
}

/**
 * Journal de debug du client (`?debug=1`, voir src/debug/debugLog.ts) : le casque envoie
 * toutes les 5 s un lot d'événements (erreurs, à-coups et leur cause, stats par seconde,
 * état audio...) écrit tel quel dans `server/logs/debug-AAAA-MM-JJ.jsonl`.
 * - POST /api/debug-log : ajoute un lot (limité en taille et en débit, comme le reste de l'API) ;
 * - GET /api/debug-log?token=...&lines=2000 : relit la fin du journal du jour (DEBUG_LOG_TOKEN).
 */
export function registerDebugLogRoutes(app: FastifyInstance): void {
  app.post("/debug-log", { bodyLimit: MAX_BATCH_BYTES }, async (request, reply) => {
    const body = request.body as { session?: unknown; entries?: unknown };
    if (typeof body?.session !== "string" || !Array.isArray(body.entries)) return reply.code(400).send({ error: "lot invalide" });
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const file = dayFile();
    try {
      if (existsSync(file) && readFileSync(file).length > MAX_DAY_FILE_BYTES) return reply.code(507).send({ error: "journal du jour plein" });
    } catch {
      // Lecture impossible : on tente quand même l'écriture.
    }
    const received = new Date().toISOString();
    const lines = body.entries.map((entry) => JSON.stringify({ received, session: body.session, ip: request.ip, ...(entry as object) }));
    appendFileSync(file, `${lines.join("\n")}\n`);
    return { ok: true, count: lines.length };
  });

  app.get<{ Querystring: { token?: string; lines?: string; day?: string } }>("/debug-log", async (request, reply) => {
    if (!READ_TOKEN || request.query.token !== READ_TOKEN) return reply.code(403).send({ error: "jeton requis (DEBUG_LOG_TOKEN)" });
    const day = request.query.day && /^\d{4}-\d{2}-\d{2}$/.test(request.query.day) ? request.query.day : null;
    const file = day ? join(LOG_DIR, `debug-${day}.jsonl`) : dayFile();
    if (!existsSync(file)) {
      const available = existsSync(LOG_DIR) ? readdirSync(LOG_DIR) : [];
      return reply.code(404).send({ error: "aucun journal pour ce jour", available });
    }
    const maxLines = Math.min(20000, Math.max(1, Number(request.query.lines) || 2000));
    const all = readFileSync(file, "utf8").trimEnd().split("\n");
    reply.type("application/x-ndjson");
    return all.slice(-maxLines).join("\n");
  });
}
