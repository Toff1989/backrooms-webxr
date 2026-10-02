#!/usr/bin/env node
// Lance scripts/render-test.mjs pour chaque test visuel enregistré, un par un (des ports
// dérivés du nom de page évitent les collisions, mais chaque test démarre/arrête son propre
// serveur vite — les lancer en parallèle n'apporterait rien ici). Ajouter un modèle : copier un
// *-render.test.ts/.html existant (voir tests/browser/support/harness.ts) puis l'ajouter à cette
// liste.
//
// Usage : node scripts/render-test-all.mjs [outDir]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGES = ["television-render", "photo-render", "compass-render", "digitalWatch-render", "cadreur-render", "marker-render", "journal-render"];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ?? path.join(root, "tests/browser/out");

const results = [];
for (const page of PAGES) {
  console.log(`\n=== ${page} ===`);
  const { status } = spawnSync("node", [path.join(root, "scripts/render-test.mjs"), page, outDir], { stdio: "inherit", cwd: root });
  results.push({ page, ok: status === 0 });
}

console.log("\n=== Résumé ===");
for (const { page, ok } of results) console.log(`${ok ? "PASS" : "FAIL"} ${page}`);

process.exit(results.every((r) => r.ok) ? 0 : 1);
