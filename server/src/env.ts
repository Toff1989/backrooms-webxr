import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Charge server/.env explicitement, quel que soit le lanceur. Docker/PM2 passent déjà
// les variables via l'environnement (rien à faire), mais l'hébergement Node.js natif
// Plesk (Phusion Passenger, voir deploy/README.md) ne lit aucun fichier .env tout seul.
// Import à faire en premier dans server.ts : les autres modules (db.ts, token.ts) lisent
// process.env dès leur évaluation.
if (process.env["NODE_ENV"] !== "test") {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envFile = join(__dirname, "../.env");
  if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envFile);
  }
}
