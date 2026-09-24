import "./env.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { registerLeaderboardRoute, registerRunRoutes } from "./routes/run.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env["PORT"] ?? 8787);
const HOST = process.env["HOST"] ?? "0.0.0.0";
// Build du front (étape 8) : un seul process Node sert le SPA statique ET l'API, plus
// simple à héberger (un seul port à exposer côté Plesk/reverse proxy) qu'un couple de
// conteneurs front+API séparés.
const STATIC_DIR = process.env["STATIC_DIR"] ?? join(__dirname, "../../dist");
// Derrière Plesk (nginx) ou Docker+Caddy, un seul proxy est en coupure : sans ça, Fastify
// voit l'IP du proxy pour tout le monde et @fastify/rate-limit partagerait un seul quota
// entre tous les visiteurs. TRUST_PROXY=0 désactive (utile en dev direct, sans proxy).
const TRUST_PROXY = process.env["TRUST_PROXY"] !== "0";

const app = Fastify({ logger: true, trustProxy: TRUST_PROXY });

await app.register(cors, { origin: true });
app.register(
  async (api) => {
    // Limite de débit sur l'API seulement : un chargement de page demande des dizaines de
    // fichiers statiques, qui ne doivent pas consommer le quota anti-abus du classement.
    await api.register(rateLimit, { max: 60, timeWindow: "1 minute" });
    registerRunRoutes(api);
    registerLeaderboardRoute(api);
  },
  { prefix: "/api" },
);

await app.register(fastifyStatic, {
  root: STATIC_DIR,
  index: ["index.html"],
  // Fichiers .br/.gz générés au build (scripts/compress-dist.mjs).
  preCompressed: true,
  setHeaders: (reply, path) => {
    // Fichiers nommés par hash de contenu : cache définitif côté navigateur.
    if (path.includes("/assets/")) reply.header("Cache-Control", "public, max-age=31536000, immutable");
  },
});

app.setNotFoundHandler((request, reply) => {
  if (request.raw.method !== "GET" || request.url.startsWith("/api/")) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  reply.sendFile("index.html");
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`Backrooms VR server listening on ${HOST}:${PORT} (static: ${STATIC_DIR})`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
