import * as THREE from "three";
import { log } from "../debug/debugLog";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import type { LiveViews } from "../player/liveViews";
import type { Hand } from "../player/hand";
import { stringSeedToInt } from "../shared/rng";
import type { Grabbable, GrabbableRegistry } from "./grabbable";
import { findModelFace, type ModelFace } from "./modelFace";
import { emitNoise } from "./noise";
import type { MarkerSurfaces, Pen } from "./markerSurfaces";
import { MARKER_HALF_LENGTH, MARKER_INKS } from "./markerModel";
import type { LoopHandle, ObjectAudio } from "./objectAudio";

/** Ce que les objets manipulables savent du monde et du joueur (fourni par `main.ts`). */
export interface InteractionWorld {
  audio: ObjectAudio;
  physics: PhysicsWorld;
  registry: GrabbableRegistry;
  scene: THREE.Scene;
  camera: THREE.Camera;
  head(): THREE.Vector3;
  cadreurPosition(): THREE.Vector3 | null;
  cadreurObject(): THREE.Object3D | null;
  stunCadreur(seconds: number): void;
  exitPosition(): { x: number; z: number };
  capturePhoto(): HTMLCanvasElement | null;
  captureObject(object: THREE.Object3D, origin: THREE.Vector3, hidden: THREE.Object3D | undefined, width: number, height: number): HTMLCanvasElement | null;
  isRemoteTarget(grabbable: Grabbable): boolean;
  take(): number;
  runSeconds(): number;
  drop(grabbable: Grabbable): void;
  /** Vues en direct (télé, caméra de surveillance, jumelles, loupe, caméscope). */
  views: LiveViews;
  /** Œil du Cadreur (sa tête-caméra) et ce qu'il regarde, quand il est là. */
  cadreurEye(): { position: THREE.Vector3; target: THREE.Vector3 } | null;
  /** Dessin au marqueur sur sol, murs et plafond (voir `markerSurfaces.ts`). */
  surfaces: MarkerSurfaces;
  /** Objet réconfortant utilisé : fait baisser la folie (cooldown par objet côté appelant). Vrai si l'effet a eu lieu. */
  comfort(g: Grabbable, amount: number): boolean;
}

interface Behaviour {
  /** Gâchette pressée en tenant l'objet. */
  use?(hand: Hand): void;
  /** Choc (vitesse avant l'impact, m/s) : objet lancé, tombé. */
  impact?(speed: number): void;
  grab?(hand: Hand): void;
  /** Chaque frame ; `near` : le joueur est à moins de 12 m. */
  update?(deltaSeconds: number, near: boolean): void;
  /** Lubrifiant pulvérisé dessus (chariot qui ne grince plus). */
  oil?(): void;
  dispose?(): void;
}

type Factory = (g: Grabbable, w: InteractionWorld, system: InteractionSystem) => Behaviour;

const NEAR_DISTANCE = 12;
const IMPACT_MIN_SPEED = 1.2;

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpBox = new THREE.Box3();
/** Marge (m) au-delà du boîtier de la caméra de surveillance, pour ne jamais l'avoir dans le champ. */
const SECURITY_LENS_CLEARANCE = 0.04;

/** Tirage déterministe [0..1) propre à un objet (identifiant de collection, sinon position de départ). */
function objectRoll(g: Grabbable, salt: number): number {
  const key = g.item?.id ?? `${Math.round(g.object.position.x * 100)}:${Math.round(g.object.position.z * 100)}`;
  return ((stringSeedToInt(`${key}:${salt}`) >>> 0) % 100000) / 100000;
}

function noiseAt(g: Grabbable, loudness: number): void {
  emitNoise(g.object.position, loudness);
}

/**
 * Point le plus haut du modèle, en espace local (calculé une fois à l'apparition de l'objet) :
 * bonne approximation de la buse d'un aérosol ou de la molette d'un briquet, sans réglage
 * propre à chaque asset. `object.localToWorld(point.clone())` le replace ensuite en espace monde.
 */
function topLocalPoint(object: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(object);
  const topWorld = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
  return object.worldToLocal(topWorld);
}

interface MeshCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  activate(): void;
  deactivate(): void;
  commit(): void;
  dispose(): void;
}

/** Canvas appliqué à une sous-maille explicitement nommée du modèle, jamais à une face de repli. */
export function createMeshCanvas(mesh: THREE.Mesh, width: number, height: number, options: { glow?: boolean; transparent?: boolean; remapUv?: boolean; unlit?: boolean } = {}): MeshCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const originalMaterial = mesh.material;
  const originalGeometry = mesh.geometry;
  const base = !Array.isArray(originalMaterial) && originalMaterial instanceof THREE.MeshStandardMaterial ? originalMaterial : null;
  const material = options.unlit ? new THREE.MeshBasicMaterial({ toneMapped: false }) : base ? base.clone() : new THREE.MeshBasicMaterial({ toneMapped: false });
  material.map = texture;
  material.color.set(0xffffff);
  // Une surface peinte (écran de télé, artwork du cadre photo...) n'a de sens que de face : le
  // matériau d'origine (souvent recto-verso, cadre photo compris) laissait voir l'image "à
  // l'envers" en regardant par l'arrière de l'objet, à travers un dos pourtant opaque.
  material.side = THREE.FrontSide;
  if (options.transparent !== undefined) {
    material.transparent = options.transparent;
    if (!options.transparent) {
      material.depthWrite = true;
      material.opacity = 1;
    }
  }
  if (options.glow && material instanceof THREE.MeshStandardMaterial) {
    material.emissiveMap = texture;
    material.emissive.set(0xffffff);
    material.emissiveIntensity = 1;
  }
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  let remappedGeometry: THREE.BufferGeometry | null = null;

  return {
    canvas,
    ctx,
    texture,
    mesh,
    activate: () => {
      mesh.material = material;
      if (options.remapUv && !remappedGeometry) {
        remappedGeometry = originalGeometry.clone();
        mesh.geometry = remappedGeometry;
        remapPlateUV(mesh);
      }
    },
    deactivate: () => {
      mesh.material = originalMaterial;
      if (remappedGeometry) {
        remappedGeometry.dispose();
        remappedGeometry = null;
        mesh.geometry = originalGeometry;
      }
    },
    commit: () => {
      texture.needsUpdate = true;
    },
    dispose: () => {
      mesh.material = originalMaterial;
      if (remappedGeometry) mesh.geometry = originalGeometry;
      remappedGeometry?.dispose();
      texture.dispose();
      material.dispose();
    },
  };
}

const UP_AXES = [new THREE.Vector3(0, 1, 0)];

