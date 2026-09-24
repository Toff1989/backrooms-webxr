import * as THREE from "three";

/** Durée de la frame visée (Quest : 72 Hz). Au-delà de 1,5×, la frame est un à-coup. */
const TARGET_FRAME_MS = 1000 / 72;
const HITCH_FACTOR = 1.5;
const HISTORY = 144;
const MAX_LOG = 40;

export interface HitchRecord {
  /** Secondes depuis le lancement. */
  at: number;
  frameMs: number;
  cpuMs: number;
  /** Sections les plus coûteuses de cette frame (ms). */
  sections: Record<string, number>;
  /** Événements survenus pendant la frame (chunk chargé, shader compilé...). */
  events: string[];
}

/**
 * Suivi des performances en temps réel (`?debug=1`), lisible en casque :
 * - FPS lissé, draw calls, triangles, géométries/textures/shaders en mémoire ;
 * - temps CPU par section de la boucle (physique, monde, rendu...) via `begin`/`end` ;
 * - détection des à-coups (frame > 1,5 × 13,9 ms) avec, pour chacun, les sections en cause
 *   et les événements de la frame (chargement de chunk, compilation de shader...) ;
 * - graphe des 144 dernières frames dans un petit panneau sous le HUD ;
 * - journal accessible depuis la console (`__perf.hitches`, `__perf.dump()`), et chaque
 *   à-coup est aussi écrit en `console.warn` (visible via chrome://inspect avec le casque).
 */
export class PerfStats {
  static readonly enabled = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

