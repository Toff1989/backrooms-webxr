#!/usr/bin/env node
// Test visuel des menus : rend chaque panneau du jeu (tests/browser/menus-render.html) dans tous
// ses états et les deux langues, enregistre une capture par rendu et liste les défauts détectés
// (textes rognés, phrases coupées, débordements, chevauchements). Code de sortie 1 s'il en reste.
//   node scripts/render-menus.mjs            -> tests/browser/out-menus/
//   node scripts/render-menus.mjs --verbose  -> détaille chaque défaut au lieu d'un résumé
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "tests/browser/out-menus");
const port = 5719;
const verbose = process.argv.includes("--verbose");

fs.rmSync(outDir, { recursive: true, force: true });
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
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  page.on("pageerror", (error) => console.error(`[page] ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[console] ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/tests/browser/menus-render.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.__MENUS_DONE__ || window.__MENUS_ERROR__, undefined, { timeout: 120000 });
  const failure = await page.evaluate(() => window.__MENUS_ERROR__);
  if (failure) throw new Error(failure);
  const { shots, issues, advance, renders } = await page.evaluate(() => window.__MENUS_RESULT__);

  console.log(`Police de test : ${advance.font} (chasse M = ${advance.emPerChar.toFixed(3)} em, i = ${advance.narrow.toFixed(3)} em)`);
  const slug = (value) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9-]+/g, "_").slice(0, 90);
  for (const shot of shots) {
    const dir = path.join(outDir, shot.lang);
    fs.mkdirSync(dir, { recursive: true });
    shot.file = `${shot.lang}/${slug(shot.panel)}__${slug(shot.scenario)}.png`;
    fs.writeFileSync(path.join(outDir, shot.file), Buffer.from(shot.png.split(",")[1], "base64"));
    delete shot.png;
  }
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ shots, issues }, null, 2));

  // Galerie : un bloc par panneau, FR et EN côte à côte pour chaque scénario.
  const panels = [...new Set(shots.map((shot) => shot.panel))];
  const html = ['<!doctype html><meta charset="utf-8"><title>Menus</title><style>body{background:#1a1a1a;color:#ddd;font:13px monospace;margin:16px}h2{border-bottom:1px solid #555}.row{display:flex;gap:12px;margin:8px 0 24px}figure{margin:0}img{max-width:48vw;height:auto;display:block}</style>'];
  for (const panelName of panels) {
    html.push(`<h2>${panelName}</h2>`);
    const scenarios = [...new Set(shots.filter((shot) => shot.panel === panelName).map((shot) => shot.scenario))];
    for (const scenario of scenarios) {
      const fr = shots.find((shot) => shot.panel === panelName && shot.scenario === scenario && shot.lang === "fr");
      const en = shots.find((shot) => shot.panel === panelName && shot.scenario === scenario && shot.lang === "en");
      html.push(`<div>${scenario}</div><div class="row">${[fr, en].map((shot) => (shot ? `<figure><img src="${shot.file}"></figure>` : "")).join("")}</div>`);
    }
  }
  fs.writeFileSync(path.join(outDir, "gallery.html"), html.join("\n"));

  console.log(`${renders} rendus, ${shots.length} captures dans ${path.relative(root, outDir)}, ${issues.length} défaut(s).`);
  const groups = new Map();
  for (const issue of issues) {
    const key = `${issue.panel} | ${issue.kind} | ${issue.detail.replace(/\d+px/g, "Npx")}`;
    const entry = groups.get(key) ?? { issue, count: 0, langs: new Set(), scenarios: new Set() };
    entry.count += 1;
    entry.langs.add(issue.lang);
    entry.scenarios.add(issue.scenario);
    groups.set(key, entry);
  }
  const ordered = [...groups.values()].sort((a, b) => a.issue.panel.localeCompare(b.issue.panel) || a.issue.kind.localeCompare(b.issue.kind));
  for (const { issue, count, langs, scenarios } of ordered) {
    const first = [...scenarios][0];
    console.log(`- [${issue.panel}] ${issue.kind} (${[...langs].join("/")}, ${count}×) ${issue.detail}\n    ex. ${first}${scenarios.size > 1 ? ` (+${scenarios.size - 1} autres scénarios)` : ""}`);

  }
  exitCode = issues.length === 0 ? 0 : 1;
} catch (error) {
  console.error("Échec du test visuel des menus :", error);
} finally {
  await browser?.close();
  await server.close();
}

process.exit(exitCode);