/** Sous-maille d'un modèle CC0 dont le nom (ou celui de son matériau) matche `pattern`. */
export function findMeshByName(root: THREE.Object3D, pattern: RegExp): THREE.Mesh | null {
  let result: THREE.Mesh | null = null;
  root.traverse((child) => {
    if (result || !(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const names = [child.name, ...materials.map((material) => material.name)].join(" ");
    if (pattern.test(names)) result = child;
  });
  return result;
}

export function findTelevisionScreen(root: THREE.Object3D): THREE.Mesh | null {
  return findMeshByName(root, /screen|display/i);
}

/** L'objet est-il dans le champ de vision du joueur ? */
function inView(w: InteractionWorld, position: THREE.Vector3, cos = 0.5): boolean {
  w.camera.getWorldDirection(tmp);
  tmp2.subVectors(position, w.head()).normalize();
  return tmp.dot(tmp2) > cos;
}

/** Place `camera` quelques pas derrière le joueur, dans son axe (ce que verrait celui qui le suit). */
const behindRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
function placeBehindPlayer(w: InteractionWorld, camera: THREE.PerspectiveCamera): void {
  const head = w.head();
  w.camera.getWorldDirection(tmp).setY(0);
  if (tmp.lengthSq() < 1e-6) tmp.set(0, 0, -1);
  tmp.normalize();
  behindRay.origin = { x: head.x, y: head.y, z: head.z };
  behindRay.dir = { x: -tmp.x, y: 0, z: -tmp.z };
  const hit = w.physics.world.castRay(behindRay, 2.6, true, undefined, CollisionGroups.querySight);
  const distance = Math.max(0.2, (hit ? hit.timeOfImpact : 2.6) - 0.35);
  camera.position.set(head.x - tmp.x * distance, head.y + 0.15, head.z - tmp.z * distance);
  camera.lookAt(head.x + tmp.x * 3, head.y - 0.2, head.z + tmp.z * 3);
}

// ---------------------------------------------------------------- Mobilier

/** Télévision : neige qui grésille, puis passe en direct après quelques secondes. */
const television: Factory = (g, w, system) => {
  const existingScreen = findTelevisionScreen(g.object);
  if (!existingScreen) return {};
  const screen = createMeshCanvas(existingScreen, 160, 120, { remapUv: true, unlit: true });
  system.displays.add(screen.mesh);
  let onSince = 0;
  let glitchUntil = 0;
  let wentLive = false;
  let on = false;
  let hum: LoopHandle | null = null;
  let frame = 0;
  let noiseTimer = 0;
  let scanTimer = 0;
  let mode: "static" | "live" = "static";
  let time = 0;
  const noise = screen ? screen.ctx.createImageData(160, 120) : null;

  const setOn = (value: boolean): void => {
    on = value;
    onSince = time;
    wentLive = false;
    if (on) screen.activate();
    else screen.deactivate();
    w.audio.playAt(on ? "tvOn" : "tvOff", g.object.position, 0.7, `${g.kind}:${on ? "on" : "off"}`);
    if (on) hum = w.audio.loop("tvStatic", g.object, 0.28);
    else {
      hum?.stop();
      hum = null;
    }
  };

  const drawStatic = (ctx: CanvasRenderingContext2D): void => {
    const data = noise!.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 230;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v * 1.05;
      data[i + 3] = 255;
    }
    ctx.putImageData(noise!, 0, 0);
    // Barre de défilement verticale (synchro qui décroche).
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    ctx.fillRect(0, (time * 40) % 140 - 20, 160, 14);
  };

  /**
   * Image en direct : la caméra de surveillance posée (si elle est là), sinon ce que voit le
   * Cadreur (il te filme), sinon ton couloir, filmé de dos par quelqu'un qui te suit.
   */
  const showLive = (material: THREE.MeshBasicMaterial): void => {
    const security = system.securityCamera;
    const eye = w.cadreurEye();
    const id = security ? "security" : eye ? "cadreur" : "behind";
    const viewDisplays = security ? [...system.displays, security.object] : [...system.displays];
    const cadreurObject = w.cadreurObject();
    if (cadreurObject) viewDisplays.push(cadreurObject);
    const view = w.views.use(id, 192, 144, 10, security ? 70 : 55, viewDisplays);
    if (security) system.aimSecurityView(view.camera);
    else if (eye) {
      view.camera.position.copy(eye.position);
      view.camera.lookAt(eye.target);
    } else placeBehindPlayer(w, view.camera);
    if (material.map !== view.texture) {
      material.map = view.texture;
      material.needsUpdate = true;
    }
  };

  return {
    use: () => setOn(!on),
    update: (dt, near) => {
      if (!on) return;
      time += dt;
      noiseTimer -= dt;
      if (noiseTimer <= 0) {
        noiseTimer = 3;
        noiseAt(g, mode === "static" ? 0.35 : 0.25);
      }
      scanTimer -= dt;
      if (scanTimer <= 0) {
        scanTimer = 0.4;
        // Après deux secondes de neige : l'image en direct, coupée de temps en temps par la neige.
        if (Math.random() < 0.06) glitchUntil = time + 0.35;
        const previousMode = mode;
        mode = time - onSince > 2 && time > glitchUntil ? "live" : "static";
        // Journal : un changement de mode réel, pas chaque coupure de neige du direct.
        if (mode !== previousMode && !wentLive) {
          log("interact", { action: "tv", mode, source: mode === "live" ? (system.securityCamera ? "security" : w.cadreurEye() ? "cadreur" : "behind") : undefined });
        }
        if (mode === "live") wentLive = true;
        hum?.setVolume(mode === "static" ? 0.28 : 0.1);
      }
      const material = screen.mesh.material as THREE.MeshBasicMaterial;
      if (mode === "live" && g.object.position.distanceTo(w.head()) < 10) {
        showLive(material);
        return;
      }
      if (material.map !== screen.texture) {
        material.map = screen.texture;
        material.needsUpdate = true;
      }
      if (!near) return;
      frame -= dt;
      if (frame > 0) return;
      frame = 1 / 15;
      drawStatic(screen.ctx);
      screen.commit();
    },
    dispose: () => {
      hum?.stop();
      system.displays.delete(screen.mesh);
      screen.dispose();
    },
  };
};

/** Écran de projection : quand on s'approche, le projecteur (invisible) démarre — amorce, compte à rebours. */

/** Chariot : ses roulettes grincent quand on le pousse (plus maintenant, s'il a été graissé). */
const storageCart: Factory = (g, w) => {
  let oiled = false;
  let squeak = 0;
  let noiseTimer = 0;
  return {
    oil: () => {
      oiled = true;
    },
    update: (dt) => {
      if (oiled || g.body.isSleeping()) return;
      const v = g.body.linvel();
      const speed = Math.hypot(v.x, v.z);
      squeak -= dt;
      noiseTimer -= dt;
      if (speed < 0.25 || squeak > 0) return;
      squeak = 0.35;
      w.audio.playAt("wheel", g.object.position, Math.min(0.9, speed), `${g.kind}:roll`);
      if (noiseTimer <= 0) {
        noiseTimer = 1.5;
        noiseAt(g, 0.3 * Math.min(1, speed));
      }
    },
  };
};

/** Étagère métallique : bousculée, elle tremble et tout ce qu'elle porte cliquette ; heurtée, elle sonne aussi le choc. */
const metalShelves: Factory = (g, w, system) => {
  let cooldown = 0;
  const shake: Behaviour = {
    update: (dt) => {
      cooldown -= dt;
      if (cooldown > 0 || g.body.isSleeping()) return;
      const v = g.body.linvel();
      const a = g.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) < 0.3 && Math.hypot(a.x, a.y, a.z) < 0.5) return;
      cooldown = 1.2;
      w.audio.playAt("rattle", g.object.position, 0.8, `${g.kind}:shake`);
      noiseAt(g, 0.4);
    },
  };
  return merge(shake, impactNoise("clank", 1.6, 0.4)(g, w, system));
};

