import * as THREE from "three";
import { log } from "../debug/debugLog";
import { getModelShape } from "../physics/modelShape";
import { preloadCollectibleTemplates } from "./collectibleLoader";
import { prepareInteractionFaces } from "./interactions";
import { preloadPropTemplates } from "./propLoader";
import { applyVhsEffect } from "./vhsMaterial";

/**
 * Travail de pré-chauffage par frame (ms) : large sur l'aperçu écran (rien ne se joue encore),
 * serré en casque (si le joueur entre en VR avant la fin, on reste sous le budget d'une frame).
 */
const PREVIEW_BUDGET_MS = 8;
const XR_BUDGET_MS = 1.5;

const TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "displacementMap",
  "bumpMap",
  "lightMap",
  "specularMap",
] as const;

type Unit = () => void;

/**
 * Pré-chauffage des ressources (ce que les moteurs appellent « PSO precaching » ou
 * « shader warm-up ») : tout ce qui, sinon, se préparait à la première apparition d'un objet en
 * pleine partie — et gelait l'image au pire moment (un meuble qui entre dans le champ, la
 * première télé allumée, le Cadreur qui surgit) :
 * - chargement de tous les modèles (meubles, objets, cassette, tête du Cadreur) ;
 * - enveloppes convexes de la physique (plusieurs ms à plusieurs dizaines de ms par modèle) et
 *   faces où les objets affichent un écran ou un cadran (télé, loupe, photo, boussole...) ;
 * - compilation des shaders de chaque matériau, en deux variantes : rendu à l'écran/casque, et
 *   rendu dans une texture (vues en direct, polaroid) — three.js compile un programme différent
 *   pour chaque cible (espace colorimétrique de sortie) ;
 * - envoi des textures au GPU (sinon fait au premier affichage, avec génération des mipmaps).
 *
 * Tout passe par une file traitée par petits morceaux dans la boucle de rendu (voir `step`) :
 * jamais de long blocage, même si le joueur entre en VR avant la fin. Les programmes compilés
 * restent en cache tant qu'un matériau les utilise : les matériaux représentatifs créés ici ne
 * sont jamais libérés.
 */
export class Warmup {
  private readonly queue: Unit[] = [];
  private readonly offscreen = new THREE.WebGLRenderTarget(1, 1);
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly representatives: THREE.Object3D[];
  private loading = true;
  private finished = false;
  private readonly startedAt = performance.now();
  private workMs = 0;
  private readonly counts = { templates: 0, hulls: 0, materials: 0, textures: 0 };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {
    this.offscreen.texture.colorSpace = THREE.SRGBColorSpace;
    this.representatives = representativeObjects();
  }

  /**
   * Lance le chargement des modèles. `pending` : autres chargements à attendre avant de passer la
   * scène en revue (Cadreur, mains) ; s'ils livrent des objets pas encore dans la scène, ceux-ci
   * sont pré-chauffés aussi (main fantôme, affichée seulement en portant un objet lourd).
   */
  start(pending: ReadonlyArray<Promise<THREE.Object3D[] | void>>): void {
    Promise.all([preloadPropTemplates(), preloadCollectibleTemplates()])
      .then(([props, collectibles]) => {
        const templates = [...props, ...collectibles];
        this.counts.templates = templates.length;
        for (const { kind, template } of templates) {
          this.queue.push(() => {
            getModelShape(template);
            this.counts.hulls++;
          });
          this.queue.push(() => prepareInteractionFaces(kind, template));
          this.enqueueObject(template);
        }
        for (const object of this.representatives) this.enqueueObject(object);
        return Promise.allSettled(pending);
      })
      .then((results) => {
        for (const result of results) {
          if (result.status === "fulfilled" && Array.isArray(result.value)) for (const object of result.value) this.enqueueObject(object);
        }
        // Toute la scène : Cadreur (caché jusqu'à son apparition), pièges muraux... et la variante
        // « rendu dans une texture » des matériaux déjà affichés (murs, sol, plafond).
        this.enqueueObject(this.scene);
      })
      .catch((error: unknown) => log("warmup", { action: "error", error: String(error) }))
      .finally(() => {
        this.loading = false;
      });
  }

