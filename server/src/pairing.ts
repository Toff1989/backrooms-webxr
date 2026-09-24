import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Credentials } from "./players.js";

/**
 * Jumelage façon télé connectée : le nouvel appareil affiche un code à 6 chiffres, l'appareil
 * déjà enregistré le saisit pour confirmer, et le nouveau récupère alors ses identifiants en
 * interrogeant le serveur. En mémoire seulement : une demande vit 5 minutes, un redémarrage du
 * serveur les annule (le joueur en relance une).
 */
const TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 2000;

interface Pairing {
  pollToken: string;
  expiresAt: number;
  /** Joueur actuel du nouvel appareil (s'il en avait un) : fusionné dans celui qui confirme. */
  fromPlayerId: string | null;
  credentials: Credentials | null;
}

const pairings = new Map<string, Pairing>();

function purgeExpired(now: number): void {
  for (const [code, pairing] of pairings) if (pairing.expiresAt <= now) pairings.delete(code);
}

export function startPairing(fromPlayerId: string | null): { code: string; pollToken: string; expiresIn: number } | null {
  const now = Date.now();
  purgeExpired(now);
  if (pairings.size >= MAX_PENDING) return null;
  let code = "";
  do code = String(randomInt(1_000_000)).padStart(6, "0");
  while (pairings.has(code));
  const pollToken = randomBytes(24).toString("base64url");
  pairings.set(code, { pollToken, expiresAt: now + TTL_MS, fromPlayerId, credentials: null });
  return { code, pollToken, expiresIn: TTL_MS / 1000 };
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** État d'une demande pour le nouvel appareil ; une fois les identifiants remis, elle est effacée. */
export function pollPairing(code: string, pollToken: string): { status: "pending" } | { status: "done"; credentials: Credentials } | null {
  purgeExpired(Date.now());
  const pairing = pairings.get(code);
  if (!pairing || !sameToken(pairing.pollToken, pollToken)) return null;
  if (!pairing.credentials) return { status: "pending" };
  pairings.delete(code);
  return { status: "done", credentials: pairing.credentials };
}

/** Demande en attente pour ce code (pas encore confirmée), ou null. */
export function pendingPairing(code: string): { fromPlayerId: string | null } | null {
  purgeExpired(Date.now());
  const pairing = pairings.get(code);
  return pairing && !pairing.credentials ? { fromPlayerId: pairing.fromPlayerId } : null;
}

export function completePairing(code: string, credentials: Credentials): void {
  const pairing = pairings.get(code);
  if (pairing) pairing.credentials = credentials;
}
