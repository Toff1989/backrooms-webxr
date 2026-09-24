import * as THREE from "three";
import { DEBUG_ENABLED, flushStats, log } from "../debug/debugLog";

/** Baisse du tas JS d'une frame à l'autre au-delà de laquelle on note un passage du ramasse-miettes. */
const GC_DROP_BYTES = 2 * 1048576;
const MAX_PENDING_GPU_QUERIES = 8;

interface TimerQueryExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

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
  /** Temps entre la fin de la frame précédente et le début de celle-ci (JS au repos ou occupé ailleurs). */
  gapMs: number;
  /** Dernier temps GPU mesuré (ms), si le navigateur le permet. */
  gpuMs: number | null;
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
 * - journal accessible depuis la console (`__perf.hitches`, `__perf.dump()`) ; à-coups et
 *   statistiques par seconde envoyés au serveur (voir `debug/debugLog.ts`).
 */
export class PerfStats {
  static readonly enabled = DEBUG_ENABLED;

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
  /** Agrégats de la seconde en cours, envoyés au journal de debug. */
  private secFrames = 0;
  private secFrameSum = 0;
  private secFrameMax = 0;
  private secCpuSum = 0;
  private secCalls = 0;
  private secTriangles = 0;
  private secHitches = 0;
  private readonly secSections = new Map<string, number>();
  private secTimer = 0;
  /** Temps GPU du rendu (EXT_disjoint_timer_query_webgl2) : requêtes en attente de résultat. */
  private readonly gl: WebGL2RenderingContext | null = null;
  private readonly timerExt: TimerQueryExtension | null = null;
  private readonly gpuQueries: WebGLQuery[] = [];
  private gpuQueryOpen = false;
  private lastGpuMs: number | null = null;
  private secGpuSum = 0;
  private secGpuMax = 0;
  private secGpuCount = 0;
  /** Tâches longues hors de la boucle de rendu (PerformanceObserver "longtask"). */
  private readonly longTasks: Array<{ start: number; duration: number }> = [];
  private secLongTasks = 0;
  private secLongTaskMax = 0;
  private lastFrameEnd = 0;
  private lastHeap = 0;
  private secGc = 0;
  private lastFlushCount = 0;
  /** Informations de contexte ajoutées à chaque statistique (position, audio...). */
  extra: () => Record<string, unknown> = () => ({});

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
  ) {
    if (!PerfStats.enabled) return;
    // Cumule les compteurs de tous les rendus de la frame (un par œil sans multiview).
    renderer.info.autoReset = false;

    // Temps GPU : distingue une frame lente côté GPU (upload, remplissage) d'un blocage du JS.
    const gl = renderer.getContext();
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
      this.gl = gl;
      this.timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQueryExtension | null;
    }
    // Tâches longues (≥ 50 ms) du fil principal, hors frame : ramasse-miettes, réseau, décodage...
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.push({ start: entry.startTime, duration: entry.duration });
          if (this.longTasks.length > 20) this.longTasks.shift();
          this.secLongTasks++;
          this.secLongTaskMax = Math.max(this.secLongTaskMax, entry.duration);
        }
      }).observe({ type: "longtask", buffered: false });
    } catch {
      // Non pris en charge : les à-coups restent décrits sans cette information.
    }

    this.graphCanvas = document.createElement("canvas");
    this.graphCanvas.width = 512;
    this.graphCanvas.height = 128;
    this.graphTexture = new THREE.CanvasTexture(this.graphCanvas);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.05),
      new THREE.MeshBasicMaterial({ map: this.graphTexture, transparent: true, depthTest: false, depthWrite: false, fog: false }),
    );
    panel.position.set(-0.13, -0.11, -0.5);
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
    this.pollGpu();
    // Passage du ramasse-miettes : le tas a nettement baissé depuis la frame précédente.
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    if (this.lastHeap - heap > GC_DROP_BYTES) {
      this.events.push(`GC -${Math.round((this.lastHeap - heap) / 1048576)} Mo`);
      this.secGc++;
    }
    this.lastHeap = heap;
    if (flushStats.count !== this.lastFlushCount) {
      this.lastFlushCount = flushStats.count;
      this.events.push(`envoi journal ${Math.round(flushStats.lastBytes / 1024)} Ko`);
    }
    // Tâches longues survenues depuis la fin de la frame précédente.
    for (const task of this.longTasks) {
      if (task.start + task.duration >= this.lastFrameEnd - 1) this.events.push(`tâche longue ${Math.round(task.duration)} ms`);
    }
    this.longTasks.length = 0;
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

  /** Autour de `renderer.render` : mesure du temps GPU (résultat lu quelques frames plus tard). */
  beginGpu(): void {
    if (!this.gl || !this.timerExt || this.gpuQueryOpen || this.gpuQueries.length >= MAX_PENDING_GPU_QUERIES) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, query);
    this.gpuQueries.push(query);
    this.gpuQueryOpen = true;
  }

  endGpu(): void {
    if (!this.gl || !this.timerExt || !this.gpuQueryOpen) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    this.gpuQueryOpen = false;
  }

  private pollGpu(): void {
    const gl = this.gl;
    if (!gl || !this.timerExt) return;
    const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT) as boolean;
    while (this.gpuQueries.length > 0) {
      const query = this.gpuQueries[0]!;
      if (this.gpuQueryOpen && this.gpuQueries.length === 1) break;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(query);
      this.gpuQueries.shift();
      if (disjoint) continue;
      const ms = nanoseconds / 1e6;
      this.lastGpuMs = ms;
      this.secGpuSum += ms;
      this.secGpuMax = Math.max(this.secGpuMax, ms);
      this.secGpuCount++;
    }
  }

  /** Événement notable de la frame (chunk chargé, régénération...) : joint à l'à-coup éventuel. */
  event(label: string): void {
    if (PerfStats.enabled) this.events.push(label);
  }

  /** Fin de frame (après le rendu) : mesure CPU, détection d'à-coup, graphe. */
  endFrame(deltaSeconds: number): void {
    if (!PerfStats.enabled) return;
    const frameEnd = performance.now();
    const cpuMs = frameEnd - this.frameStart;
    const gapMs = this.lastFrameEnd > 0 ? this.frameStart - this.lastFrameEnd : 0;
    this.lastFrameEnd = frameEnd;
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
      const gpuMs = this.lastGpuMs === null ? null : Math.round(this.lastGpuMs * 10) / 10;
      const record: HitchRecord = { at: this.elapsed, frameMs, cpuMs, gapMs, gpuMs, sections, events: [...this.events] };
      this.hitches.push(record);
      if (this.hitches.length > MAX_LOG) this.hitches.shift();
      this.secHitches++;
      log("hitch", {
        frameMs: Math.round(frameMs * 10) / 10,
        cpuMs: Math.round(cpuMs * 10) / 10,
        gapMs: Math.round(gapMs * 10) / 10,
        gpuMs,
        sections,
        events: record.events,
      });
    }

    this.secFrames++;
    this.secFrameSum += frameMs;
    this.secFrameMax = Math.max(this.secFrameMax, frameMs);
    this.secCpuSum += cpuMs;
    for (const [name, ms] of this.sections) this.secSections.set(name, (this.secSections.get(name) ?? 0) + ms);
    this.secTimer += deltaSeconds;
    if (this.secTimer >= 1) this.flushSecond();

    this.graphTimer += deltaSeconds;
    if (this.graphTimer > 0.25) {
      this.graphTimer = 0;
      this.drawGraph();
    }
  }

  /** Statistiques de la seconde écoulée -> journal de debug. */
  private flushSecond(): void {
    const frames = Math.max(1, this.secFrames);
    const sections: Record<string, number> = {};
    for (const [name, ms] of this.secSections) sections[name] = Math.round((ms / frames) * 100) / 100;
    const memoryInfo = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    log("stats", {
      fps: Math.round((this.secFrames * 1000) / Math.max(1, this.secFrameSum)),
      frameAvg: Math.round((this.secFrameSum / frames) * 10) / 10,
      frameMax: Math.round(this.secFrameMax * 10) / 10,
      cpuAvg: Math.round((this.secCpuSum / frames) * 10) / 10,
      sections,
      drawCalls: Math.round(this.secCalls / frames),
      triangles: Math.round(this.secTriangles / frames),
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.renderer.info.programs?.length ?? 0,
      heapMB: memoryInfo ? Math.round(memoryInfo.usedJSHeapSize / 1048576) : undefined,
      gpuAvg: this.secGpuCount ? Math.round((this.secGpuSum / this.secGpuCount) * 10) / 10 : undefined,
      gpuMax: this.secGpuCount ? Math.round(this.secGpuMax * 10) / 10 : undefined,
      longTasks: this.secLongTasks || undefined,
      longTaskMax: this.secLongTasks ? Math.round(this.secLongTaskMax) : undefined,
      gc: this.secGc || undefined,
      hitches: this.secHitches,
      ...this.extra(),
    });
    this.secFrames = 0;
    this.secFrameSum = 0;
    this.secFrameMax = 0;
    this.secCpuSum = 0;
    this.secCalls = 0;
    this.secTriangles = 0;
    this.secHitches = 0;
    this.secGpuSum = 0;
    this.secGpuMax = 0;
    this.secGpuCount = 0;
    this.secLongTasks = 0;
    this.secLongTaskMax = 0;
    this.secGc = 0;
    this.secSections.clear();
    this.secTimer = 0;
  }

  /** Deux lignes pour le HUD (lit puis remet à zéro les compteurs du rendu). */
  readAndReset(): string | null {
    if (!PerfStats.enabled) return null;
    const { render, memory } = this.renderer.info;
    this.secCalls += render.calls;
    this.secTriangles += render.triangles;
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
