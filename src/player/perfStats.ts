import type * as THREE from "three";

/**
 * Mesures de perfs affichées dans le HUD caméscope (`?debug=1`) : lisibles en casque, là où
 * les outils du navigateur ne sont pas accessibles. FPS lissé, draw calls et triangles de la
 * dernière frame (les deux yeux compris en XR), géométries/textures en mémoire GPU.
 */
export class PerfStats {
  static readonly enabled = new URLSearchParams(window.location.search).has("debug");

  private fps = 0;
  private frames = 0;
  private accumulated = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    // Cumule les compteurs de tous les rendus de la frame (un par œil sans multiview).
    if (PerfStats.enabled) renderer.info.autoReset = false;
  }

  /** À appeler juste avant `renderer.render` (remet les compteurs à zéro pour la frame). */
  beginFrame(deltaSeconds: number): void {
    if (!PerfStats.enabled) return;
    this.frames++;
    this.accumulated += deltaSeconds;
    if (this.accumulated >= 0.5) {
      this.fps = this.frames / this.accumulated;
      this.frames = 0;
      this.accumulated = 0;
    }
  }

  /** Ligne à afficher (lit les compteurs de la frame précédente, puis les remet à zéro). */
  readAndReset(): string | null {
    if (!PerfStats.enabled) return null;
    const { render, memory } = this.renderer.info;
    const line = `FPS ${this.fps.toFixed(0)}  DC ${render.calls}  TRI ${(render.triangles / 1000).toFixed(0)}k  GEO ${memory.geometries}  TEX ${memory.textures}`;
    this.renderer.info.reset();
    return line;
  }
}
