#!/usr/bin/env node
/**
 * Session de test en local avec journal de debug garanti : `npm run debug`.
 *
 * 1. Installe les dépendances manquantes (jeu + serveur).
 * 2. Lance le serveur Node (API + réception des journaux) et le serveur de dev Vite (HTTPS).
 * 3. Affiche les adresses à ouvrir (PC et casque, avec `?debug=1`), puis toutes les 10 s le
 *    nombre d'entrées reçues : on voit tout de suite si les journaux arrivent bien.
 * 4. À l'arrêt (Ctrl+C) : exporte les entrées de cette session dans
 *    `server/logs/export-AAAA-MM-JJ_HH-MM.jsonl`, à glisser dans la page d'analyse (Artifact
 *    Claude) ou directement dans la conversation.
 *
 * Fonctionne sous Windows, macOS et Linux (Node 18+).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server");
const LOG_DIR = join(SERVER, "logs");
const API_PORT = 8787;
const VITE_PORT = 5173;
const WINDOWS = process.platform === "win32";
const NPM = WINDOWS ? "npm.cmd" : "npm";
const NPX = WINDOWS ? "npx.cmd" : "npx";
const startedAt = new Date();

function say(message) {
  console.log(`\x1b[33m[debug]\x1b[0m ${message}`);
}

function install(dir, label) {
  if (existsSync(join(dir, "node_modules"))) return;
  say(`Installation des dépendances (${label})…`);
  const result = spawnSync(NPM, ["install"], { cwd: dir, stdio: "inherit", shell: WINDOWS });
  if (result.status !== 0) {
    say(`Échec de "npm install" dans ${dir}.`);
    process.exit(1);
  }
}

install(ROOT, "jeu");
install(SERVER, "serveur");
mkdirSync(LOG_DIR, { recursive: true });

const token = Math.random().toString(36).slice(2, 12);
const env = { ...process.env, PORT: String(API_PORT), DEBUG_LOG_DIR: LOG_DIR, DEBUG_LOG_TOKEN: token };
// Groupe de processus à part (hors Windows) : l'arrêt emporte aussi les sous-processus (tsx, esbuild).
const options = (cwd) => ({ cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: WINDOWS, detached: !WINDOWS });
const children = [
  spawn(NPM, ["run", "start"], options(SERVER)),
  spawn(NPX, ["vite", "--port", String(VITE_PORT), "--strictPort"], options(ROOT)),
];
const [server, vite] = children;
// Sorties utiles seulement : erreurs du serveur, et Vite (adresses, erreurs de compilation).
server.stderr.on("data", (chunk) => process.stderr.write(`[serveur] ${chunk}`));
server.stdout.on("data", (chunk) => {
  const text = String(chunk);
  if (/error|listening/i.test(text)) process.stdout.write(`[serveur] ${text}`);
});
vite.stdout.on("data", (chunk) => process.stdout.write(`[vite] ${chunk}`));
vite.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) {
      say(`Un des serveurs s'est arrêté (code ${code}). Arrêt.`);
      stop();
    }
  });
}

const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((address) => address && address.family === "IPv4" && !address.internal)
  .map((address) => address.address);

setTimeout(() => {
  say("Prêt. Ouvre le jeu en mode debug :");
  say(`  PC     : https://localhost:${VITE_PORT}/?debug=1`);
  for (const ip of lanAddresses) say(`  Casque : https://${ip}:${VITE_PORT}/?debug=1   (même Wi-Fi ; accepte l'avertissement de certificat)`);
  say(`Journal : ${LOG_DIR}`);
  say("Ctrl+C pour arrêter et exporter les journaux de cette session.");
}, 4000);

// Suivi : nombre d'entrées reçues depuis le lancement, toutes les 10 s.
function sessionEntries() {
  const days = new Set([startedAt, new Date()].map((date) => date.toISOString().slice(0, 10)));
  const lines = [];
  for (const day of days) {
    const file = join(LOG_DIR, `debug-${day}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        if (new Date(JSON.parse(line).received) >= startedAt) lines.push(line);
      } catch {
        // Ligne tronquée : ignorée.
      }
    }
  }
  return lines;
}

let lastCount = 0;
let lastSize = -1;
const monitor = setInterval(() => {
  const file = join(LOG_DIR, `debug-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const size = existsSync(file) ? statSync(file).size : 0;
  if (size === lastSize) {
    if (lastCount === 0) say("Aucun journal reçu pour l'instant (le jeu est-il ouvert avec ?debug=1 ?)");
    return;
  }
  lastSize = size;
  const entries = sessionEntries();
  lastCount = entries.length;
  const last = [...entries].reverse().find((line) => line.includes('"type":"stats"'));
  let detail = "";
  if (last) {
    const stats = JSON.parse(last);
    detail = ` — dernier relevé : ${stats.fps} fps, pire frame ${stats.frameMax} ms, profondeur ${stats.depth ?? "?"}${stats.xr ? ", en VR" : ""}`;
  }
  say(`${entries.length} entrées reçues${detail}`);
}, 10000);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(monitor);
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (WINDOWS) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  const entries = sessionEntries();
  if (entries.length === 0) {
    say("Aucune entrée reçue pendant cette session : rien à exporter.");
    process.exit(0);
  }
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const out = join(LOG_DIR, `export-${stamp}.jsonl`);
  writeFileSync(out, `${entries.join("\n")}\n`);
  say(`${entries.length} entrées exportées :`);
  say(`  ${out}`);
  say("Glisse ce fichier dans la page d'analyse (Artifact Claude) puis « Envoyer à Claude »,");
  say("ou directement dans la conversation.");
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
