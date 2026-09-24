import * as THREE from "three";
import deskLampUrl from "../assets/models/intro/deskLamp.glb";
import fluorescentLightUrl from "../assets/models/intro/fluorescentLight.glb";
import pictureFrameUrl from "../assets/models/intro/pictureFrame.glb";
import projector8mmUrl from "../assets/models/intro/projector8mm.glb";
import { t, tList, type TranslationKey } from "../i18n";
import { getModelShape } from "../physics/modelShape";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import type { CamcorderHud } from "../player/camcorderHud";
import { WALL_HEIGHT } from "../shared/constants";
import type { PropKind } from "../shared/props";
import { spawnCollectibleModel } from "./collectibleLoader";
import type { CollectionEntry } from "./collection";
import type { Grabbable, GrabbableRegistry } from "./grabbable";
import { loadTemplateModel } from "./gltfLoader";
import type { InteractionSystem } from "./interactions";
import { HANDWRITING_FONT } from "./loreArt";
import { createLoreObject } from "./lorePage";
import type { LoopHandle, ObjectAudio } from "./objectAudio";
import { spawnProp } from "./propLoader";
import { applyVhsEffect, setDepthLook, setLightField } from "./vhsMaterial";

/** La salle de montage est construite loin de la grille des Backrooms (aucun chunk n'y est chargé). */
const ORIGIN = new THREE.Vector3(0, 0, 3000);
const HALF_WIDTH = 2.3;
const HALF_DEPTH = 1.9;
const WALL = 0.12;
/** Id de la bande posée sur le bureau (la première : la veille du rendu). */
export const INTRO_LORE_ID = "intro:lore";
const STEP_REMINDER_SECONDS = 9;
const ENDING_LINE_SECONDS = 4.2;

export type RoomVariant = "intro" | "aveu" | "boucle";

/** Signaux du tutoriel (verrouillés à vrai par `main.ts` quand le joueur a fait le geste). */
export interface TutorialSignals {
  grabbed(): boolean;
  stored(): boolean;
  loreRead(): boolean;
  journalOpened(): boolean;
  lampOn(): boolean;
  crouching(): boolean;
}

export interface EditingRoomDeps {
  scene: THREE.Scene;
  physics: PhysicsWorld;
  registry: GrabbableRegistry;
  interactions: InteractionSystem;
  audio: ObjectAudio;
  hud: CamcorderHud;
  signals: TutorialSignals;
  head(): THREE.Vector3;
  addCorruption(amount: number): void;
  take(): number;
  capturePhoto(): HTMLCanvasElement | null;
  /** Le joueur a traversé le mur : place aux Backrooms. */
  onEnterBackrooms(): void;
  /** Fin jouée jusqu'au bout : écran de fin. */
  onEndingFinished(variant: "aveu" | "boucle"): void;
}

interface Step {
  key: TranslationKey;
  done(): boolean;
  /** Au début de l'étape (le néon qui faiblit avant « allumez votre lampe »). */
  start?(): void;
}

/**
 * Salle de montage : l'intro et les deux fins du récit. Tard le soir, la veille du rendu ; un
 * bureau, un moniteur, un projecteur 8 mm, une affiche du film. L'intro apprend les gestes en
 * jouant (prendre, ranger, lire, journal, lampe, s'accroupir, allumer le moniteur), puis le mur
 * derrière le moniteur se met à grésiller : on le traverse (noclip) et on tombe dans le niveau 0.
 * Les fins y ramènent : l'aveu (bobine 4 en entier sur le moniteur) ou la boucle (le moniteur
 * montre le joueur, filmé de dos).
 */
export class EditingRoom {
  private readonly group = new THREE.Group();
  private readonly bodies: RAPIER.RigidBody[] = [];
  private readonly grabbables: Grabbable[] = [];
  private northCollider: RAPIER.RigidBody | null = null;
  private television: Grabbable | null = null;
  private portal: { mesh: THREE.Mesh; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture; hiss: LoopHandle | null } | null = null;
  private variant: RoomVariant | null = null;
  private steps: Step[] = [];
  private stepIndex = 0;
  private reminder = 0;
  private portalTime = 0;
  private ending: { lines: string[]; index: number; timer: number } | null = null;
  private dim = false;
  private buildToken = 0;

  constructor(private readonly deps: EditingRoomDeps) {
    this.group.name = "editing-room";
  }

