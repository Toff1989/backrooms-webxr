import * as THREE from "three";
import { onLanguageChange } from "../i18n";
import { getModelShape } from "../physics/modelShape";
import { loreFormat } from "../shared/lore";
import { spawnCollectibleModel } from "./collectibleLoader";
import { drawAgedPaper, drawFiche, drawLoreText, drawPolaroidBack, drawPolaroidFront, getLorePhoto, saveLorePhoto } from "./loreArt";
import { applyVhsEffect } from "./vhsMaterial";

/** Feuille A5 (m) : lisible tenue à 30-40 cm du visage, comme un vrai papier. */
const PAGE_WIDTH = 0.148;
const PAGE_LENGTH = 0.21;
/** Épaisseur de carton fin : une feuille réelle (0,1 mm) ferait vibrer la physique. */
const PAGE_THICKNESS = 0.003;
const PAGE_CANVAS_W = 512;
const PAGE_CANVAS_H = Math.round((PAGE_CANVAS_W * PAGE_LENGTH) / PAGE_WIDTH);
/** Polaroid 600 : 88 × 107 mm. */
const POLAROID_WIDTH = 0.088;
const POLAROID_LENGTH = 0.107;
const POLAROID_THICKNESS = 0.0025;
const POLAROID_CANVAS_W = 352;
const POLAROID_CANVAS_H = Math.round((POLAROID_CANVAS_W * POLAROID_LENGTH) / POLAROID_WIDTH);
/**
 * Épaisseur minimale de la forme de collision : la coque est calculée sur des sommets fusionnés
 * au demi-centimètre (voir `modelShape`) — une feuille de 3 mm y devenait plate (4 points
 * coplanaires), une coque dégénérée qui faisait s'enfoncer les objets posés à côté.
 */
const COLLISION_THICKNESS = 0.01;
/** Durée (s) du développement d'un polaroid, de la chimie brune à l'image. */
const DEVELOP_SECONDS = 7;

/**
 * Services fournis par le jeu (voir `main.ts`) : photographier la scène derrière le joueur
 * (polaroid) et lire une cassette (grésillement + sous-titres dans le viseur).
 */
export interface LoreServices {
  capturePhoto(): HTMLCanvasElement | null;
  playTape(fragment: number): void;
}
let services: LoreServices | null = null;

export function configureLoreServices(value: LoreServices): void {
  services = value;
}

export function playLoreTape(fragment: number): void {
  services?.playTape(fragment);
}

/** Bande perdue posée dans le monde : un objet saisissable, lu quand on le prend en main. */
export interface LoreObject {
  model: THREE.Object3D;
  template: THREE.Object3D;
  mass: number;
  /** Hauteur (m) du centre de l'objet posé au sol. */
  restHeight: number;
  /** Première saisie : la bande est lue (photo développée, cassette lancée). */
  onRead(): void;
  dispose(): void;
}

interface Redrawable {
  redraw(): void;
}
const liveObjects = new Set<Redrawable>();
onLanguageChange(() => {
  for (const object of liveObjects) object.redraw();
});

interface Developing {
  progress: number;
  redraw(): void;
}
const developing = new Set<Developing>();

/** Chaque frame : fait avancer le développement des polaroids qu'on vient de ramasser. */
export function updateLoreObjects(deltaSeconds: number): void {
  for (const photo of developing) {
    photo.progress = Math.min(1, photo.progress + deltaSeconds / DEVELOP_SECONDS);
    photo.redraw();
    if (photo.progress >= 1) developing.delete(photo);
  }
}

function canvasTexture(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { canvas, ctx: canvas.getContext("2d")!, texture };
}

/** Face imprimée légèrement luminescente : on la devine dans la pénombre, on la lit de près. */
function faceMaterial(texture: THREE.Texture, glow: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: glow, roughness: 0.9 });
  applyVhsEffect(material);
  return material;
}

/** Carte fine (feuille, photo) : tranche, recto (+Y, haut du contenu vers -Z) et verso. */
function card(width: number, length: number, thickness: number, front: THREE.Material, back: THREE.Material, edgeColor: number): { model: THREE.Group; template: THREE.Group } {
  const edge = new THREE.MeshStandardMaterial({ color: edgeColor, roughness: 0.95 });
  applyVhsEffect(edge);
  const edgeGeometry = new THREE.BoxGeometry(width, thickness, length);
  const faceGeometry = new THREE.PlaneGeometry(width, length);
  const model = new THREE.Group();
  model.add(new THREE.Mesh(edgeGeometry, edge));
  const recto = new THREE.Mesh(faceGeometry, front);
  recto.rotation.x = -Math.PI / 2;
  recto.position.y = thickness / 2 + 0.0004;
  const verso = new THREE.Mesh(faceGeometry, back);
  verso.rotation.x = Math.PI / 2;
  verso.rotation.z = Math.PI;
  verso.position.y = -thickness / 2 - 0.0004;
  model.add(recto, verso);
  // Forme physique : une boîte d'au moins 1 cm d'épaisseur (le visuel reste une feuille fine).
  const template = new THREE.Group();
  template.add(new THREE.Mesh(new THREE.BoxGeometry(width, Math.max(thickness, COLLISION_THICKNESS), length), edge));
  return { model, template };
}