/** Panneau « sol glissant » : se plie et se déplie (clac plastique) ; sonne aussi s'il est heurté. */
const wetFloorSign: Factory = (g, w, system) => {
  let folded = false;
  const toggle: Behaviour = {
    use: () => {
      folded = !folded;
      for (const child of g.object.children) child.scale.z = folded ? 0.2 : 1;
      w.audio.playAt("plasticClack", g.object.position, 0.5, `${g.kind}:fold`);
    },
  };
  return merge(toggle, impactNoise("thump", 1.1, 0.3)(g, w, system));
};

/** Fauteuil : quand personne ne le regarde, il pivote ; heurté, il fait un bruit sourd. */
const armChair: Factory = (g, w, system) => {
  let timer = 10 + objectRoll(g, 4) * 15;
  const pivot: Behaviour = {
    update: (dt, near) => {
      if (!near || g.heldBy) return;
      timer -= dt;
      if (timer > 0) return;
      timer = 10 + Math.random() * 15;
      const position = g.object.position;
      if (position.distanceTo(w.head()) > 7 || inView(w, position, 0.2)) return;
      const r = g.body.rotation();
      const turn = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.8));
      const rotated = new THREE.Quaternion(r.x, r.y, r.z, r.w).premultiply(turn);
      g.body.setRotation(rotated, true);
    },
  };
  return merge(pivot, impactNoise("thump", 1.5, 0.3)(g, w, system));
};

/** Tabouret métallique : on le fait tourner d'une pichenette ; heurté, il sonne aussi le choc. */
const metalStool: Factory = (g, w, system) => {
  const spin: Behaviour = {
    use: () => {
      g.body.applyTorqueImpulse({ x: 0, y: 1.2, z: 0 }, true);
      // "creak" (grincement métallique) plutôt que "squeak" (couic de jouet) : un tabouret qui
      // tourne ne devrait pas sonner comme un canard en caoutchouc.
      w.audio.playAt("creak", g.object.position, 0.5, `${g.kind}:spin`);
      noiseAt(g, 0.2);
    },
  };
  return merge(spin, impactNoise("clank", 1.4, 0.3)(g, w, system));
};

// ---------------------------------------------------------------- Objets de collection

/** Réveil : on le remonte (gâchette), il sonne cinq secondes plus tard, là où on l'a laissé : un leurre. */
const alarmClock: Factory = (g, w) => {
  let state: "idle" | "armed" | "ringing" = "idle";
  let timer = 0;
  let noiseTimer = 0;
  let loop: LoopHandle | null = null;
  const stop = (): void => {
    loop?.stop();
    loop = null;
    state = "idle";
  };
  return {
    use: () => {
      if (state !== "idle") {
        stop();
        w.audio.playAt("metalClick", g.object.position, 0.6, `${g.kind}:arm`);
        return;
      }
      state = "armed";
      timer = 5;
      w.audio.playAt("metalClick", g.object.position, 0.6, `${g.kind}:arm`);
      loop = w.audio.loop("tick", g.object, 0.5);
    },
    update: (dt) => {
      if (state === "idle") return;
      timer -= dt;
      if (state === "armed" && timer <= 0) {
        loop?.stop();
        loop = w.audio.loop("alarm", g.object, 0.9);
        state = "ringing";
        timer = 6;
        noiseTimer = 0;
      }
      if (state !== "ringing") return;
      noiseTimer -= dt;
      if (noiseTimer <= 0) {
        noiseTimer = 1.5;
        noiseAt(g, 1);
      }
      if (timer <= 0) stop();
    },
    dispose: stop,
  };
};

/** Objet qui fait du bruit quand il heurte quelque chose (lancé, tombé) : un leurre. */
function impactNoise(sound: "gong" | "clank" | "thump" | "bang", minSpeed: number, loudness: number, extra: Behaviour = {}): Factory {
  return (g, w) => ({
    ...extra,
    impact: (speed) => {
      if (speed < minSpeed) return;
      w.audio.playAt(sound, g.object.position, Math.min(1, 0.4 + speed * 0.12), `${g.kind}:impact`);
      noiseAt(g, loudness);
    },
  });
}

/** Objet fragile : se brise s'il heurte quelque chose trop fort (et disparaît). */
function breakable(minSpeed: number, loudness: number, sound: "shatter" | "potBreak" = "shatter"): Factory {
  return (g, w) => ({
    impact: (speed) => {
      if (speed < minSpeed) return;
      w.audio.playAt(sound, g.object.position, 0.9, `${g.kind}:impact`);
      noiseAt(g, loudness);
      // Jamais retiré du monde tant qu'il est en main : le choc "en main" (mur heurté en le
      // tenant) ne doit faire que du bruit, sinon GrabSystem continue de piloter un corps
      // physique déjà détruit la même frame — c'est ce qui gelait le jeu à la prise du vase.
      if (!g.heldBy) w.registry.remove(g);
    },
  });
}

/** Combine plusieurs comportements sur le même objet (ex. rester poussable ET faire du bruit au choc). */
function merge(...parts: Behaviour[]): Behaviour {
  return {
    use: parts.find((p) => p.use)?.use,
    impact: parts.find((p) => p.impact)?.impact,
    grab: parts.find((p) => p.grab)?.grab,
    oil: parts.find((p) => p.oil)?.oil,
    update: (dt, near) => {
      for (const part of parts) part.update?.(dt, near);
    },
    dispose: () => {
      for (const part of parts) part.dispose?.();
    },
  };
}

/** Petit geste sonore à la gâchette (ouvrir un étui, presser un jouet...). */
function useSound(sound: "metalClick" | "rustle" | "squeak" | "whistle", loudness: number, volume = 0.7, cooldown = 0.3, actionId = "use"): Factory {
  return (g, w) => {
    let last = -Infinity;
    return {
      use: () => {
        const now = performance.now() / 1000;
        if (now - last < cooldown) return;
        last = now;
        w.audio.playAt(sound, g.object.position, volume, `${g.kind}:${actionId}`);
        if (loudness > 0) noiseAt(g, loudness);
      },
    };
  };
}

/**
 * Objet réconfortant : l'usage (gâchette) et, s'il y a un choc (ballon qui rebondit), le choc
 * font redescendre la folie — une seule fois par cooldown et par objet (voir `main.ts`).
 */
function comforting(base: Factory, amount: number, extra?: (g: Grabbable, w: InteractionWorld) => Behaviour): Factory {
  return (g, w, system) => {
    const inner = base(g, w, system);
    const added = extra?.(g, w);
    const soothe = (): void => {
      if (w.comfort(g, amount)) log("interact", { action: "comfort", kind: g.kind });
    };
    return {
      ...inner,
      use: (hand) => {
        (added?.use ?? inner.use)?.(hand);
        soothe();
      },
      impact: (speed) => {
        inner.impact?.(speed);
        if (g.heldBy === null && speed > 2) soothe();
      },
    };
  };
}

/**
 * Marqueur : tenu comme un stylo (mine vers l'avant de la manette, voir `GrabSystem`), sa mine
 * écrit sur le sol, un mur ou le plafond quand elle est posée dessus (voir `MarkerSurfaces`) ; la
 * gâchette bascule entre écrire et gommer (une bague claire signale la gomme).
 */