  get active(): boolean {
    return this.variant !== null;
  }

  /** Où poser la tête du joueur : face au bureau et au mur du moniteur. */
  get spawn(): THREE.Vector3 {
    return new THREE.Vector3(ORIGIN.x, 0, ORIGIN.z + 0.9);
  }

  /**
   * Éclairage de la pièce (pleine lumière, ou néon mourant : il faut la lampe) et dalles
   * physiques sol/plafond sous la salle — à rappeler si le niveau 0 est reconstruit pendant
   * l'intro (il recentre la physique sur son spawn).
   */
  applyLook(): void {
    setLightField({ seedX: 0.37, seedY: 0.71, threshold: this.dim ? 10 : -10, exitCellX: 0, exitCellZ: 0 });
    setDepthLook(0);
    this.deps.physics.recenter(ORIGIN.x, ORIGIN.z);
  }

  async build(variant: RoomVariant): Promise<void> {
    this.dispose();
    const token = ++this.buildToken;
    this.variant = variant;
    this.dim = variant === "boucle";
    this.applyLook();
    this.deps.scene.add(this.group);
    this.buildShell();

    await Promise.all([this.buildDecor(token), this.buildGrabbables(token)]);
    if (token !== this.buildToken) return;

    if (variant === "intro") {
      this.startTutorial();
    } else {
      // Les fins : le moniteur est déjà allumé. L'aveu : la bobine 4 tourne ; la boucle : le
      // moniteur montre le joueur en direct, filmé de dos.
      if (this.television) {
        if (variant === "aveu") this.deps.interactions.command(this.television, "tape", this.deps.capturePhoto());
        else this.deps.interactions.command(this.television, "on");
      }
      const lines = tList(variant === "aveu" ? "ending.aveu" : "ending.boucle").map((line) => line.replace("{take}", String(this.deps.take())));
      this.ending = { lines, index: 0, timer: 1.5 };
    }
  }

