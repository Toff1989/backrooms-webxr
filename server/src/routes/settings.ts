import type { FastifyInstance } from "fastify";
import { LORE_FRAGMENT_COUNT } from "../../../src/shared/lore.js";
import { authenticate } from "../players.js";
import { getSettings, listPhotos, putPhoto, putSettings } from "../settings.js";

const MAX_SETTINGS_CHARS = 4_000;
/** Un polaroïd en JPEG fait ~50-150 Ko : marge confortable, sans laisser passer un abus grossier. */
const MAX_PHOTO_CHARS = 600_000;
const PHOTO_PREFIX = "data:image/jpeg;base64,";
const PHOTO_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

interface SettingsBody {
  data?: unknown;
  updatedAt?: unknown;
}

interface PhotoBody {
  image?: unknown;
  updatedAt?: unknown;
}

function isPlausibleSettings(data: unknown): data is Record<string, string> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const entries = Object.entries(data as Record<string, unknown>);
  return entries.length <= 20 && entries.every(([key, value]) => key.length <= 40 && typeof value === "string" && value.length <= 40);
}

/** Synchronisation des réglages et des photos des polaroïds (voir `settings.ts`). */
export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/settings", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const row = getSettings(player.id);
    return row ? { data: JSON.parse(row.data) as unknown, updatedAt: row.updated_at } : null;
  });

  app.post<{ Body: SettingsBody }>("/settings", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const { data, updatedAt } = request.body ?? {};
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || !isPlausibleSettings(data)) return reply.code(400).send({ error: "réglages invalides" });
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_SETTINGS_CHARS) return reply.code(413).send({ error: "réglages trop gros" });
    putSettings(player.id, serialized, updatedAt);
    return { ok: true };
  });

  app.get("/photos", async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    return { photos: listPhotos(player.id).map((row) => ({ fragment: row.fragment, image: row.image, updatedAt: row.updated_at })) };
  });

  app.post<{ Params: { fragment: string }; Body: PhotoBody }>("/photos/:fragment", { bodyLimit: MAX_PHOTO_CHARS + 1_000 }, async (request, reply) => {
    const player = authenticate(request);
    if (!player) return reply.code(401).send({ error: "appareil inconnu" });
    const fragment = Number(request.params.fragment);
    if (!Number.isInteger(fragment) || fragment < 0 || fragment >= LORE_FRAGMENT_COUNT) return reply.code(400).send({ error: "fragment invalide" });
    const { image, updatedAt } = request.body ?? {};
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return reply.code(400).send({ error: "photo invalide" });
    if (typeof image !== "string" || !image.startsWith(PHOTO_PREFIX) || !PHOTO_BASE64.test(image.slice(PHOTO_PREFIX.length))) {
      return reply.code(400).send({ error: "photo invalide" });
    }
    if (image.length > MAX_PHOTO_CHARS) return reply.code(413).send({ error: "photo trop grosse" });
    putPhoto(player.id, fragment, image, updatedAt);
    return { ok: true };
  });
}
