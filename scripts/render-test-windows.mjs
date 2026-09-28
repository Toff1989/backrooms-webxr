#!/usr/bin/env node
// Runner Windows autonome : évite le chemin Playwright global Linux et les scripts batch npx.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const PAGES = ["television-render", "photo-render", "compass-render", "digitalWatch-render"];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ?? path.join(root, "tests/browser/out-windows");
const port = 5717;
const base = `http://127.0.0.1:${port}`;

fs.mkdirSync(outDir, { recursive: true });

async function screenshotCanvas(page, filePath) {
  const dataUrl = await page.evaluate(() => document.getElementById("view").toDataURL("image/png"));
  fs.writeFileSync(filePath, Buffer.from(dataUrl.split(",")[1], "base64"));
}

async function renderPage(browser, pageName) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[${pageName}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[${pageName}] ${error}`));
  try {
    await page.goto(`${base}/tests/browser/${pageName}.html`, { waitUntil: "load", timeout: 30000 });
    const stages = await page.evaluate(() => window.__STAGES__ ?? []);
    if (stages.length === 0) throw new Error("window.__STAGES__ est vide ou absent");

    for (const stage of stages) {
      await page.waitForFunction((expectedStage) => window.__STAGE__ === expectedStage || window.__STAGE__ === "ERROR", stage, { timeout: 30000 });
      const reached = await page.evaluate(() => window.__STAGE__);
      if (reached === "ERROR") {
        throw new Error(`Le test a échoué avant l'étape "${stage}" :\n${await page.locator("#results").textContent()}`);
      }
      const filePath = path.join(outDir, `${pageName.replace(/-render$/, "")}-${stage.toLowerCase()}.png`);
      await screenshotCanvas(page, filePath);
      console.log(`Capture "${stage}" -> ${filePath}`);
      await page.evaluate(() => window.__next__());
    }
    console.log(`\n--- journal ${pageName} ---\n${await page.locator("#results").textContent()}`);
  } finally {
    await context.close();
  }
}

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
  for (const pageName of PAGES) {
    console.log(`\n=== ${pageName} ===`);
    await renderPage(browser, pageName);
  }
  exitCode = 0;
} catch (error) {
  console.error("Échec du runner Windows :", error);
} finally {
  await browser?.close();
  await server.close();
}

process.exit(exitCode);