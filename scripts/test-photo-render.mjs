#!/usr/bin/env node
// Rendu visuel (WebGL logiciel / SwiftShader) de tests/browser/photo-render.html : capture le
// canvas à chaque étape. Chaque étape bloque côté page (window.__next__()) jusqu'à ce qu'on l'ait
// explicitement fait avancer, pour ne jamais capturer une étape en retard ou en avance.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const playwrightPath = require.resolve("playwright", { paths: ["/opt/node22/lib/node_modules"] });
const { chromium } = (await import(playwrightPath)).default;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ?? path.join(root, "tests/browser/out");
fs.mkdirSync(outDir, { recursive: true });

const port = 5186;
const base = `http://127.0.0.1:${port}`;
const vite = spawn("npx", ["vite", "--config", "tests/browser/vite.test.config.mjs", "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
vite.stdout.on("data", (d) => (viteOutput += d));
vite.stderr.on("data", (d) => (viteOutput += d));

async function screenshotCanvas(page, filePath) {
  const dataUrl = await page.evaluate(() => document.getElementById("view").toDataURL("image/png"));
  fs.writeFileSync(filePath, Buffer.from(dataUrl.split(",")[1], "base64"));
}

async function captureStage(page, stage, filePath, label) {
  await page.waitForFunction((s) => (window).__STAGE__ === s, stage, { timeout: 30000 });
  await screenshotCanvas(page, filePath);
  console.log(`Capture "${label}" -> ${filePath}`);
}

async function advance(page) {
  await page.evaluate(() => (window).__next__());
}

let exitCode = 1;
try {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`[page] ${msg.text()}`));
  page.on("pageerror", (err) => console.error(`[page error] ${err}`));

  const url = `${base}/tests/browser/photo-render.html`;
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

  await captureStage(page, "OFF", path.join(outDir, "photo-off.png"), "vierge");
  await advance(page);
  await captureStage(page, "ON", path.join(outDir, "photo-on.png"), "photo posée");
  await advance(page);
  await captureStage(page, "BACK", path.join(outDir, "photo-back.png"), "dos annoté");
  await advance(page);
  await captureStage(page, "BACK_ANGLE", path.join(outDir, "photo-back-angle.png"), "dos, vue de 3/4");

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