  /** Vrai tant que du travail reste à faire. */
  get busy(): boolean {
    return this.loading || this.queue.length > 0;
  }

  /** À appeler dans la boucle de rendu, avant `renderer.render` : un morceau de la file. */
  step(): void {
    if (this.queue.length > 0) {
      const budget = this.renderer.xr.isPresenting ? XR_BUDGET_MS : PREVIEW_BUDGET_MS;
      const started = performance.now();
      do {
        this.queue.shift()!();
      } while (this.queue.length > 0 && performance.now() - started < budget);
      this.workMs += performance.now() - started;
    }
    if (!this.busy && !this.finished) {
      this.finished = true;
      this.offscreen.dispose();
      log("warmup", {
        action: "done",
        ...this.counts,
        workMs: Math.round(this.workMs),
        totalMs: Math.round(performance.now() - this.startedAt),
        programs: this.renderer.info.programs?.length ?? 0,
      });
    }
  }

  private enqueueObject(root: THREE.Object3D): void {
    root.traverse((object) => {
      const material = (object as Partial<THREE.Mesh>).material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      if (list.every((entry) => this.materials.has(entry))) return;
      for (const entry of list) {
        this.materials.add(entry);
        this.counts.materials++;
        for (const slot of TEXTURE_SLOTS) {
          const texture = (entry as unknown as Record<string, unknown>)[slot];
          if (!(texture instanceof THREE.Texture) || texture instanceof THREE.VideoTexture || this.textures.has(texture)) continue;
          this.textures.add(texture);
          this.queue.push(() => {
            this.renderer.initTexture(texture);
            this.counts.textures++;
          });
        }
      }
      this.queue.push(() => this.compile(object));
    });
  }

  /**
   * Programme(s) de l'objet pour les deux cibles de rendu : écran/casque et texture. Un objet
   * déjà prêt (ou retiré entre-temps de la scène) ne coûte qu'une recherche en cache.
   */
  private compile(object: THREE.Object3D): void {
    this.renderer.compile(object, this.camera, this.scene);
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.offscreen);
    try {
      this.renderer.compile(object, this.camera, this.scene);
    } finally {
      this.renderer.setRenderTarget(previous);
    }
  }
}

/**
 * Matériaux créés à la volée par les objets (écrans, cadrans, flamme, halo, aérosol, masques de
 * jumelles, bandes perdues) : un représentant de chaque combinaison suffit, le programme compilé
 * est partagé par tous les matériaux de mêmes caractéristiques.
 */
function representativeObjects(): THREE.Object3D[] {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  const plane = new THREE.PlaneGeometry(0.01, 0.01);
  const mesh = (material: THREE.Material): THREE.Mesh => new THREE.Mesh(plane, material);
  const vhs = <T extends THREE.Material>(material: T): T => {
    applyVhsEffect(material);
    return material;
  };
  const point = new THREE.BufferGeometry();
  point.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  return [
    // Écrans et cadrans (`FaceCanvas`, interactions.ts).
    mesh(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })),
    mesh(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true })),
    mesh(new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff })),
    mesh(new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, transparent: true })),
    // Masques des jumelles et de la loupe : vides, puis avec la vue en direct.
    mesh(new THREE.MeshBasicMaterial({ alphaMap: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })),
    mesh(new THREE.MeshBasicMaterial({ alphaMap: texture, transparent: true, toneMapped: false })),
    mesh(new THREE.MeshBasicMaterial({ map: texture, alphaMap: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })),
    mesh(new THREE.MeshBasicMaterial({ map: texture, alphaMap: texture, transparent: true, toneMapped: false })),
    // Flamme du briquet, halo de l'ampoule, nuage d'aérosol.
    new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })),
    new THREE.Points(point, new THREE.PointsMaterial({ color: 0xffffff, size: 0.03, transparent: true, opacity: 0.5, depthWrite: false })),
    // Bandes perdues (lorePage.ts) : faces imprimées, dos, tranche.
    mesh(vhs(new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, roughness: 0.9 }))),
    mesh(vhs(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95 }))),
    mesh(vhs(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }))),
  ];
}
