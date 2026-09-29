import type { FastifyInstance } from "fastify";
import { authenticate } from "../players.js";
import { deleteSave, getSave, putSave } from "../saves.js";

/** Généreux pour un inventaire chargé, assez bas pour écarter un abus grossier. */
const MAX_BODY_CHARS = 200_000;
const MAX_INVENTORY_ITEMS = 300;

interface SaveBody {
  data?: unknown;
  updatedAt?: unknown;
}

function isPlausibleSaveData(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  if (typeof record["seed"] !== "string" || record["seed"].length > 200) return false;
  if (typeof record["depth"] !== "number" || !Number.isInteger(record["depth"]) || record["depth"] < 0) return false;
  if (!Array.isArray(record["inventory"]) || record["inventory"].length > MAX_INVENTORY_ITEMS) return false;
  return true;
}

/**
 * Synchronisation de la sauvegarde entre les appareils d'un même joueur (voir `saves.ts`) — le
 * détail du contenu (seed, profondeur, inventaire, vitals, position) est un JSON opaque côté
 * serveur, validé juste assez pour écarter un corps de requête absurde ou disproportionné, pas
 * champ par champ (ce n'est pas une donnée de classement, seulement un confort de reprise).
 */
export function registerSaveRoutes(app: FastifyInstance): void {
  app.get("/save", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const row = getSave(player.id);
    return row ? { data: JSON.parse(row.data) as unknown, updatedAt: row.updated_at } : null;
  });

  app.post<{ Body: SaveBody }>("/save", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const { data, updatedAt } = request.body ?? {};
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return reply.code(400).send({ error: "sauvegarde invalide" });
    if (!isPlausibleSaveData(data)) return reply.code(400).send({ error: "sauvegarde invalide" });
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_BODY_CHARS) return reply.code(413).send({ error: "sauvegarde trop grosse" });
    putSave(player.id, serialized, updatedAt);
    return { ok: true };
  });

  app.post("/save/clear", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    deleteSave(player.id);
    return { ok: true };
  });
}