const marker: Factory = (g, w) => {
  const tip = new THREE.Vector3();
  const axis = new THREE.Vector3();
  let inkIndex = 0;
  let pen: Pen | null = null;
  let hapticTimer = 0;
  // Bague de gomme : visible seulement dans ce mode, propre à cette instance.
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.006, 16), new THREE.MeshBasicMaterial({ color: 0xf2efe6, toneMapped: false }));
  ring.position.y = MARKER_HALF_LENGTH - 0.03;
  ring.visible = false;
  g.object.add(ring);
  return {
    use: (hand) => {
      inkIndex = (inkIndex + 1) % MARKER_INKS.length;
      const ink = MARKER_INKS[inkIndex]!;
      ring.visible = ink.color === null;
      pen = null;
      w.audio.playAt("metalClick", g.object.position, 0.4, `${g.kind}:ink`);
      hand.pulse(0.25, ink.color === null ? 90 : 40);
      log("interact", { action: "marker-mode", mode: ink.id });
    },
    update: (deltaSeconds) => {
      const hand = g.heldBy as Hand | null;
      if (!hand) {
        pen = null;
        return;
      }
      // Mine = bout +Y du modèle (la prise "stylo" la dirige vers l'avant de la manette).
      axis.set(0, 1, 0).applyQuaternion(g.object.quaternion);
      tip.copy(g.object.position).addScaledVector(axis, MARKER_HALF_LENGTH * g.object.scale.x);
      const contact = w.surfaces.probe(tip);
      if (!contact) {
        pen = null;
        return;
      }
      pen = w.surfaces.draw(contact, pen, MARKER_INKS[inkIndex]!.color);
      hapticTimer -= deltaSeconds;
      if (hapticTimer <= 0) {
        hapticTimer = 0.07;
        hand.pulse(0.07, 14);
      }
    },
    dispose: () => {
      ring.removeFromParent();
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    },
  };
};

/** Canette : s'écrase dans la main ; lancée, elle rebondit bruyamment (leurre). */
const can: Factory = (g, w, system) => {
  let crushed = false;
  const bounce = impactNoise("clank", 1.5, 0.6)(g, w, system);
  return {
    impact: bounce.impact,
    use: () => {
      if (crushed) return;
      crushed = true;
      for (const child of g.object.children) child.scale.y = 0.55;
      w.audio.playAt("crumple", g.object.position, 0.8, `${g.kind}:crush`);
      noiseAt(g, 0.2);
    },
  };
};

/** Intervalle (s) entre deux jets, gâchette maintenue enfoncée. */
const SPRAY_INTERVAL = 0.3;

/** Aérosol : pulvérise un petit nuage tant que la gâchette reste enfoncée ; le lubrifiant fait taire un chariot qui grince. */
function sprayCan(lubricant: boolean): Factory {
  return (g, w, system) => {
    // La buse, pas le centre du bidon : sinon le nuage part du mauvais endroit à l'usage.
    const nozzleLocal = topLocalPoint(g.object);
    let timer = 0;
    const spray = (hand: Hand): void => {
      const nozzleWorld = g.object.localToWorld(nozzleLocal.clone());
      w.audio.playAt("spray", nozzleWorld, 0.6, `${g.kind}:spray`);
      noiseAt(g, 0.15);
      system.puff(nozzleWorld, hand.aimDirection);
      if (!lubricant) return;
      for (const other of w.registry.all) {
        if (other.kind === "storageCart" && other.object.position.distanceTo(g.object.position) < 1.4) system.behaviourOf(other)?.oil?.();
      }
    };
    return {
      use: (hand) => {
        timer = SPRAY_INTERVAL;
        spray(hand);
      },
      update: (dt) => {
        const hand = g.heldBy as Hand | null;
        if (!hand || hand.input.trigger.value <= 0.5) return;
        timer -= dt;
        if (timer > 0) return;
        timer = SPRAY_INTERVAL;
        spray(hand);
      },
    };
  };
}

/**
 * Repère 2D du plan d'une sous-maille plate, à partir de sa normale moyenne (pas de ses axes
 * X/Y/Z locaux bruts) : reste correct même si la plaque est légèrement inclinée (un tableau
 * d'écolier posé sur un chevalet, par exemple), là où choisir "l'axe le plus fin de la bounding
 * box" comme épaisseur se trompe complètement dès que le panneau n'est pas aligné aux axes du
 * monde. Même convention up/right que `modelFace.ts` (`faceFor`).
 */
function platePlaneBasis(mesh: THREE.Mesh): { center: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
  const geometry = mesh.geometry;
  const normalAttr = geometry.attributes["normal"] as THREE.BufferAttribute | undefined;
  const normal = new THREE.Vector3();
  const n = new THREE.Vector3();
  if (normalAttr) {
    for (let i = 0; i < normalAttr.count; i++) normal.add(n.fromBufferAttribute(normalAttr, i));
  }
  if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1); // repli si pas de normales exploitables
  normal.normalize();
  const reference = Math.abs(normal.y) > 0.8 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const up = reference.clone().sub(normal.clone().multiplyScalar(reference.dot(normal))).normalize();
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();
  geometry.computeBoundingBox();
  const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
  return { center, right, up };
}

/** Étendue (u, v) de chaque sommet dans le repère du plan, plus min/max pour normaliser ensuite. */
function platePlaneExtent(mesh: THREE.Mesh, basis: { center: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 }) {
  const position = mesh.geometry.attributes["position"] as THREE.BufferAttribute;
  const us = new Float32Array(position.count);
  const vs = new Float32Array(position.count);
  const p = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    offset.subVectors(p, basis.center);
    const u = offset.dot(basis.right);
    const v = offset.dot(basis.up);
    us[i] = u;
    vs[i] = v;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { us, vs, minU, maxU, minV, maxV };
}

/** Ratio largeur/hauteur d'une sous-maille plate : évite de plaquer un canvas carré sur une
 * ouverture rectangulaire (l'image ressort étirée, cases pas carrées). */
export function meshPlateAspect(mesh: THREE.Mesh): number {
  const basis = platePlaneBasis(mesh);
  const { minU, maxU, minV, maxV } = platePlaneExtent(mesh, basis);
  return (maxU - minU) / (maxV - minV);
}

/**
 * Réécrit les UV d'une sous-maille plate pour qu'elles suivent exactement le canvas posé dessus
 * (u = largeur, v = hauteur), plutôt que de dépendre de l'unwrap d'origine du modèle — sur un
 * asset CC0, ce panneau peut être tassé dans un coin de l'atlas, tourné ou en miroir par rapport
 * aux autres pièces (vu sur le dos d'un cadre photo : texte tourné à 90° et inversé).
 */
