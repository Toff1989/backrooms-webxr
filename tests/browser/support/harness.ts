/**
 * Socle commun aux tests de rendu visuel (`tests/browser/*-render.test.ts`) : scène three.js
 * minimale (renderer + lumières), contrôleur d'étapes bloquant, et deux façons de cadrer la
 * caméra. Pas d'InteractionSystem/monde/joueur : juste assez pour exercer le vrai code de
 * détection de sous-mailles (`findModelFace`, `findMeshByName`...) avec un
 * `WebGLRenderer` réel (logiciel/SwiftShader en Chromium headless, voir `scripts/render-test.mjs`).
 *
 * Le contrôleur d'étapes bloque le script après chaque rendu jusqu'à ce que le runner
 * Playwright appelle `window.__next__()` — sans ce handshake explicite, un délai approximatif
 * (rAF ×2, timeout fixe...) peut laisser le script avancer d'une étape avant que le runner ait
 * fini de lire le canvas, et la capture d'une étape se retrouve à contenir le rendu de la
 * suivante (constaté en pratique sur les tout premiers de ces tests).
 *
 * Pour ajouter le test d'un nouveau modèle : copier un `*-render.test.ts`/`.html` existant,
 * changer le chargement du modèle et la détection/dessin spécifiques, garder le reste. Le
 * runner (`node scripts/render-test.mjs <nom-de-page>`) n'a besoin d'aucune modification.
 */
import * as THREE from "three";

export type Logger = (line: string) => void;

/** Journal affiché dans #results (ou l'id donné) et repris par le runner en fin de capture. */
export function createLogger(elementId = "results"): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const el = document.getElementById(elementId);
  const log: Logger = (line) => {
    lines.push(line);
    console.log(line);
    if (el) el.textContent = lines.join("\n");
  };
  return { log, lines };
}

export interface StageController {
  /** Affiche l'étape courante puis bloque jusqu'à ce que le runner l'ait capturée. */
  enter(stage: string): Promise<void>;
  /** Signale un échec au runner (au lieu de le laisser expirer en attendant une étape jamais atteinte). */
  fail(): void;
}

/**
 * `stages` liste à l'avance les étapes attendues (dans l'ordre) : le runner headless les lit une
 * fois la page chargée (`window.__STAGES__`) pour savoir combien de captures faire et sous quel
 * nom, sans qu'il ait besoin de connaître le détail de chaque test.
 */
export function createStageController(stages: readonly string[]): StageController {
  (window as unknown as Record<string, readonly string[]>)["__STAGES__"] = stages;
  let resolveNext: (() => void) | null = null;
  (window as unknown as { __next__: () => void }).__next__ = () => {
    resolveNext?.();
    resolveNext = null;
  };
  return {
    enter(stage: string): Promise<void> {
      (window as unknown as Record<string, string>)["__STAGE__"] = stage;
      return new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    },
    fail(): void {
      (window as unknown as Record<string, string>)["__STAGE__"] = "ERROR";
    },
  };
}

/** Canvas + renderer WebGL prêts à l'emploi. */
export function createRenderer(canvasId = "view"): { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  // preserveDrawingBuffer : sans lui, toDataURL() peut lire un buffer déjà effacé (le runner
  // headless capture le canvas après le render, hors de toute boucle de compositing).
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);
  return { renderer, canvas };
}

/** Scène minimale (fond + ambiante + deux directionnelles) — suffisante pour juger d'un rendu, pas pour du photoréalisme. */
export function createScene(background = 0x222222): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1.5, 2.5, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.9);
  fill.position.set(-1.5, 1.5, -1);
  scene.add(fill);
  return scene;
}

/** Cadre la caméra sur la bbox entière d'un objet, vue depuis `direction`. */
export function frameOnObject(camera: THREE.PerspectiveCamera, object: THREE.Object3D, direction: THREE.Vector3): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z) / (2 * Math.tan((camera.fov * Math.PI) / 360)) + size.length();
  camera.position.copy(center).addScaledVector(direction, distance * 1.3);
  camera.lookAt(center);
}

/**
 * Cadre la caméra sur un point donné avec un rayon explicite plutôt que la bbox globale d'un
 * objet — utile quand une pièce annexe (couvercle ouvert, boucle d'attache...) fausserait le
 * cadrage si on se basait sur le modèle entier.
 */
export function frameOnPoint(camera: THREE.PerspectiveCamera, center: THREE.Vector3, radius: number, direction: THREE.Vector3): void {
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360) + radius;
  camera.position.copy(center).addScaledVector(direction, distance * 1.4);
  camera.lookAt(center);
}

/** Damier bien contrasté : révèle immédiatement un étirement ou un décalage de cadrage, contrairement
 * à une texture "trouvée" réaliste où une déformation légère passerait inaperçue à l'œil. */
export function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number, cell = 16): void {
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      ctx.fillStyle = (x / cell + y / cell) % 2 === 0 ? "#e0463c" : "#ffe08a";
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
}

/** Bruit "statique télé" — comme `drawStatic` dans `interactions.ts`. */
export function drawStaticNoise(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const noise = ctx.createImageData(w, h);
  for (let i = 0; i < noise.data.length; i += 4) {
    const v = Math.random() * 230;
    noise.data[i] = v;
    noise.data[i + 1] = v;
    noise.data[i + 2] = v * 1.05;
    noise.data[i + 3] = 255;
  }
  ctx.putImageData(noise, 0, 0);
}
