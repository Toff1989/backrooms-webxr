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

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

app.register(
  async (api) => {
    registerRunRoutes(api);
    registerLeaderboardRoute(api);
  },
  { prefix: "/api" },
);

await app.register(fastifyStatic, {
  root: STATIC_DIR,
  index: ["index.html"],
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
