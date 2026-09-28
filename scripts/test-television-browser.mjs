#!/usr/bin/env node
// Lance tests/browser/television.html dans Chromium headless (sans WebGL, --disable-gpu) contre
// un serveur `vite dev` éphémère, et fait échouer le process si un des checks échoue.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const playwrightPath = require.resolve("playwright", { paths: ["/opt/node22/lib/node_modules"] });
const { chromium } = (await import(playwrightPath)).default;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 5183;
const base = `http://127.0.0.1:${port}`;

const vite = spawn("npx", ["vite", "--config", "tests/browser/vite.test.config.mjs", "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
vite.stdout.on("data", (d) => (viteOutput += d));
vite.stderr.on("data", (d) => (viteOutput += d));

let exitCode = 1;
try {
  const browser = await chromium.launch({ args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`[page] ${msg.text()}`));
  page.on("pageerror", (err) => console.error(`[page error] ${err}`));

  // Le serveur vite met un instant à démarrer : on retente le goto plutôt que de sonder le port.
  const url = `${base}/tests/browser/television.html`;
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
  await page.waitForFunction(() => (window).__TEST_DONE__ === true, { timeout: 30000 });

  const text = await page.locator("#results").textContent();
  console.log("\n" + text);
  const passed = await page.evaluate(() => (window).__TEST_PASSED__);
  exitCode = passed ? 0 : 1;

  await browser.close();
} catch (error) {
  console.error("Échec du runner :", error);
  console.error("--- sortie vite ---\n" + viteOutput);
  exitCode = 1;
} finally {
  vite.kill();
}

process.exit(exitCode);
