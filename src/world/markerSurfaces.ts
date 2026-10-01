import * as THREE from "three";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import { CELL_SIZE, WALL_HEIGHT } from "../shared/constants";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Dessin au marqueur : des tuiles canvas (une par cellule de 2,5 m et par plan : sol, plafond,
 * face de mur) créées à la demande et posées comme des décalques transparents juste devant la
 * surface. Un trait est une suite de segments dessinés dans le canvas de la tuile touchée (et de
 * sa voisine quand il la traverse) ; la gomme efface avec `destination-out`.
 *
 * Mémoire bornée : au plus `MAX_TILES` canvas de `TILE_PIXELS`² (les plus anciennement utilisés
 * sont recyclés), toutes effacées à chaque changement de niveau — les traits ne vivent que le
 * temps de la partie en cours (pas de sauvegarde).
 */
const TILE_SIZE = CELL_SIZE;
const TILE_PIXELS = 512;
const MAX_TILES = 40;
/** Distance (m) de la mine à la surface en dessous de laquelle elle écrit. */
const CONTACT_DISTANCE = 0.028;
/** Décalage (m) du décalque devant la surface : le relief des murs (displacement) ne doit pas l'enfouir. */
const WALL_OFFSET = 0.02;
const FLAT_OFFSET = 0.004;
/** Largeur du trait (m) et de la gomme. */
const INK_WIDTH = 0.02;
const ERASER_WIDTH = 0.09;
/** Au-delà (m) d'un saut entre deux points, on ne relie pas : nouveau trait. */
const MAX_SEGMENT = 0.25;
/** Les tuiles au-delà de cette distance (m) ne sont pas rendues. */
const VISIBLE_DISTANCE = 28;

const UP = new THREE.Vector3(0, 1, 0);
const WALL_DIRECTIONS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

export interface SurfaceContact {
  /** Identifiant du plan (sol, plafond, face d'un mur) : deux points de même plan se relient. */
  plane: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

interface Tile {
  key: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  width: number;
  height: number;
  dirty: boolean;
  lastUsed: number;
}

/** Dernier point d'un trait en cours (par main/marqueur). */
export interface Pen {
  plane: string;
  point: THREE.Vector3;
}

const rel = new THREE.Vector3();
const basis = new THREE.Matrix4();
const queryRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });

export class MarkerSurfaces {
  private readonly tiles = new Map<string, Tile>();
  private frame = 0;
  private visibilityTimer = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
  ) {}

  /** Tuiles actuellement allouées (tests, perf). */
  get tileCount(): number {
    return this.tiles.size;
  }

  /** Efface tous les traits (changement de level, nouvelle partie). */
  clear(): void {
    for (const tile of this.tiles.values()) this.disposeTile(tile);
    this.tiles.clear();
  }

  /**
   * Surface touchée par la mine : sol, plafond (à plat, analytique) ou face de mur/pilier (rayons
   * courts le long des quatre axes horizontaux). Rien si la mine est en l'air.
   */
  probe(tip: THREE.Vector3): SurfaceContact | null {
    if (tip.y < CONTACT_DISTANCE && tip.y > -0.1) {
      return { plane: "floor", point: new THREE.Vector3(tip.x, 0, tip.z), normal: new THREE.Vector3(0, 1, 0) };
    }
    if (tip.y > WALL_HEIGHT - CONTACT_DISTANCE && tip.y < WALL_HEIGHT + 0.1) {
      return { plane: "ceiling", point: new THREE.Vector3(tip.x, WALL_HEIGHT, tip.z), normal: new THREE.Vector3(0, -1, 0) };
    }
    let best: { distance: number; dir: { x: number; z: number }; normal: { x: number; y: number; z: number } } | null = null;
    // Rayon lancé depuis un peu en retrait de la mine : tolère une mine légèrement enfoncée dans le mur.
    const back = 0.02;
    for (const dir of WALL_DIRECTIONS) {
      queryRay.origin = { x: tip.x - dir.x * back, y: tip.y, z: tip.z - dir.z * back };
      queryRay.dir = { x: dir.x, y: 0, z: dir.z };
      const hit = this.physics.world.castRayAndGetNormal(queryRay, back + CONTACT_DISTANCE, true, undefined, CollisionGroups.queryWalls);
      if (!hit) continue;
      const distance = hit.timeOfImpact - back;
      if (!best || distance < best.distance) best = { distance, dir, normal: hit.normal };
    }
    if (!best) return null;
    const normal = new THREE.Vector3(best.normal.x, 0, best.normal.z);
    // Normale ramenée à l'axe dominant (les murs sont alignés sur la grille), orientée vers la mine.
    if (Math.abs(normal.x) >= Math.abs(normal.z)) normal.set(Math.sign(normal.x || -best.dir.x), 0, 0);
    else normal.set(0, 0, Math.sign(normal.z || -best.dir.z));
    const point = new THREE.Vector3(tip.x + best.dir.x * Math.max(0, best.distance), tip.y, tip.z + best.dir.z * Math.max(0, best.distance));
    const axis = normal.x !== 0 ? "x" : "z";
    const coordinate = Math.round((axis === "x" ? point.x : point.z) * 100);
    return { plane: `wall:${axis}:${normal.x + normal.z > 0 ? "+" : "-"}:${coordinate}`, point, normal };
  }

  /**
   * Trace (ou efface avec `color === null`) de `pen` jusqu'au contact. `pen` garde le dernier point
   * pour relier deux frames successives sur le même plan ; il est remis à zéro par l'appelant quand la mine quitte la surface.
   */
  draw(contact: SurfaceContact, pen: Pen | null, color: string | null): Pen {
    const connect = pen !== null && pen.plane === contact.plane && pen.point.distanceTo(contact.point) < MAX_SEGMENT;
    const from = connect ? pen!.point : contact.point;
    // Les tuiles couvertes par le segment : celle du point d'arrivée, celle de départ si différente.
    const tiles = new Set<Tile>();
    tiles.add(this.tileFor(contact, contact.point));
    if (connect) tiles.add(this.tileFor(contact, from));
    for (const tile of tiles) this.stroke(tile, from, contact.point, color);
    return { plane: contact.plane, point: contact.point.clone() };
  }

  /** À appeler à chaque frame : envoie les canvas modifiés au GPU, masque les tuiles lointaines. */
  update(deltaSeconds: number, head: THREE.Vector3): void {
    this.frame++;
    for (const tile of this.tiles.values()) {
      if (!tile.dirty) continue;
      tile.dirty = false;
      tile.texture.needsUpdate = true;
    }
    this.visibilityTimer -= deltaSeconds;
    if (this.visibilityTimer > 0) return;
    this.visibilityTimer = 0.5;
    for (const tile of this.tiles.values()) tile.mesh.visible = tile.center.distanceToSquared(head) < VISIBLE_DISTANCE * VISIBLE_DISTANCE;
  }

  private tileFor(contact: SurfaceContact, point: THREE.Vector3): Tile {
    const { plane, normal } = contact;
    let key: string;
    let center: THREE.Vector3;
    let xAxis: THREE.Vector3;
    let yAxis: THREE.Vector3;
    let width = TILE_SIZE;
    let height = TILE_SIZE;
    let offset = FLAT_OFFSET;
    if (plane === "floor" || plane === "ceiling") {
      const i = Math.floor(point.x / TILE_SIZE);
      const j = Math.floor(point.z / TILE_SIZE);
      key = `${plane}:${i}:${j}`;
      center = new THREE.Vector3((i + 0.5) * TILE_SIZE, plane === "floor" ? 0 : WALL_HEIGHT, (j + 0.5) * TILE_SIZE);
      xAxis = new THREE.Vector3(1, 0, 0);
      yAxis = new THREE.Vector3(0, 0, plane === "floor" ? -1 : 1);
    } else {
      const alongX = normal.z !== 0;
      const along = alongX ? point.x : point.z;
      const i = Math.floor(along / TILE_SIZE);
      key = `${plane}:${i}`;
      const fixed = alongX ? point.z : point.x;
      center = alongX ? new THREE.Vector3((i + 0.5) * TILE_SIZE, WALL_HEIGHT / 2, fixed) : new THREE.Vector3(fixed, WALL_HEIGHT / 2, (i + 0.5) * TILE_SIZE);
      xAxis = new THREE.Vector3().crossVectors(UP, normal).normalize();
      yAxis = UP.clone();
      height = WALL_HEIGHT;
      offset = WALL_OFFSET;
    }
    let tile = this.tiles.get(key);
    if (!tile) {
      if (this.tiles.size >= MAX_TILES) this.recycleOldest();
      tile = this.createTile(key, center.addScaledVector(normal, offset), xAxis, yAxis, normal, width, height);
      this.tiles.set(key, tile);
    }
    tile.lastUsed = this.frame;
    return tile;
  }

  private createTile(key: string, center: THREE.Vector3, xAxis: THREE.Vector3, yAxis: THREE.Vector3, normal: THREE.Vector3, width: number, height: number): Tile {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_PIXELS;
    canvas.height = TILE_PIXELS;
    const ctx = canvas.getContext("2d")!;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    applyVhsEffect(material);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.position.copy(center);
    basis.makeBasis(xAxis, yAxis, normal);
    mesh.quaternion.setFromRotationMatrix(basis);
    mesh.renderOrder = 2;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    return { key, canvas, ctx, texture, material, mesh, center, xAxis, yAxis, width, height, dirty: false, lastUsed: this.frame };
  }

  private stroke(tile: Tile, from: THREE.Vector3, to: THREE.Vector3, color: string | null): void {
    const ctx = tile.ctx;
    const scale = TILE_PIXELS / tile.width;
    const toPixels = (point: THREE.Vector3): { x: number; y: number } => {
      rel.subVectors(point, tile.center);
      return { x: (rel.dot(tile.xAxis) / tile.width + 0.5) * TILE_PIXELS, y: (0.5 - rel.dot(tile.yAxis) / tile.height) * TILE_PIXELS };
    };
    const a = toPixels(from);
    const b = toPixels(to);
    // Hors du canvas (segment d'une tuile voisine, trop loin pour la toucher) : rien à dessiner ici.
    const margin = 40;
    if (Math.max(a.x, b.x) < -margin || Math.min(a.x, b.x) > TILE_PIXELS + margin || Math.max(a.y, b.y) < -margin || Math.min(a.y, b.y) > TILE_PIXELS + margin) return;
    ctx.save();
    if (color === null) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = ERASER_WIDTH * scale;
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = INK_WIDTH * scale;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    // Un point isolé (segment nul) reste visible grâce au `lineCap` rond.
    ctx.lineTo(b.x + (a.x === b.x && a.y === b.y ? 0.01 : 0), b.y);
    ctx.stroke();
    ctx.restore();
    tile.dirty = true;
  }

  private recycleOldest(): void {
    let oldest: Tile | null = null;
    for (const tile of this.tiles.values()) if (!oldest || tile.lastUsed < oldest.lastUsed) oldest = tile;
    if (!oldest) return;
    this.tiles.delete(oldest.key);
    this.disposeTile(oldest);
  }

  private disposeTile(tile: Tile): void {
    this.scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.material.dispose();
    tile.texture.dispose();
  }
}