  dispose(): void {
    this.buildToken++;
    this.variant = null;
    this.steps = [];
    this.ending = null;
    this.portal?.hiss?.stop();
    this.portal = null;
    for (const grabbable of this.grabbables) if (this.deps.registry.all.has(grabbable)) this.deps.registry.remove(grabbable);
    this.grabbables.length = 0;
    this.television = null;
    for (const body of this.bodies) this.deps.physics.world.removeRigidBody(body);
    this.bodies.length = 0;
    this.northCollider = null;
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh && !object.userData.shared) {
        object.geometry.dispose();
        const material = object.material as THREE.MeshStandardMaterial;
        material.map?.dispose();
        material.dispose();
      }
    });
    this.group.clear();
    this.group.removeFromParent();
  }

  update(deltaSeconds: number): void {
    if (!this.variant) return;
    if (this.variant === "intro") this.updateTutorial(deltaSeconds);
    else this.updateEnding(deltaSeconds);
  }

  // ------------------------------------------------------------ Tutoriel

  private startTutorial(): void {
    const s = this.deps.signals;
    this.steps = [
      { key: "intro.grab", done: s.grabbed },
      { key: "intro.store", done: s.stored },
      { key: "intro.read", done: s.loreRead },
      { key: "intro.journal", done: s.journalOpened },
      {
        key: "intro.lamp",
        done: s.lampOn,
        start: () => {
          this.dim = true;
          this.applyLook();
        },
      },
      { key: "intro.crouch", done: s.crouching },
      { key: "intro.monitor", done: () => !!this.television && this.deps.interactions.isActive(this.television) },
      { key: "intro.wall", done: () => false, start: () => this.openPortal() },
    ];
    this.stepIndex = 0;
    this.deps.hud.showNotice(t("intro.opening"), 5);
    this.reminder = 5.5;
  }

  private updateTutorial(deltaSeconds: number): void {
    let step = this.steps[this.stepIndex];
    // Plusieurs étapes déjà faites d'avance (joueur qui connaît les gestes) : on les enchaîne.
    while (step && step.done()) {
      this.stepIndex++;
      step = this.steps[this.stepIndex];
      if (step) {
        step.start?.();
        this.reminder = 0;
      }
    }
    if (step) {
      this.reminder -= deltaSeconds;
      if (this.reminder <= 0) {
        this.reminder = STEP_REMINDER_SECONDS;
        this.deps.hud.showNotice(t(step.key), STEP_REMINDER_SECONDS - 1.5);
      }
    }
    if (this.portal) this.updatePortal(deltaSeconds);
  }

  /** Le mur derrière le moniteur perd sa collision et se met à grésiller : on peut le traverser. */
  private openPortal(): void {
    if (this.northCollider) {
      this.deps.physics.world.removeRigidBody(this.northCollider);
      this.bodies.splice(this.bodies.indexOf(this.northCollider), 1);
      this.northCollider = null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 80;
    const ctx = canvas.getContext("2d")!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_WIDTH * 2 - 0.02, WALL_HEIGHT - 0.02),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    );
    mesh.position.set(ORIGIN.x, WALL_HEIGHT / 2, ORIGIN.z - HALF_DEPTH + WALL / 2 + 0.01);
    this.group.add(mesh);
    this.portal = { mesh, ctx, texture, hiss: this.deps.audio.loop("tvStatic", mesh, 0.35) };
  }

  private updatePortal(deltaSeconds: number): void {
    const portal = this.portal!;
    this.portalTime += deltaSeconds;
    const head = this.deps.head();
    const wallZ = ORIGIN.z - HALF_DEPTH;
    const distance = Math.max(0, head.z - wallZ);
    const closeness = THREE.MathUtils.clamp(1 - distance / 3, 0, 1);
    // Neige par bandes, plus dense quand on s'approche.
    const image = portal.ctx.createImageData(128, 80);
    for (let i = 0; i < image.data.length; i += 4) {
      const band = Math.sin((i / 4 / 128) * 0.4 + this.portalTime * 9) > 0.6 ? 1.4 : 1;
      const v = Math.random() * 200 * band;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    portal.ctx.putImageData(image, 0, 0);
    portal.texture.needsUpdate = true;
    const material = portal.mesh.material as THREE.MeshBasicMaterial;
    material.opacity = 0.18 + closeness * 0.55 + Math.sin(this.portalTime * 13) * 0.05;
    this.deps.addCorruption(deltaSeconds * closeness * 0.6);
    if (head.z < wallZ - 0.15) this.deps.onEnterBackrooms();
  }

  // ------------------------------------------------------------ Fins

  private updateEnding(deltaSeconds: number): void {
    const ending = this.ending;
    if (!ending) return;
    ending.timer -= deltaSeconds;
    if (ending.timer > 0) return;
    const line = ending.lines[ending.index];
    if (line === undefined) {
      const variant = this.variant as "aveu" | "boucle";
      this.ending = null;
      this.deps.onEndingFinished(variant);
      return;
    }
    this.deps.hud.showNotice(line, ENDING_LINE_SECONDS - 0.2, "#f4f1e8");
    ending.index++;
    ending.timer = ENDING_LINE_SECONDS;
  }

  // ------------------------------------------------------------ Construction

  /** Murs, sol, plafond, porte : une vraie pièce de bureau (pas du papier peint des Backrooms). */
  private buildShell(): void {
    const material = (color: number, roughness = 0.9): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ color, roughness, map: grainTexture() });
      applyVhsEffect(m);
      return m;
    };
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(ORIGIN.x + x, y, ORIGIN.z + z);
      this.group.add(mesh);
      return mesh;
    };
    const wall = material(0x6e6a5c);
    const W = HALF_WIDTH;
    const D = HALF_DEPTH;
    box(W * 2, 0.02, D * 2, 0, -0.01, 0, material(0x3b3f47));
    box(W * 2, 0.02, D * 2, 0, WALL_HEIGHT + 0.01, 0, material(0xcfc9bb, 0.95));
    box(W * 2 + WALL * 2, WALL_HEIGHT, WALL, 0, WALL_HEIGHT / 2, -D, wall);
    box(W * 2 + WALL * 2, WALL_HEIGHT, WALL, 0, WALL_HEIGHT / 2, D, wall);
    box(WALL, WALL_HEIGHT, D * 2, -W, WALL_HEIGHT / 2, 0, wall);
    box(WALL, WALL_HEIGHT, D * 2, W, WALL_HEIGHT / 2, 0, wall);
    // Plinthes sombres et porte fermée (mur sud, derrière le joueur).
    const skirting = material(0x2a2622);
    box(W * 2, 0.1, 0.02, 0, 0.05, -D + WALL / 2 + 0.01, skirting);
    box(W * 2, 0.1, 0.02, 0, 0.05, D - WALL / 2 - 0.01, skirting);
    box(0.9, 2.05, 0.05, -1.1, 1.025, D - WALL / 2 - 0.02, material(0x4a3b2c, 0.7));
    box(0.12, 0.03, 0.05, -0.75, 1.0, D - WALL / 2 - 0.06, material(0x9a9a92, 0.3));

    this.northCollider = this.staticBox(W * 2, WALL_HEIGHT, WALL, 0, WALL_HEIGHT / 2, -D);
    this.staticBox(W * 2, WALL_HEIGHT, WALL, 0, WALL_HEIGHT / 2, D);
    this.staticBox(WALL, WALL_HEIGHT, D * 2, -W, WALL_HEIGHT / 2, 0);
    this.staticBox(WALL, WALL_HEIGHT, D * 2, W, WALL_HEIGHT / 2, 0);
  }

  private staticBox(w: number, h: number, d: number, x: number, y: number, z: number, rotationY = 0): RAPIER.RigidBody {
    const body = this.deps.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(ORIGIN.x + x, y, ORIGIN.z + z)
        .setRotation(new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotationY)),
    );
    this.deps.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setCollisionGroups(CollisionGroups.static), body);
    this.bodies.push(body);
    return body;
  }

  /** Décor fixe (non saisissable) : modèle CC0 posé, avec une boîte de collision à sa taille. */
  private placeDecor(template: THREE.Object3D, x: number, y: number, z: number, rotationY: number, collide: boolean): THREE.Object3D {
    const model = template.clone(true);
    model.traverse((object) => (object.userData.shared = true));
    model.position.set(ORIGIN.x + x, y, ORIGIN.z + z);
    model.rotation.y = rotationY;
    this.group.add(model);
    if (collide) {
      const box = getModelShape(template).box;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3()).applyAxisAngle(THREE.Object3D.DEFAULT_UP, rotationY);
      this.staticBox(size.x, size.y, size.z, x + center.x, y + center.y, z + center.z, rotationY);
    }
    return model;
  }

  private async buildDecor(token: number): Promise<void> {
    const [desk, shelves, table, lamp, projector, light, frame] = await Promise.all([
      spawnProp("officeDesk").then((p) => p.template),
      spawnProp("metalShelves").then((p) => p.template),
      spawnProp("coffeeTable").then((p) => p.template),
      loadTemplateModel(deskLampUrl),
      loadTemplateModel(projector8mmUrl),
      loadTemplateModel(fluorescentLightUrl),
      loadTemplateModel(pictureFrameUrl),
    ]);
    if (token !== this.buildToken) return;
    const D = HALF_DEPTH;
    const W = HALF_WIDTH;
    this.placeDecor(desk, 0, 0, -D + 0.53, 0, true);
    this.placeDecor(lamp, -0.72, 0.79, -D + 0.35, Math.PI * 0.85, false);
    const shelf = this.placeDecor(shelves, W - 0.3, 0, 0.35, -Math.PI / 2, false);
    shelf.scale.setScalar(1.85 / 21.4);
    this.staticBox(0.44, 1.85, 0.95, W - 0.3, 0.925, 0.35);
    this.placeDecor(table, -W + 0.4, 0, 0.1, 0, true);
    this.placeDecor(projector, -W + 0.4, 0.392, 0.1, -Math.PI / 2, false);
    this.placeDecor(light, 0, WALL_HEIGHT, 0, 0, false);
    const poster = this.placeDecor(frame, -W + WALL / 2 + 0.01, 1.55, -0.9, Math.PI / 2, false);
    poster.add(posterMesh());
  }

  private async buildGrabbables(token: number): Promise<void> {
    const D = HALF_DEPTH;
    const W = HALF_WIDTH;
    const prop = async (kind: PropKind, x: number, z: number, rotationY: number, y = 0): Promise<Grabbable | null> => {
      const { model, template } = await spawnProp(kind);
      if (token !== this.buildToken) return null;
      const grabbable = this.deps.registry.createProp(kind, model, template, ORIGIN.x + x, ORIGIN.z + z, rotationY, y, false, true);
      this.grabbables.push(grabbable);
      return grabbable;
    };
    /** Objet de collection posé sur une surface de hauteur `surfaceY` (son point le plus bas dessus). */
    const collectible = async (kind: "clipboard" | "note" | "wallClock", x: number, surfaceY: number, z: number, rotationY: number): Promise<void> => {
      const { model, template } = await spawnCollectibleModel(kind);
      if (token !== this.buildToken) return;
      const entry: CollectionEntry = {
        id: `intro:${kind}`,
        kind,
        rarity: "common",
        scale: 1,
        depth: 0,
        nameFr: kind === "clipboard" ? "Feuille de service" : kind === "note" ? "Bloc-notes du monteur" : "Horloge de la salle de montage",
        nameEn: kind === "clipboard" ? "Call sheet" : kind === "note" ? "Editor's notepad" : "Editing room clock",
        descriptionFr: "Pris dans la salle de montage, la veille du rendu.",
        descriptionEn: "Taken from the editing room, the night before delivery.",
        collectedAt: 0,
      };
      const quaternion = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotationY);
      const y = surfaceY + 0.005 - getModelShape(template).box.min.y;
      this.grabbables.push(this.deps.registry.create({
        model,
        template,
        scale: 1,
        position: new THREE.Vector3(ORIGIN.x + x, y, ORIGIN.z + z),
        quaternion,
        mass: 0.4,
        item: entry,
        persistent: true,
      }));
    };
    const lore = async (): Promise<void> => {
      const object = await createLoreObject(0);
      if (token !== this.buildToken) {
        object.dispose();
        return;
      }
      this.grabbables.push(this.deps.registry.create({
        model: object.model,
        template: object.template,
        scale: 1,
        position: new THREE.Vector3(ORIGIN.x + 0.05, 0.79 + object.restHeight, ORIGIN.z - D + 0.62),
        quaternion: new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, 0.2),
        mass: object.mass,
        item: null,
        lorePage: { id: INTRO_LORE_ID, fragment: 0, onRead: object.onRead },
        onDispose: object.dispose,
        persistent: true,
      }));
    };
    const [television] = await Promise.all([
      prop("television", 0.45, -D + 0.4, -0.12, 0.79),
      prop("armChair", 0.05, -D + 1.3, Math.PI + 0.3),
      prop("cardboardBox", W - 0.35, -0.9, 0.2),
      prop("cardboardBox", W - 0.37, -0.88, -0.1, 0.345),
      prop("plasticCrate", -W + 0.45, 1.2, 0.5),
      collectible("clipboard", -0.3, 0.79, -D + 0.85, 0),
      collectible("note", 0.3, 0.79, -D + 0.98, 0),
      lore(),
    ]);
    this.television = television ?? null;
  }
}

