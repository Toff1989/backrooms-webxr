import { del, get, set } from "idb-keyval";

/**
 * Identité anonyme du joueur, sans compte : au premier lancement, le serveur attribue à cet
 * appareil un secret (gardé ici, en IndexedDB) qui le rattache à un joueur. Le code de cassette
 * permet de retrouver ce joueur ailleurs ; le jumelage façon télé aussi (voir `server/src/pairing.ts`).
 * Serveur injoignable : pas d'identité, le jeu reste jouable hors ligne (nouvel essai plus tard).
 */
export interface Identity {
  playerId: string;
  secret: string;
  recoveryCode: string;
}

export interface PlayerProfile {
  playerId: string;
  recoveryCode: string;
  loreCount: number;
  bestRuns: Array<{ pseudo: string; depth: number; endedAt: number }>;
}

const IDENTITY_KEY = "backrooms-vr:identity";
/** Ancien identifiant local (avant les identités serveur) : repris à l'inscription pour garder les runs. */
const LEGACY_ID_KEY = "backrooms-vr:playerId";
export const LORE_PROGRESS_KEY = "backrooms-vr:lore-next";

let identity: Identity | null = null;
let pending: Promise<Identity | null> | null = null;
const listeners = new Set<(identity: Identity | null) => void>();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiCall<T>(method: "GET" | "POST", path: string, body?: unknown, authenticated = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authenticated && identity) headers["Authorization"] = `Bearer ${identity.secret}`;
  const response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new ApiError(response.status, `${path} a répondu ${response.status}`);
  return (await response.json()) as T;
}

export function currentIdentity(): Identity | null {
  return identity;
}

export function onIdentityChange(listener: (identity: Identity | null) => void): void {
  listeners.add(listener);
}

async function adopt(next: Identity | null): Promise<void> {
  identity = next;
  if (next) await set(IDENTITY_KEY, next).catch(() => {});
  else await del(IDENTITY_KEY).catch(() => {});
  for (const listener of listeners) listener(next);
}

async function register(): Promise<Identity> {
  const legacyId = await get<string>(LEGACY_ID_KEY).catch(() => undefined);
  const loreCount = await get<number>(LORE_PROGRESS_KEY).catch(() => undefined);
  const created = await apiCall<Identity>("POST", "/player/register", { legacyId, loreCount }, false);
  await del(LEGACY_ID_KEY).catch(() => {});
  return created;
}

/**
 * Identité de cet appareil : celle déjà enregistrée, sinon inscription auprès du serveur.
 * Renvoie null hors ligne (sans jamais bloquer le jeu) ; le prochain appel réessaiera.
 */
export function ensureIdentity(): Promise<Identity | null> {
  if (identity) return Promise.resolve(identity);
  pending ??= (async () => {
    const stored = await get<Identity>(IDENTITY_KEY).catch(() => undefined);
    if (stored?.secret) {
      identity = stored;
      for (const listener of listeners) listener(stored);
      return stored;
    }
    try {
      const created = await register();
      await adopt(created);
      return created;
    } catch {
      return null;
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * Profil serveur (code de cassette, bandes lues, meilleures runs). Appareil inconnu du serveur
 * (base réinitialisée) : on oublie l'identité locale et on se réinscrit.
 */
export async function fetchProfile(): Promise<PlayerProfile | null> {
  if (!(await ensureIdentity())) return null;
  try {
    const profile = await apiCall<PlayerProfile>("GET", "/player/me");
    if (identity && (profile.playerId !== identity.playerId || profile.recoveryCode !== identity.recoveryCode)) {
      // Identité fusionnée dans une autre (jumelage fait depuis un autre appareil) : on suit.
      await adopt({ ...identity, playerId: profile.playerId, recoveryCode: profile.recoveryCode });
    }
    return profile;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await adopt(null);
      if (await ensureIdentity()) return apiCall<PlayerProfile>("GET", "/player/me").catch(() => null);
    }
    return null;
  }
}

/** Récupère un enregistrement par son code de cassette (saisie libre, tirets facultatifs). */
export async function restoreFromCode(code: string): Promise<boolean> {
  try {
    const restored = await apiCall<Identity>("POST", "/player/restore", { code });
    await adopt(restored);
    return true;
  } catch {
    return false;
  }
}

export interface PairingRequest {
  code: string;
  /** Arrête l'attente (menu fermé, nouvelle demande). */
  cancel(): void;
}

const PAIR_POLL_MS = 3000;

/**
 * Jumelage, côté nouvel appareil : demande un code à 6 chiffres, puis interroge le serveur
 * jusqu'à ce qu'un appareil déjà enregistré le confirme (ou que le code expire, 5 min).
 */
export async function startPairing(onDone: (success: boolean) => void): Promise<PairingRequest | null> {
  await ensureIdentity();
  let started: { code: string; pollToken: string; expiresIn: number };
  try {
    started = await apiCall("POST", "/pair/start", {});
  } catch {
    return null;
  }
  let cancelled = false;
  const deadline = Date.now() + started.expiresIn * 1000;
  const poll = async (): Promise<void> => {
    if (cancelled) return;
    if (Date.now() > deadline) {
      onDone(false);
      return;
    }
    try {
      const result = await apiCall<{ status: "pending" } | ({ status: "done" } & Identity)>("POST", "/pair/poll", { code: started.code, pollToken: started.pollToken }, false);
      if (cancelled) return;
      if (result.status === "done") {
        await adopt({ playerId: result.playerId, secret: result.secret, recoveryCode: result.recoveryCode });
        onDone(true);
        return;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        onDone(false);
        return;
      }
    }
    setTimeout(() => void poll(), PAIR_POLL_MS);
  };
  setTimeout(() => void poll(), PAIR_POLL_MS);
  return {
    code: started.code,
    cancel: () => {
      cancelled = true;
    },
  };
}

/** Jumelage, côté appareil déjà enregistré : confirme le code affiché par le nouvel appareil. */
export async function confirmPairing(code: string): Promise<boolean> {
  if (!(await ensureIdentity())) return false;
  try {
    await apiCall("POST", "/pair/confirm", { code });
    return true;
  } catch {
    return false;
  }
}