export function remapPlateUV(mesh: THREE.Mesh): void {
  const basis = platePlaneBasis(mesh);
  const { us, vs, minU, maxU, minV, maxV } = platePlaneExtent(mesh, basis);
  const uSpan = maxU - minU || 1;
  const vSpan = maxV - minV || 1;
  const uv = new Float32Array(us.length * 2);
  for (let i = 0; i < us.length; i++) {
    uv[i * 2] = (us[i]! - minU) / uSpan;
    uv[i * 2 + 1] = (vs[i]! - minV) / vSpan;
  }
  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/**
 * Comme `remapPlateUV`, mais pour une sous-maille qui n'est pas qu'une simple plaque : un verre
 * de montre biseauté partage un seul unwrap entre sa face plate (dessus, normale vers
 * `direction`) et ses chants — la projeter en un seul plan (comme `remapPlateUV`) écrase la face
 * plate dans une bande dégénérée. On ne recadre donc que sur le sous-rectangle déjà occupé par
 * les sommets de la face voulue dans l'unwrap d'origine, sans toucher à sa forme (cartes normale/
 * rugosité restent donc valables, juste zoomées).
 */
export function remapPlateUVToFace(mesh: THREE.Mesh, direction: THREE.Vector3, threshold = 0.9, flip: { u?: boolean; v?: boolean } = {}): void {
  const normalAttr = mesh.geometry.attributes["normal"] as THREE.BufferAttribute | undefined;
  const uvAttr = mesh.geometry.attributes["uv"] as THREE.BufferAttribute | undefined;
  if (!normalAttr || !uvAttr) return;
  const n = new THREE.Vector3();
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (let i = 0; i < normalAttr.count; i++) {
    n.fromBufferAttribute(normalAttr, i);
    if (n.dot(direction) < threshold) continue;
    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!Number.isFinite(minU) || !Number.isFinite(minV)) return; // aucun sommet orienté vers `direction`
  const uSpan = maxU - minU || 1;
  const vSpan = maxV - minV || 1;
  for (let i = 0; i < uvAttr.count; i++) {
    let u = (uvAttr.getX(i) - minU) / uSpan;
    let v = (uvAttr.getY(i) - minV) / vSpan;
    if (flip.u) u = 1 - u;
    if (flip.v) v = 1 - v;
    uvAttr.setXY(i, u, v);
  }
  uvAttr.needsUpdate = true;
}

/** Dimensions d'un canvas ajustées à un ratio réel plutôt que de rester carrées par défaut. */
export function canvasSizeForAspect(aspect: number, maxDim = 192): [number, number] {
  return aspect >= 1 ? [maxDim, Math.round(maxDim / aspect)] : [Math.round(maxDim * aspect), maxDim];
}

/** Hauteur de référence (px) pour les textures générées sur les meshes nommés du cadre-photo. */
const PHOTO_TEXTURE_HEIGHT = 192;

/** Cadre-photo : seule la sous-maille `artwork` reçoit l'image trouvée. */
const photo: Factory = (g, w) => {
  const artwork = findMeshByName(g.object, /artwork/i);
  if (!artwork) return {};
  const [fw, fh] = canvasSizeForAspect(meshPlateAspect(artwork), PHOTO_TEXTURE_HEIGHT);
  const frontCanvas = createMeshCanvas(artwork, fw, fh, { remapUv: true });
  const target = [...w.registry.all]
    .filter((candidate) => candidate !== g && candidate.item !== null && candidate.heldBy === null)
    .sort((a, b) => a.object.position.distanceToSquared(g.object.position) - b.object.position.distanceToSquared(g.object.position))[0];
  const shot = target ? w.captureObject(target.object, g.object.position, g.object, fw, fh) : null;
  if (target?.item && shot) drawTargetPhoto(frontCanvas.ctx, shot, fw, fh);
  else drawFoundPhoto(frontCanvas.ctx, objectRoll(g, 7), fw, fh);
  frontCanvas.commit();
  frontCanvas.activate();
  const backMesh = findMeshByName(g.object, /back/i);
  const backWasVisible = backMesh?.visible;
  if (backMesh) backMesh.visible = false;

  return {
    dispose: () => {
      frontCanvas.dispose();
      if (backMesh && backWasVisible !== undefined) backMesh.visible = backWasVisible;
    },
  };
};

function drawTargetPhoto(ctx: CanvasRenderingContext2D, shot: HTMLCanvasElement, width: number, height: number): void {
  ctx.fillStyle = "#11151a";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(shot, 0, 0, width, height);
}

/** Composé sur un cadre virtuel 192×192, puis mis à l'échelle non uniforme vers `width`×`height`
 * (le ratio réel de la surface visée) — voir le commentaire équivalent dans `photo`. */
function drawFoundPhoto(ctx: CanvasRenderingContext2D, seed: number, width: number, height: number): void {
  ctx.save();
  ctx.scale(width / 192, height / 192);
  const sky = ctx.createLinearGradient(0, 0, 0, 192);
  sky.addColorStop(0, "#1b2630");
  sky.addColorStop(1, "#746d55");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  const horizon = height * 0.58;
  ctx.fillStyle = "#c5b65d";
  ctx.fillRect(0, horizon, width, height - horizon);
  ctx.strokeStyle = "rgba(40, 36, 24, 0.35)";
  ctx.lineWidth = 2;
  const vanishX = width / 2;
  for (let x = -width * 0.2; x < width * 1.2; x += width * 0.2) {
    ctx.beginPath();
    ctx.moveTo(vanishX, horizon - 2);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(8, 10, 12, 0.78)";
  const figureX = width * 0.32 + seed * width * 0.32;
  const figureY = horizon * 0.62;
  const headRadius = height * 0.068;
  ctx.beginPath();
  ctx.arc(figureX, figureY, headRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(figureX - headRadius, figureY + headRadius, headRadius * 2, height * 0.32);
  ctx.fillStyle = "rgba(255, 242, 183, 0.65)";
  ctx.fillRect(width * 0.71, height * 0.22, Math.max(2, width * 0.016), height * 0.28);
  const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.22, width / 2, height / 2, height * 0.69);
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.52)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, 192, 192);
  ctx.restore();
}

/**
 * Cadran dessiné à la demande (boussole, montre digitale), rafraîchi quand on est près.
 * `raise` recale le calque contre l'axe imprimé sur le modèle (positif : vers l'avant du cadran,
 * négatif : vers le joueur) quand la boîte englobante détectée ne tombe pas pile sur le dessin —
 * ignoré si `screenPattern` matche une vraie sous-maille (verre/cadran dédié du modèle : on pose
 * alors le dessin directement sur elle, comme l'écran de télé ou l'artwork du cadre photo,
 * plutôt que de coller un plan neuf par-dessus).
 */
function dial(size: number, rate: number, _raise: number, draw: (ctx: CanvasRenderingContext2D, g: Grabbable, w: InteractionWorld, face: ModelFace | null) => void, centerPattern?: RegExp, screenPattern?: RegExp): Factory {
  return (g, w) => {
    const screenMesh = screenPattern ? findMeshByName(g.object, screenPattern) : null;
    if (!screenMesh) return {};
    remapPlateUVToFace(screenMesh, UP_AXES[0]!, 0.9, { v: true });
    const face = null;
    const canvas = createMeshCanvas(screenMesh, size, size, { glow: true, transparent: false });
    // Sur les modèles avec un repère "centre du cadran" dédié (mini sous-maille sans surface
    // propre, juste un point) : la face auto-détectée peut tomber sur une autre partie plane du
    // modèle (un couvercle ouvert, par ex.) plutôt que le cadran — on recale sur ce repère.
    const centerMesh = centerPattern ? findMeshByName(g.object, centerPattern) : null;
    if (centerMesh) {
      centerMesh.geometry.computeBoundingBox();
      canvas.mesh.position.copy(centerMesh.geometry.boundingBox!.getCenter(new THREE.Vector3()));
    }
    let timer = 0;
    return {
      update: (dt, near) => {
        timer -= dt;
        if (timer > 0 || !near || g.object.position.distanceTo(w.head()) > 4) return;
        timer = rate;
        draw(canvas.ctx, g, w, face);
        canvas.commit();
        canvas.activate();
      },
      dispose: () => canvas.dispose(),
    };
  };
}