let grain: THREE.CanvasTexture | null = null;
/** Grain léger (plâtre, moquette) pour que les surfaces ne soient pas des aplats. */
function grainTexture(): THREE.Texture {
  if (grain) return grain.clone();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(128, 128);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 215 + Math.random() * 40;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  grain = new THREE.CanvasTexture(canvas);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.repeat.set(4, 4);
  grain.colorSpace = THREE.SRGBColorSpace;
  return grain.clone();
}

/** Affiche du film « Couloirs », glissée dans le cadre (face avant du cadre : +Z). */
function posterMesh(): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 370;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 370);
  gradient.addColorStop(0, "#1a1410");
  gradient.addColorStop(1, "#3a2a14");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 370);
  // Un couloir en perspective, néons au plafond.
  ctx.strokeStyle = "rgba(230, 200, 110, 0.55)";
  ctx.lineWidth = 2;
  for (const [x, y] of [[0, 60], [256, 60], [0, 330], [256, 330]] as const) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(128, 190);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255, 236, 170, 0.8)";
  for (let i = 0; i < 5; i++) {
    const depth = 1 - i * 0.18;
    ctx.fillRect(128 - 40 * depth, 190 - 118 * depth, 80 * depth, 6 * depth);
  }
  const [title = "", subtitle = "", date = ""] = tList("intro.poster");
  ctx.fillStyle = "#e8c34a";
  ctx.font = "bold 42px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.fillText(title, 128, 290);
  ctx.fillStyle = "#d8cfb8";
  ctx.font = "15px 'Courier New', monospace";
  ctx.fillText(subtitle, 128, 318);
  ctx.font = `20px ${HANDWRITING_FONT}`;
  ctx.fillText(date, 128, 350);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 });
  applyVhsEffect(material);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.72), material);
  mesh.position.set(0, 0, 0.012);
  return mesh;
}
