#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "tests/browser/out-windows");
const port = 5718;
const base = `http://127.0.0.1:${port}`;
const interactionScenario = process.argv[2] === "--interactions";
const objectKind = interactionScenario ? null : process.argv[2] ?? "photo";

fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({
  configFile: path.join(root, "tests/browser/vite.test.config.mjs"),
  logLevel: "error",
  server: { host: "127.0.0.1", port, strictPort: true },
});

let browser;
let exitCode = 1;
try {
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[game] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[game error] ${error}`));
  const visualTestUrl = interactionScenario
    ? `${base}/?debug=1&visualTest=interactions`
    : `${base}/?debug=1&visualTest=object&object=${encodeURIComponent(objectKind)}`;
  await page.goto(visualTestUrl, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => Array.isArray(window.__STAGES__) && window.__STAGES__.length > 0, undefined, { timeout: 60000 });
  const stages = await page.evaluate(() => window.__STAGES__);

  for (const stage of stages) {
    await page.waitForFunction((expectedStage) => window.__STAGE__ === expectedStage || window.__STAGE__ === "ERROR", stage, { timeout: 60000 });
    if ((await page.evaluate(() => window.__STAGE__)) === "ERROR") throw new Error(`Le jeu a échoué avant l'étape ${stage}`);
    const canvas = page.locator("#app canvas");
    const captureName = interactionScenario ? `game-interactions-${stage.toLowerCase()}.png` : `game-${objectKind}-${stage.toLowerCase()}.png`;
    await canvas.screenshot({ path: path.join(outDir, captureName) });
    console.log(`Capture "${stage}" enregistrée.`);
    await page.evaluate(() => window.__next__());
  }
  await context.close();
  exitCode = 0;
} catch (error) {
  console.error("Échec du test visuel du jeu :", error);
} finally {
  await browser?.close();
  await server.close();
}

process.exit(exitCode);