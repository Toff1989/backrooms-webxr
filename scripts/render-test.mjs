#!/usr/bin/env node
// Runner générique pour tests/browser/*-render.test.ts (voir tests/browser/support/harness.ts) :
// lit window.__STAGES__ une fois la page chargée, puis pour chaque étape capture le canvas #view
// et appelle window.__next__() pour laisser le script avancer. Remplace les anciens scripts
// test-<nom>-render.mjs dédiés à un seul modèle — un seul runner pour tous.
//
// Usage : node scripts/render-test.mjs <nom-de-page> [outDir] [prefix]
//   <nom-de-page> : fichier .html dans tests/browser, sans extension (ex. "compass-render").
//   [outDir]      : dossier de sortie (défaut tests/browser/out).
//   [prefix]      : préfixe des fichiers capturés (défaut <nom-de-page> sans le suffixe "-render").
//
// Voir aussi scripts/render-test-all.mjs pour lancer tous les tests de rendu enregistrés.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const playwrightPath = require.resolve("playwright", { paths: ["/opt/node22/lib/node_modules"] });
const { chromium } = (await import(playwrightPath)).default;

const [, , pageName, outDirArg, prefixArg] = process.argv;
if (!pageName) {
  console.error("Usage: node scripts/render-test.mjs <nom-de-page> [outDir] [prefix]");
  process.exit(1);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = outDirArg ?? path.join(root, "tests/browser/out");
const prefix = prefixArg ?? pageName.replace(/-render$/, "");
fs.mkdirSync(outDir, { recursive: true });

// Port dérivé du nom de page (dans [5300, 5700[) : plusieurs runners peuvent tourner sans se
// marcher sur les pieds (utile pour scripts/render-test-all.mjs, lancé séquentiellement mais
// qui peut laisser un serveur trainer si un test précédent a été interrompu).
let hash = 0;
for (const c of pageName) hash = (hash * 31 + c.charCodeAt(0)) | 0;
const port = 5300 + (Math.abs(hash) % 400);
const base = `http://127.0.0.1:${port}`;
const vite = spawn("npx", ["vite", "--config", "tests/browser/vite.test.config.mjs", "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
vite.stdout.on("data", (d) => (viteOutput += d));
vite.stderr.on("data", (d) => (viteOutput += d));

async function screenshotCanvas(page, filePath) {
  const dataUrl = await page.evaluate(() => document.getElementById("view").toDataURL("image/png"));
  fs.writeFileSync(filePath, Buffer.from(dataUrl.split(",")[1], "base64"));
}

let exitCode = 1;
try {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`[page] ${msg.text()}`));
  page.on("pageerror", (err) => console.error(`[page error] ${err}`));

  const url = `${base}/tests/browser/${pageName}.html`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 5000 });
      break;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`vite dev server pas prêt :\n${viteOutput}\n\n${error}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const stages = await page.evaluate(() => window.__STAGES__ ?? []);
  if (stages.length === 0) throw new Error('window.__STAGES__ est vide ou absent — le test doit l\'exposer via createStageController([...]) (voir tests/browser/support/harness.ts).');

  for (const stage of stages) {
    await page.waitForFunction((s) => window.__STAGE__ === s || window.__STAGE__ === "ERROR", stage, { timeout: 30000 });
    const reached = await page.evaluate(() => window.__STAGE__);
    if (reached === "ERROR") {
      const text = await page.locator("#results").textContent();
      throw new Error(`Le test a échoué avant l'étape "${stage}" :\n${text}`);
    }
    const filePath = path.join(outDir, `${prefix}-${stage.toLowerCase()}.png`);
    await screenshotCanvas(page, filePath);
    console.log(`Capture "${stage}" -> ${filePath}`);
    await page.evaluate(() => window.__next__());
  }

  const text = await page.locator("#results").textContent();
  console.log("\n--- journal ---\n" + text);

  await browser.close();
  exitCode = 0;
} catch (error) {
  console.error("Échec du runner :", error);
  console.error("--- sortie vite ---\n" + viteOutput);
  exitCode = 1;
} finally {
  vite.kill();
}

process.exit(exitCode);