/** Boussole : son modèle fournit un repère central, mais pas de sous-maille de cadran dédiée. */
const compass: Factory = (g, w) => {
  const face = findModelFace(g.object, undefined, UP_AXES);
  if (!face) return {};
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(face.width * 0.7, face.height * 0.7), material);
  const right = new THREE.Vector3().crossVectors(face.up, face.normal).normalize();
  plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, face.up, face.normal));
  plane.position.copy(face.center);
  const centerMesh = findMeshByName(g.object, /dial_center/i);
  if (centerMesh) {
    centerMesh.geometry.computeBoundingBox();
    plane.position.copy(centerMesh.geometry.boundingBox!.getCenter(new THREE.Vector3()));
  }
  g.object.add(plane);
  let timer = 0;
  return {
    update: (dt, near) => {
      timer -= dt;
      if (timer > 0 || !near || g.object.position.distanceTo(w.head()) > 4) return;
      timer = 0.1;
      const exit = w.exitPosition();
      const worldDirection = tmp.set(exit.x - g.object.position.x, 0, exit.z - g.object.position.z).normalize();
      const local = worldDirection.applyQuaternion(g.object.quaternion.clone().invert());
      const angle = Math.atan2(local.dot(right), local.dot(face.up));
      ctx.clearRect(0, 0, 128, 128);
      ctx.save();
      ctx.translate(64, 64);
      ctx.rotate(angle + (Math.random() - 0.5) * 0.05);
      ctx.fillStyle = "rgba(200, 30, 30, 0.95)";
      ctx.beginPath();
      ctx.moveTo(0, -46);
      ctx.lineTo(7, 0);
      ctx.lineTo(-7, 0);
      ctx.fill();
      ctx.fillStyle = "rgba(230, 230, 220, 0.9)";
      ctx.beginPath();
      ctx.moveTo(0, 46);
      ctx.lineTo(7, 0);
      ctx.lineTo(-7, 0);
      ctx.fill();
      ctx.restore();
      texture.needsUpdate = true;
    },
    dispose: () => {
      plane.removeFromParent();
      plane.geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
};

const digitalWatch = dial(128, 1, 0.08, (ctx, _g, w) => {
  const total = Math.floor(w.runSeconds());
  ctx.fillStyle = "#9fb08a";
  ctx.fillRect(0, 28, 128, 72);
  ctx.fillStyle = "#1f2a18";
  ctx.font = "bold 30px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`, 64, 64);
}, undefined, /glass/i);

/** Manette : vibre dans la vraie manette du joueur. */
const gamepad: Factory = (g, w) => ({
  use: (hand) => {
    hand.pulse(1, 450);
    w.audio.playAt("metalClick", g.object.position, 0.25, `${g.kind}:vibrate`);
  },
});

/** Ampoule : s'allume près des néons du plafond (et bourdonne) ; se brise si on la lance. */
const lightbulb: Factory = (g, w, system) => {
  const glowTexture = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255, 244, 200, 1)");
    gradient.addColorStop(1, "rgba(255, 220, 150, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  })();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(0.25);
  glow.visible = false;
  g.object.add(glow);
  let buzz: LoopHandle | null = null;
  const shatter = breakable(3, 0.7)(g, w, system);
  return {
    impact: shatter.impact,
    update: () => {
      const lit = g.object.position.y > 2.05;
      if (lit === glow.visible) return;
      glow.visible = lit;
      if (lit) buzz = w.audio.loop("buzz", g.object, 0.4);
      else {
        buzz?.stop();
        buzz = null;
      }
    },
    dispose: () => {
      buzz?.stop();
      glowTexture.dispose();
      (glow.material as THREE.Material).dispose();
    },
  };
};

/** Multimètre : bippe de plus en plus vite près de la sortie — ou du Cadreur. */
const multimeter: Factory = (g, w) => {
  let timer = 0;
  return {
    update: (dt) => {
      if (!g.heldBy) return;
      timer -= dt;
      if (timer > 0) return;
      const position = g.object.position;
      const exit = w.exitPosition();
      let distance = Math.hypot(exit.x - position.x, exit.z - position.z);
      const cadreur = w.cadreurPosition();
      if (cadreur) distance = Math.min(distance, Math.hypot(cadreur.x - position.x, cadreur.z - position.z));
      timer = THREE.MathUtils.clamp(distance / 25, 0.1, 1.4);
      w.audio.playAt("beep", position, 0.3);
    },
  };
};

/** Ventouse : gâchette contre un mur, elle s'y colle ; on la reprend pour la décoller. */
/** Gâchette pointée vers un mur proche : l'objet s'y colle (fixe) ; le reprendre en main l'en détache. */
function wallMountable(sound: "suction" | "metalClick", volume = 0.7): Factory {
  return (g, w) => {
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    let stuck = false;
    return {
      use: (hand) => {
        if (stuck) return;
        const origin = g.object.position;
        ray.origin = { x: origin.x, y: origin.y, z: origin.z };
        ray.dir = { x: hand.aimDirection.x, y: hand.aimDirection.y, z: hand.aimDirection.z };
        const hit = w.physics.world.castRay(ray, 0.35, true, undefined, CollisionGroups.queryWalls);
        if (!hit) return;
        w.drop(g);
        stuck = true;
        g.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
        w.audio.playAt(sound, origin, volume, `${g.kind}:mount`);
      },
      grab: () => {
        if (!stuck) return;
        stuck = false;
        g.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        w.audio.playAt(sound, g.object.position, volume * 0.75, `${g.kind}:unmount`);
      },
    };
  };
}

const plunger: Factory = (g, w) => {
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  let stuck = false;
  return {
    use: (hand) => {
      const origin = g.object.position;
      ray.origin = { x: origin.x, y: origin.y, z: origin.z };
      ray.dir = { x: hand.aimDirection.x, y: hand.aimDirection.y, z: hand.aimDirection.z };
      const hit = w.physics.world.castRay(ray, 0.35, true, undefined, CollisionGroups.queryWalls);
      if (!hit) return;
      w.drop(g);
      stuck = true;
      g.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      w.audio.playAt("suction", origin, 0.8, `${g.kind}:stick`);
    },
    grab: () => {
      if (!stuck) return;
      stuck = false;
      g.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      w.audio.playAt("suction", g.object.position, 0.6, `${g.kind}:unstick`);
    },
  };
};

/** Instrument de bord : les aiguilles s'affolent près du Cadreur (grésillements, tremblement). */
/** Montre à gousset : ouverte, elle fait tic-tac. */
const pocketWatch: Factory = (g, w) => {
  let open = false;
  let loop: LoopHandle | null = null;
  return {
    use: () => {
      open = !open;
      w.audio.playAt("metalClick", g.object.position, 0.5, `${g.kind}:open`);
      if (open) loop = w.audio.loop("tick", g.object, 0.35);
      else {
        loop?.stop();
        loop = null;
      }
    },
    dispose: () => loop?.stop(),
  };
};

/** Horloge murale : tic-tac… qui s'arrête quand le Cadreur approche. Gâchette contre un mur : se fixe dessus. */
const wallClock: Factory = (g, w, system) => {
  let loop: LoopHandle | null = null;
  const ticking: Behaviour = {
    update: (_dt, near) => {
      const cadreur = w.cadreurPosition();
      const silenced = !!cadreur && Math.hypot(cadreur.x - g.object.position.x, cadreur.z - g.object.position.z) < 10;
      const shouldTick = near && g.object.position.distanceTo(w.head()) < 7 && !silenced;
      if (shouldTick && !loop) loop = w.audio.loop("tick", g.object, 0.45);
      else if (!shouldTick && loop) {
        loop.stop();
        loop = null;
      }
    },
    dispose: () => loop?.stop(),
  };
  return merge(ticking, wallMountable("metalClick", 0.55)(g, w, system));
};

/** Lueur additive d'une flamme (même esprit que le halo de l'ampoule, pas de lumière dynamique). */
function flameTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(16, 20, 1, 16, 16, 16);
  gradient.addColorStop(0, "rgba(255, 245, 200, 1)");
  gradient.addColorStop(0.4, "rgba(255, 170, 60, 0.9)");
  gradient.addColorStop(1, "rgba(255, 90, 20, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Briquet : gâchette pour allumer/éteindre une petite flamme (son "flick" : molette puis prise).
 * Sa position (approchée par le point le plus haut du modèle, dans son repère local) suit la
 * buse sans avoir besoin d'un réglage propre à chaque objet.
 */
const lighter: Factory = (g, w) => {
  const nozzleLocal = topLocalPoint(g.object);
  const texture = flameTexture();
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  flame.scale.setScalar(0.045);
  flame.position.copy(nozzleLocal).addScaledVector(new THREE.Vector3(0, 1, 0), 0.012 / Math.max(0.01, g.object.scale.y));
  flame.visible = false;
  g.object.add(flame);
  let on = false;
  return {
    use: () => {
      on = !on;
      w.audio.playAt("flick", g.object.position, 0.5);
      flame.visible = on;
    },
    update: (_dt) => {
      if (!on) return;
      const jitter = 1 + Math.sin(performance.now() * 0.03) * 0.08 + (Math.random() - 0.5) * 0.1;
      flame.scale.set(0.045 * jitter, 0.06 * (1 + (Math.random() - 0.5) * 0.15), 1);
    },
    dispose: () => {
      flame.removeFromParent();
      texture.dispose();
      (flame.material as THREE.Material).dispose();
    },
  };
};

/**
 * Caméra de surveillance : on la pointe où l'on veut surveiller, on la pose (on la lâche) ; son
 * image passe alors sur les télés allumées.
 */
/** Portée (m) de la recherche d'un mur proche, à la pose de la caméra de surveillance. */
const SECURITY_MOUNT_RANGE = 0.6;

const securityCamera: Factory = (g, w, system) => {
  const direction = new THREE.Vector3(0, 0, -1);
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  let wasHeld = false;
  return {
    update: () => {
      const hand = g.heldBy as Hand | null;
      if (hand) {
        direction.copy(hand.aimDirection);
        wasHeld = true;
        return;
      }
      if (!wasHeld) return;
      wasHeld = false;
      // Un mur dans l'axe visé, à portée : la caméra s'y fixe plutôt que de tomber au sol.
      const origin = g.object.position;
      ray.origin = { x: origin.x, y: origin.y, z: origin.z };
      ray.dir = { x: direction.x, y: direction.y, z: direction.z };
      const hit = w.physics.world.castRay(ray, SECURITY_MOUNT_RANGE, true, undefined, CollisionGroups.queryWalls);
      if (hit) {
        g.object.position.addScaledVector(direction, hit.timeOfImpact - 0.02);
        g.body.setTranslation(g.object.position, true);
        g.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      }
      system.placeSecurityCamera(g, direction);
      log("interact", { action: "security-placed", mounted: !!hit });
      w.audio.playAt("beep", g.object.position, 0.4);
    },
    grab: () => {
      // Reprise en main : décollée si elle était fixée à un mur.
      if (g.body.isFixed()) g.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    },
    dispose: () => system.removeSecurityCamera(g),
  };
};

// Jumelles et loupe : effet de vue rapprochée retiré (cassé — plus de comportement propre pour
// l'instant, voir le journal des objets). Les deux restent des objets de collection normaux.

const BEHAVIOURS: Record<string, Factory> = {
  securityCamera,
  television,
  storageCart,
  metalShelves,
  wetFloorSign,
  armChair,
  metalStool,
  alarmClock,
  chair: impactNoise("thump", 1.2, 0.25),
  monoblocChair: impactNoise("thump", 1.2, 0.25),
  schoolDesk: impactNoise("thump", 1.6, 0.3),
  officeDesk: impactNoise("thump", 1.8, 0.35),
  cabinet: impactNoise("clank", 1.8, 0.35),
  sofa: impactNoise("thump", 2, 0.4),
  coffeeTable: impactNoise("thump", 1.4, 0.3),
  bookshelf: impactNoise("thump", 2, 0.4),
  cardboardBox: impactNoise("thump", 0.8, 0.2),
  plasticCrate: impactNoise("thump", 0.8, 0.2),
  pottedPlant: impactNoise("thump", 0.6, 0.15),
  brassPot: (g, w, s) => ({
    ...impactNoise("gong", 2, 0.8)(g, w, s),
    use: () => {
      w.audio.playAt("gong", g.object.position, 0.9, `${g.kind}:use`);
      noiseAt(g, 0.8);
    },
  }),
  can,
  marker,
  // Seuil abaissé (1.5 -> 0.9) : un rebond de ballon typique n'atteignait pas la vitesse minimale, restait muet.
  hammer: impactNoise("bang", 3, 0.9),
  vase: breakable(2.5, 0.8, "potBreak"),
  lightbulb,
  // Canard en caoutchouc et ballon : réconfortants, ils apaisent la folie (cooldown par objet, voir `main.ts`).
  toy: comforting(useSound("squeak", 0.5, 0.7, 0.3, "squeeze"), 14),
  football: comforting(impactNoise("thump", 1, 0.35), 10, (g, w) => ({
    use: () => {
      w.audio.playAt("thump", g.object.position, 0.5, `${g.kind}:bounce`);
      noiseAt(g, 0.25);
    },
  })),
  // Choc : mêmes sons que le pot en laiton (gong), la bouilloire est aussi un objet métallique creux.
  kettle: (g, w, s) => merge(useSound("whistle", 0.8, 0.8, 3.2)(g, w, s), impactNoise("gong", 2, 0.7)(g, w, s)),
  cigaretteCase: useSound("metalClick", 0.1, 0.7, 0.3, "open"),
  cigarettePack: useSound("rustle", 0, 0.7, 0.3, "open"),
  cleanerTin: useSound("metalClick", 0, 0.7, 0.3, "open"),
  pliers: useSound("metalClick", 0),
  cleaner: sprayCan(false),
  lubricant: sprayCan(true),
  photo,
  compass,
  digitalWatch,
  gamepad,
  lighter,
  multimeter,
  plunger,
  watch: pocketWatch,
  wallClock,
  // Petits outils sans comportement propre : au moins un bruit de choc plausible au lancer.
  wrench: impactNoise("clank", 1.3, 0.35),
  combWrench: impactNoise("clank", 1.3, 0.35),
  screwdriver: impactNoise("clank", 1.2, 0.3),
  screwdriverFlat: impactNoise("clank", 1.2, 0.3),
  dustpan: impactNoise("thump", 1.3, 0.3),
  drainCleaner: impactNoise("thump", 1.4, 0.35),
  bleach: impactNoise("thump", 1.4, 0.35),
  woodenSpoon: impactNoise("thump", 1.2, 0.25),
  // Choc dédié (metal_07, distinct des autres outils métalliques) : voir l'artefact "Atelier des objets".
  toolbox: impactNoise("clank", 1.3, 0.3),
};

/**
 * Faces (écran, tableau, cadran) que cherchent les comportements ci-dessus, calculées d'avance
 * au pré-chauffage (voir warmup.ts) : la recherche parcourt tous les triangles du modèle —
 * jusqu'à ~10 ms au premier spawn d'une loupe (banc de test). Mêmes appels que les
 * comportements, donc mêmes entrées du cache de `findModelFace`.
 */
export function prepareInteractionFaces(kind: string, template: THREE.Object3D): void {
  void kind;
  void template;
}

/**
 * Objets qui s'animent (phase 3 de la feuille de route) : chaque meuble ou objet de collection
 * concerné reçoit un comportement à son apparition. On s'en sert :
 * - à la gâchette en le tenant (allumer, remonter, pulvériser, écraser) ;
 * - du doigt tendu posé dessus (meubles : tiroirs, télé, tabouret) ;
 * - en le lançant (chocs : leurres sonores, verre qui se brise) ;
 * - ou il vit seul (horloge, tableau noir, fauteuil qui pivote).
 * Tout bruit est entendu par le Cadreur (voir `noise.ts`).
 */
export class InteractionSystem {
  private readonly behaviours = new Map<Grabbable, Behaviour>();
  private readonly speeds = new Map<Grabbable, number>();
  private readonly puffs: Array<{ points: THREE.Points; age: number; velocity: THREE.Vector3 }> = [];
  private time = 0;
  /** Surfaces qui affichent une vue en direct : masquées pendant le rendu des vues. */
  readonly displays = new Set<THREE.Object3D>();
  /** Dernière caméra de surveillance posée (son image passe sur les télés), et son axe. */
  securityCamera: Grabbable | null = null;
  private readonly securityDirection = new THREE.Vector3(0, 0, -1);

  placeSecurityCamera(g: Grabbable, direction: THREE.Vector3): void {
    this.securityCamera = g;
    this.securityDirection.copy(direction);
    this.world.views.hideFromOffscreen(g.object);
  }

  removeSecurityCamera(g: Grabbable): void {
    if (this.securityCamera !== g) return;
    this.securityCamera = null;
    this.world.views.showInOffscreen(g.object);
    this.world.views.release("security");
  }

  /**
   * Oriente la caméra d'une vue comme la caméra de surveillance posée : positionnée devant son
   * boîtier (pas en son centre), sans quoi son propre modèle apparaît dans l'image qu'elle filme.
   */
  aimSecurityView(camera: THREE.PerspectiveCamera): void {
    const g = this.securityCamera;
    if (!g) return;
    const box = tmpBox.setFromObject(g.object);
    camera.position.set(
      this.securityDirection.x >= 0 ? box.max.x : box.min.x,
      this.securityDirection.y >= 0 ? box.max.y : box.min.y,
      this.securityDirection.z >= 0 ? box.max.z : box.min.z,
    );
    camera.position.addScaledVector(this.securityDirection, SECURITY_LENS_CLEARANCE);
    camera.lookAt(tmp.copy(camera.position).add(this.securityDirection));
  }

  constructor(private readonly world: InteractionWorld) {
    world.registry.onCreate.add((g) => this.attach(g));
    world.registry.onRemove.add((g) => this.detach(g));
    // Objets déjà là (le premier level est construit avant le système d'interactions).
    for (const g of world.registry.all) this.attach(g);
  }

  behaviourOf(g: Grabbable): Behaviour | undefined {
    return this.behaviours.get(g);
  }

  private attach(g: Grabbable): void {
    const factory = g.kind ? BEHAVIOURS[g.kind] : undefined;
    if (!factory) return;
    this.behaviours.set(g, factory(g, this.world, this));
  }

  private detach(g: Grabbable): void {
    this.behaviours.get(g)?.dispose?.();
    this.behaviours.delete(g);
    this.speeds.delete(g);
  }

  use(hand: Hand, g: Grabbable): void {
    const behaviour = this.behaviours.get(g);
    if (!behaviour?.use) return;
    log("interact", { action: "use", kind: g.kind });
    behaviour.use(hand);
  }

  grabbed(hand: Hand, g: Grabbable): void {
    this.behaviours.get(g)?.grab?.(hand);
  }

  /** Petit nuage d'aérosol qui se disperse devant l'objet. */
  puff(origin: THREE.Vector3, direction: THREE.Vector3): void {
    const count = 24;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = origin.x + (Math.random() - 0.5) * 0.04;
      positions[i * 3 + 1] = origin.y + (Math.random() - 0.5) * 0.04;
      positions[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.04;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xe8ecf0, size: 0.03, transparent: true, opacity: 0.5, depthWrite: false }));
    this.world.scene.add(points);
    this.puffs.push({ points, age: 0, velocity: direction.clone().multiplyScalar(0.8) });
  }

  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    const head = this.world.head();
    for (const [g, behaviour] of this.behaviours) {
      const near = g.object.position.distanceTo(head) < NEAR_DISTANCE;
      behaviour.update?.(deltaSeconds, near);
      // Choc détecté aussi en main (heurter un mur en le tenant) : même heuristique que lancé/tombé.
      if (behaviour.impact && this.behaviours.has(g)) this.detectImpact(g, behaviour);
    }
    this.updatePuffs(deltaSeconds);
  }

  /** Choc : la vitesse chute brutalement d'une frame à l'autre (objet lancé contre un mur, au sol). */
  private detectImpact(g: Grabbable, behaviour: Behaviour): void {
    if (this.world.isRemoteTarget(g)) {
      this.speeds.delete(g);
      return;
    }
    if (g.body.isSleeping()) {
      this.speeds.set(g, 0);
      return;
    }
    const v = g.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const previous = this.speeds.get(g) ?? 0;
    this.speeds.set(g, speed);
    if (previous > IMPACT_MIN_SPEED && speed < previous * 0.45) {
      log("interact", { action: "impact", kind: g.kind, speed: Math.round(previous * 10) / 10 });
      behaviour.impact!(previous);
    }
  }

  private updatePuffs(deltaSeconds: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const puff = this.puffs[i]!;
      puff.age += deltaSeconds;
      const positions = puff.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let p = 0; p < positions.count; p++) {
        positions.setXYZ(
          p,
          positions.getX(p) + (puff.velocity.x + (Math.random() - 0.5) * 0.4) * deltaSeconds,
          positions.getY(p) + (puff.velocity.y + (Math.random() - 0.5) * 0.4 + 0.05) * deltaSeconds,
          positions.getZ(p) + (puff.velocity.z + (Math.random() - 0.5) * 0.4) * deltaSeconds,
        );
      }
      positions.needsUpdate = true;
      const material = puff.points.material as THREE.PointsMaterial;
      material.opacity = 0.5 * (1 - puff.age);
      material.size = 0.03 + puff.age * 0.08;
      if (puff.age >= 1) {
        puff.points.removeFromParent();
        puff.points.geometry.dispose();
        material.dispose();
        this.puffs.splice(i, 1);
      }
    }
  }
}