function disposeModel(model: THREE.Object3D, template?: THREE.Object3D): void {
  template?.traverse((child) => {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  });
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const material = child.material as THREE.MeshStandardMaterial;
    material.map?.dispose();
    material.dispose();
  });
}

/** Note manuscrite ou fiche de montage : une feuille A5. */
function createSheet(fragment: number): LoreObject {
  const front = canvasTexture(PAGE_CANVAS_W, PAGE_CANVAS_H);
  const back = canvasTexture(PAGE_CANVAS_W / 2, PAGE_CANVAS_H / 2);
  drawAgedPaper(back.ctx, 0, 0, back.canvas.width, back.canvas.height, 3, false);
  back.texture.needsUpdate = true;
  const fiche = loreFormat(fragment) === "fiche";
  const page: Redrawable = {
    redraw: () => {
      drawAgedPaper(front.ctx, 0, 0, PAGE_CANVAS_W, PAGE_CANVAS_H, fragment + 7, !fiche);
      if (fiche) drawFiche(front.ctx, 0, 0, PAGE_CANVAS_W, fragment);
      else drawLoreText(front.ctx, 0, 0, PAGE_CANVAS_W, fragment);
      front.texture.needsUpdate = true;
    },
  };
  page.redraw();
  liveObjects.add(page);
  const backMaterial = new THREE.MeshStandardMaterial({ map: back.texture, roughness: 0.95 });
  applyVhsEffect(backMaterial);
  const { model, template } = card(PAGE_WIDTH, PAGE_LENGTH, PAGE_THICKNESS, faceMaterial(front.texture, 0.28), backMaterial, 0xd9c9a3);
  return {
    model,
    template,
    mass: 0.1,
    restHeight: COLLISION_THICKNESS / 2 + 0.004,
    onRead: () => {},
    dispose: () => {
      liveObjects.delete(page);
      disposeModel(model, template);
    },
  };
}

/**
 * Polaroid : vierge quand on le trouve. Ramassé, il se développe en quelques secondes et
 * révèle la scène photographiée derrière le joueur, à l'instant où il l'a pris. La légende est
 * écrite au dos. Déjà développé une fois (autre run) : la photo gardée revient.
 */
function createPolaroid(fragment: number): LoreObject {
  const front = canvasTexture(POLAROID_CANVAS_W, POLAROID_CANVAS_H);
  const back = canvasTexture(POLAROID_CANVAS_W, POLAROID_CANVAS_H);
  let photo: CanvasImageSource | null = getLorePhoto(fragment);
  const state: Developing & Redrawable = {
    progress: photo ? 1 : 0,
    redraw: () => {
      drawPolaroidFront(front.ctx, 0, 0, POLAROID_CANVAS_W, photo, state.progress, fragment);
      drawPolaroidBack(back.ctx, 0, 0, POLAROID_CANVAS_W, fragment);
      front.texture.needsUpdate = true;
      back.texture.needsUpdate = true;
    },
  };
  state.redraw();
  liveObjects.add(state);
  const { model, template } = card(POLAROID_WIDTH, POLAROID_LENGTH, POLAROID_THICKNESS, faceMaterial(front.texture, 0.2), faceMaterial(back.texture, 0.1), 0xf1eee6);
  return {
    model,
    template,
    mass: 0.02,
    restHeight: COLLISION_THICKNESS / 2 + 0.004,
    onRead: () => {
      if (state.progress > 0 || developing.has(state)) return;
      const shot = services?.capturePhoto() ?? null;
      if (!shot) return;
      photo = shot;
      saveLorePhoto(fragment, shot);
      developing.add(state);
    },
    dispose: () => {
      liveObjects.delete(state);
      developing.delete(state);
      disposeModel(model, template);
    },
  };
}

/** Cassette audio : le modèle de cassette de la collection ; la prendre en main la lit. */
async function createCassette(fragment: number): Promise<LoreObject> {
  const { model, template } = await spawnCollectibleModel("tape");
  const lowest = getModelShape(template).box.min.y;
  return {
    model,
    template,
    mass: 0.08,
    restHeight: 0.006 - lowest,
    onRead: () => playLoreTape(fragment),
    dispose: () => {},
  };
}

/** Objet de la bande perdue `fragment`, selon sa forme (feuille, polaroid, cassette). */
export async function createLoreObject(fragment: number): Promise<LoreObject> {
  const format = loreFormat(fragment);
  if (format === "audio") return createCassette(fragment);
  if (format === "polaroid") return createPolaroid(fragment);
  return createSheet(fragment);
}
