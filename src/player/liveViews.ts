import * as THREE from "three";
import { perf } from "./perfStats";

/** Une vue est rendue si elle a été demandée récemment (sinon on arrête de la calculer). */
const IDLE_SECONDS = 0.4;

interface View {
  camera: THREE.PerspectiveCamera;
  target: THREE.WebGLRenderTarget;
  interval: number;
  timer: number;
  lastUsed: number;
  /** Surfaces qui affichent cette vue : masquées pendant son rendu (pas de boucle de rétroaction). */
  displays: THREE.Object3D[];
}

/**
 * Vues en direct (télé qui montre la vue du Cadreur, caméra de surveillance, jumelles, loupe,
 * viseur du caméscope) : des caméras secondaires rendues dans de petites textures. Budget Quest :
 * basse définition, cadence réduite, au plus une vue rendue par frame, et seulement les vues
 * réellement regardées (demandées à la frame précédente).
 */
export class LiveViews {
  private readonly views = new Map<string, View>();
  private time = 0;
  /** Mesures pour le journal de debug (remises à zéro à chaque lecture). */
  private statRenders = 0;
  private statMs = 0;
  private statMaxMs = 0;
  private readonly statIds = new Set<string>();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly playerCamera: THREE.Camera,
  ) {}

  /**
   * Demande la vue `id` pour cette frame : renvoie sa caméra (à placer par l'appelant) et la
   * texture où elle est rendue. Créée à la première demande.
   */
  use(id: string, width: number, height: number, fps: number, fov: number, displays: THREE.Object3D[] = []): { camera: THREE.PerspectiveCamera; texture: THREE.Texture } {
    let view = this.views.get(id);
    if (!view) {
      const target = new THREE.WebGLRenderTarget(width, height);
      target.texture.colorSpace = THREE.SRGBColorSpace;
      view = { camera: new THREE.PerspectiveCamera(fov, width / height, 0.05, 40), target, interval: 1 / fps, timer: 0, lastUsed: this.time, displays };
      this.views.set(id, view);
    }
    view.lastUsed = this.time;
    view.displays = displays;
    if (view.camera.fov !== fov) {
      view.camera.fov = fov;
      view.camera.updateProjectionMatrix();
    }
    return { camera: view.camera, texture: view.target.texture };
  }

  /** Libère une vue (objet retiré du monde). */
  release(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    view.target.dispose();
    this.views.delete(id);
  }

  /** Avant le rendu principal : rend la vue active la plus en retard (une seule par frame). */
  render(deltaSeconds: number): void {
    this.time += deltaSeconds;
    let due: View | null = null;
    let dueId = "";
    for (const [id, view] of this.views) {
      if (this.time - view.lastUsed > IDLE_SECONDS) continue;
      this.statIds.add(id);
      view.timer -= deltaSeconds;
      if (view.timer <= 0 && (!due || view.timer < due.timer)) {
        due = view;
        dueId = id;
      }
    }
    if (!due) return;
    due.timer = due.interval;
    due.camera.updateMatrixWorld();
    const started = performance.now();
    renderOffscreen(this.renderer, this.scene, this.playerCamera, due.camera, due.target, due.displays);
    const ms = performance.now() - started;
    this.statRenders++;
    this.statMs += ms;
    this.statMaxMs = Math.max(this.statMaxMs, ms);
    perf?.event(`vue ${dueId}`);
  }

  /** Mesures de la seconde écoulée (journal de debug), puis remise à zéro. */
  drainStats(): { renders: number; ms: number; maxMs: number; ids: string[] } | undefined {
    if (this.statIds.size === 0 && this.statRenders === 0) return undefined;
    const stats = { renders: this.statRenders, ms: Math.round(this.statMs * 10) / 10, maxMs: Math.round(this.statMaxMs * 10) / 10, ids: [...this.statIds] };
    this.statRenders = 0;
    this.statMs = 0;
    this.statMaxMs = 0;
    this.statIds.clear();
    return stats;
  }
}

/**
 * Rendu hors écran d'une caméra secondaire : sans ce qui est accroché à la tête du joueur (HUD,
 * vignette, grain), sans les surfaces qui affichent la vue, et hors du mode XR (sinon le moteur
 * remplace la caméra par celle du casque).
 */
export function renderOffscreen(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  playerCamera: THREE.Camera,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget,
  hide: THREE.Object3D[] = [],
): boolean {
  const hidden = [...playerCamera.children, ...hide].filter((object) => object.visible);
  for (const object of hidden) object.visible = false;
  const xrEnabled = renderer.xr.enabled;
  const previousTarget = renderer.getRenderTarget();
  renderer.xr.enabled = false;
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    return true;
  } catch {
    return false;
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.xr.enabled = xrEnabled;
    for (const object of hidden) object.visible = true;
  }
}
