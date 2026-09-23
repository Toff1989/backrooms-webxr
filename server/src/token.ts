import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Token signé HMAC (fiche projet étape 7 : "renvoie un token signé"). Pas de JWT/lib
 * externe — juste `runId` + une signature HMAC-SHA256 du secret serveur, suffisant pour
 * empêcher un client de forger/deviner un `runId` valide sans être jamais passé par
 * `POST /run/start`. Le secret DOIT être fourni en prod (voir `server.ts`) ; une valeur
 * de dev est utilisée sinon, jamais utilisable en production faute d'y être définie.
 */
const SECRET = process.env["RUN_TOKEN_SECRET"] ?? "dev-only-insecure-secret";

export function signRunToken(runId: string): string {
  const signature = createHmac("sha256", SECRET).update(runId).digest("hex");
  return `${runId}.${signature}`;
}

export function verifyRunToken(runId: string, token: string): boolean {
  const expected = signRunToken(runId);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(token);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
