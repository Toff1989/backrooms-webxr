#!/usr/bin/env node
/**
 * Lance tout pour jouer en local : `npm run play` (ou double-clic sur `play.bat` sous Windows).
 *
 * - installe les dépendances manquantes (jeu + serveur) ;
 * - démarre le serveur API (port 8787, classement/sauvegardes) et le serveur de dev Vite (HTTPS, 5173) ;
 * - préfixe leur sortie ([api] / [jeu]), affiche les adresses PC et casque, puis ouvre le navigateur
 *   avec `--open` ; Ctrl+C arrête proprement les deux.
 *
 * Options : `--debug` ajoute `?debug=1` aux adresses, `--open` ouvre le navigateur.
 * Pour la session de test avec export des journaux : `npm run debug`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server");
const WINDOWS = process.platform === "win32";
const NPM = WINDOWS ? "npm.cmd" : "npm";
const query = process.argv.includes("--debug") ? "?debug=1" : "";
const openBrowser = process.argv.includes("--open");

const say = (message) => console.log(`\x1b[33m[play]\x1b[0m ${message}`);

for (const [dir, label] of [[ROOT, "jeu"], [SERVER, "serveur"]]) {
  if (existsSync(join(dir, "node_modules"))) continue;
  say(`Installation des dépendances (${label})…`);
  if (spawnSync(NPM, ["install"], { cwd: dir, stdio: "inherit", shell: WINDOWS }).status !== 0) {
    say(`Échec de "npm install" dans ${dir}.`);
    process.exit(1);
  }
}

const children = [];
function run(name, color, args, cwd, env = {}) {
  const child = spawn(NPM, args, { cwd, env: { ...process.env, ...env }, shell: WINDOWS, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream) => {
    let pending = "";
    stream.on("data", (chunk) => {
      const lines = (pending + chunk.toString()).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log(`\x1b[${color}m[${name}]\x1b[0m ${line}`);
        if (name === "jeu") announce(line);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (!stopping) {
      say(`${name} s'est arrêté (code ${code}) — arrêt de l'ensemble.`);
      stop(code ?? 1);
    }
  });
  children.push(child);
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (WINDOWS && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

run("api", "36", ["run", "dev"], SERVER);
run("jeu", "35", ["run", openBrowser ? "dev:open" : "dev"], ROOT);

/** Repère les lignes "Local:" / "Network:" de Vite (il change de port si 5173 est pris) et rappelle les adresses. */
const urls = {};
function announce(line) {
  const match = line.replace(/\x1b\[[0-9;]*m/g, "").match(/(Local|Network):\s+(https?:\/\/\S+)/);
  if (!match || urls[match[1]]) return;
  urls[match[1]] = match[2] + query;
  if (urls.Local && urls.Network) {
    say("Prêt :");
    say(`  PC     : ${urls.Local}`);
    say(`  Casque : ${urls.Network}  (même réseau Wi-Fi ; accepter le certificat)`);
    say("Ctrl+C pour tout arrêter.");
  }
}