  readonly hitches: HitchRecord[] = [];
  private fps = 0;
  private frames = 0;
  private accumulated = 0;
  private readonly frameTimes = new Float32Array(HISTORY);
  private readonly cpuTimes = new Float32Array(HISTORY);
  private cursor = 0;
  private lastTimestamp = 0;
  private frameStart = 0;
  private readonly sections = new Map<string, number>();
  private readonly openSections = new Map<string, number>();
  private readonly events: string[] = [];
  private lastPrograms = 0;
  private elapsed = 0;
  private hitchCount = 0;
  private readonly graphCanvas: HTMLCanvasElement | null = null;
  private readonly graphTexture: THREE.CanvasTexture | null = null;
  private graphTimer = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
  ) {
    if (!PerfStats.enabled) return;
    // Cumule les compteurs de tous les rendus de la frame (un par œil sans multiview).
    renderer.info.autoReset = false;

    this.graphCanvas = document.createElement("canvas");
    this.graphCanvas.width = 512;
    this.graphCanvas.height = 128;
    this.graphTexture = new THREE.CanvasTexture(this.graphCanvas);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.05),
      new THREE.MeshBasicMaterial({ map: this.graphTexture, transparent: true, depthTest: false, depthWrite: false, fog: false }),
    );
    panel.position.set(0, 0.07, -0.5);
    panel.renderOrder = 997;
    panel.frustumCulled = false;
    camera.add(panel);

    (window as unknown as Record<string, unknown>)["__perf"] = {
      hitches: this.hitches,
      dump: () => console.table(this.hitches.map((h) => ({ at: h.at.toFixed(1), frameMs: h.frameMs.toFixed(1), cpuMs: h.cpuMs.toFixed(1), ...h.sections, events: h.events.join(", ") }))),
    };
  }

  /** Début de frame (timestamp du requestAnimationFrame / XR). */
  beginFrame(timestamp: number): void {
    if (!PerfStats.enabled) return;
    this.frameStart = performance.now();
    this.sections.clear();
    this.events.length = 0;
    const frameMs = this.lastTimestamp > 0 ? timestamp - this.lastTimestamp : TARGET_FRAME_MS;
    this.lastTimestamp = timestamp;
    this.frameTimes[this.cursor] = frameMs;
    this.elapsed += frameMs / 1000;
    this.frames++;
    this.accumulated += frameMs;
    if (this.accumulated >= 500) {
      this.fps = (this.frames * 1000) / this.accumulated;
      this.frames = 0;
      this.accumulated = 0;
    }
  }

  begin(section: string): void {
    if (PerfStats.enabled) this.openSections.set(section, performance.now());
  }

  end(section: string): void {
    if (!PerfStats.enabled) return;
    const start = this.openSections.get(section);
    if (start === undefined) return;
    this.sections.set(section, (this.sections.get(section) ?? 0) + performance.now() - start);
  }

  /** Événement notable de la frame (chunk chargé, régénération...) : joint à l'à-coup éventuel. */
  event(label: string): void {
    if (PerfStats.enabled) this.events.push(label);
  }

  /** Fin de frame (après le rendu) : mesure CPU, détection d'à-coup, graphe. */
  endFrame(deltaSeconds: number): void {
    if (!PerfStats.enabled) return;
    const cpuMs = performance.now() - this.frameStart;
    this.cpuTimes[this.cursor] = cpuMs;
    const frameMs = this.frameTimes[this.cursor]!;
    this.cursor = (this.cursor + 1) % HISTORY;

    const programs = this.renderer.info.programs?.length ?? 0;
    if (programs > this.lastPrograms) this.events.push(`shader x${programs - this.lastPrograms}`);
    this.lastPrograms = programs;

    // À-coup : la frame a duré trop longtemps, ou le CPU a dépassé le budget à lui seul.
    if (frameMs > TARGET_FRAME_MS * HITCH_FACTOR || cpuMs > TARGET_FRAME_MS) {
      this.hitchCount++;
      const sections: Record<string, number> = {};
      [...this.sections.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .forEach(([name, ms]) => (sections[name] = Math.round(ms * 10) / 10));
      const record: HitchRecord = { at: this.elapsed, frameMs, cpuMs, sections, events: [...this.events] };
      this.hitches.push(record);
      if (this.hitches.length > MAX_LOG) this.hitches.shift();
      console.warn(`[perf] à-coup ${frameMs.toFixed(1)} ms (CPU ${cpuMs.toFixed(1)} ms)`, sections, record.events);
    }

    this.graphTimer += deltaSeconds;
    if (this.graphTimer > 0.25) {
      this.graphTimer = 0;
      this.drawGraph();
    }
  }

  /** Deux lignes pour le HUD (lit puis remet à zéro les compteurs du rendu). */
  readAndReset(): string | null {
    if (!PerfStats.enabled) return null;
    const { render, memory } = this.renderer.info;
    const last = this.hitches[this.hitches.length - 1];
    const worst = last ? ` · dernier ${last.frameMs.toFixed(0)}ms ${Object.keys(last.sections)[0] ?? ""}${last.events[0] ? " " + last.events[0] : ""}` : "";
    const line = `FPS ${this.fps.toFixed(0)} DC ${render.calls} TRI ${(render.triangles / 1000).toFixed(0)}k GEO ${memory.geometries} TEX ${memory.textures} À-COUPS ${this.hitchCount}${worst}`;
    this.renderer.info.reset();
    return line;
  }

  private drawGraph(): void {
    const canvas = this.graphCanvas;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !this.graphTexture) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, width, height);
    const scale = height / (TARGET_FRAME_MS * 3);
    const barWidth = width / HISTORY;
    for (let i = 0; i < HISTORY; i++) {
      const index = (this.cursor + i) % HISTORY;
      const frame = this.frameTimes[index]!;
      const cpu = this.cpuTimes[index]!;
      const x = i * barWidth;
      ctx.fillStyle = frame > TARGET_FRAME_MS * HITCH_FACTOR ? "#ff5a4a" : "#6fd66f";
      ctx.fillRect(x, height - Math.min(height, frame * scale), barWidth, Math.min(height, frame * scale));
      ctx.fillStyle = "rgba(120,180,255,0.9)";
      ctx.fillRect(x, height - Math.min(height, cpu * scale), barWidth * 0.5, Math.min(height, cpu * scale));
    }
    // Ligne du budget 72 Hz.
    ctx.strokeStyle = "#ffe89a";
    ctx.beginPath();
    ctx.moveTo(0, height - TARGET_FRAME_MS * scale);
    ctx.lineTo(width, height - TARGET_FRAME_MS * scale);
    ctx.stroke();
    this.graphTexture.needsUpdate = true;
  }
}

/** Instance globale (créée dans main.ts) : les modules du monde y signalent leurs événements. */
export let perf: PerfStats | null = null;
export function setPerf(instance: PerfStats): void {
  perf = instance;
}
