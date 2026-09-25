import * as THREE from "three";
import { log } from "../debug/debugLog";
import { tList } from "../i18n";
import { CollisionGroups, RAPIER, type PhysicsWorld } from "../physics/physicsWorld";
import type { LiveViews } from "../player/liveViews";
import type { Hand } from "../player/hand";
import { stringSeedToInt } from "../shared/rng";
import type { Grabbable, GrabbableRegistry } from "./grabbable";
import { HANDWRITING_FONT, wrapLines } from "./loreArt";
import { createFacePlane, findModelFace, type ModelFace } from "./modelFace";
import { emitNoise } from "./noise";
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
  stunCadreur(seconds: number): void;
  exitPosition(): { x: number; z: number };
  capturePhoto(): HTMLCanvasElement | null;
  take(): number;
  runSeconds(): number;
  drop(grabbable: Grabbable): void;
  /** Vues en direct (télé, caméra de surveillance, jumelles, loupe, caméscope). */
  views: LiveViews;
  /** Œil du Cadreur (sa tête-caméra) et ce qu'il regarde, quand il est là. */
  cadreurEye(): { position: THREE.Vector3; target: THREE.Vector3 } | null;
}

interface Behaviour {
  /** Gâchette pressée en tenant l'objet. */
  use?(hand: Hand): void;
  /** Doigt tendu posé sur l'objet (meubles, objet posé). */
  poke?(hand: Hand): void;
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
/** Doigt à moins de 2,5 cm de la surface = appui. */
const POKE_DISTANCE = 0.025;
const POKE_COOLDOWN = 0.7;
const IMPACT_MIN_SPEED = 1.2;

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

/** Tirage déterministe [0..1) propre à un objet (identifiant de collection, sinon position de départ). */
function objectRoll(g: Grabbable, salt: number): number {
  const key = g.item?.id ?? `${Math.round(g.object.position.x * 100)}:${Math.round(g.object.position.z * 100)}`;
  return ((stringSeedToInt(`${key}:${salt}`) >>> 0) % 100000) / 100000;
}

function noiseAt(g: Grabbable, loudness: number): void {
  emitNoise(g.object.position, loudness);
}

/** Écran / surface dessinée sur un canvas, posé sur une face du modèle (lumineux ou non). */
class FaceCanvas {
  readonly canvas = document.createElement("canvas");
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;

  constructor(owner: THREE.Object3D, face: ModelFace, width: number, height: number, options: { shrink?: number; glow?: boolean; transparent?: boolean; raise?: number } = {}) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = options.glow
      ? new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, transparent: options.transparent ?? false })
      : new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.9, transparent: options.transparent ?? false, emissiveMap: this.texture, emissive: 0xffffff, emissiveIntensity: 0.12 });
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    this.mesh = createFacePlane(face, material, options.shrink ?? 1, width / height);
    // Décalage vers le haut de la face (écran d'une télé au-dessus de ses boutons).
    if (options.raise) this.mesh.position.addScaledVector(face.up, face.height * options.raise);
    owner.add(this.mesh);
  }

  set visible(value: boolean) {
    this.mesh.visible = value;
  }

  commit(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.texture.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.geometry.dispose();
  }
}

/** Face d'un objet : axe imposé ou, à défaut, la plus grande face plane. */
function faceOf(g: Grabbable, axes?: THREE.Vector3[]): ModelFace | null {
  return axes ? findModelFace(g.object, undefined, axes) : findModelFace(g.object);
}
const FRONT_AXES = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
const UP_AXES = [new THREE.Vector3(0, 1, 0)];

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

/** Masque d'opacité : un disque (loupe) ou deux disques accolés (jumelles). */
function circleMask(double: boolean): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = double ? 256 : 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, 128);
  const disc = (x: number): void => {
    const gradient = ctx.createRadialGradient(x, 64, 48, x, 64, 64);
    gradient.addColorStop(0, "#fff");
    gradient.addColorStop(1, "#000");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, 64, 64, 0, Math.PI * 2);
    ctx.fill();
  };
  if (double) {
    disc(78);
    disc(178);
  } else disc(64);
  return new THREE.CanvasTexture(canvas);
}

/** Calque fixé devant les yeux (jumelles, viseur) : affiché seulement quand l'objet est porté au visage. */
function eyeOverlay(w: InteractionWorld, width: number, height: number, material: THREE.MeshBasicMaterial): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.position.set(0, 0, -0.2);
  mesh.renderOrder = 995;
  mesh.frustumCulled = false;
  mesh.visible = false;
  w.camera.add(mesh);
  return mesh;
}

/** L'objet tenu est-il porté au visage ? */
function atEye(g: Grabbable, w: InteractionWorld, distance: number): boolean {
  return !!g.heldBy && g.object.position.distanceTo(w.head()) < distance;
}

// ---------------------------------------------------------------- Mobilier

/** Télévision : neige qui grésille, puis passe en direct après quelques secondes. */
const television: Factory = (g, w, system) => {
  const face = faceOf(g, FRONT_AXES);
  // Pas de décalage artificiel ("raise") : l'écran se pose exactement sur la face détectée du
  // boîtier, pour ne pas paraître flotter au-dessus du modèle 3D.
  const screen = face ? new FaceCanvas(g.object, face, 160, 120, { shrink: 0.68, glow: true }) : null;
  if (screen) {
    screen.visible = false;
    system.displays.add(screen.mesh);
  }
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
    if (screen) screen.visible = on;
    w.audio.playAt(on ? "tvOn" : "tvOff", g.object.position, 0.7);
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
    const view = w.views.use(id, 192, 144, 10, security ? 70 : 55, [...system.displays]);
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
    poke: () => setOn(!on),
    update: (dt, near) => {
      if (!on || !screen) return;
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
      if (screen) {
        system.displays.delete(screen.mesh);
        (screen.mesh.material as THREE.MeshBasicMaterial).map = screen.texture;
        screen.dispose();
      }
    },
  };
};

/** Écran de projection : quand on s'approche, le projecteur (invisible) démarre — amorce, compte à rebours. */
/** Tableau noir : quand on a le dos tourné, un message apparaît à la craie. */
const chalkboard: Factory = (g, w) => {
  const face = faceOf(g, FRONT_AXES);
  const board = face ? new FaceCanvas(g.object, face, 256, 192, { shrink: 0.8, transparent: true }) : null;
  let written = false;
  let unseen = 0;
  const delay = 3 + objectRoll(g, 1) * 6;
  return {
    update: (dt, near) => {
      if (written || !board || !near) return;
      const position = g.object.position;
      const close = position.distanceTo(w.head()) < 9;
      unseen = close && !inView(w, position, 0.3) ? unseen + dt : 0;
      if (unseen < delay) return;
      written = true;
      const messages = tList("interact.chalk");
      const message = messages[Math.floor(objectRoll(g, 2) * messages.length)]!.replace("{take}", String(w.take()));
      const ctx = board.ctx;
      ctx.clearRect(0, 0, 256, 192);
      // Craie bien contrastée (blanc quasi pur + léger halo) : lisible même de loin, à travers la corruption.
      ctx.font = "bold 46px " + HANDWRITING_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = 6;
      const lines = wrapLines(ctx, message, 232);
      const lineHeight = 50;
      ctx.fillStyle = "rgba(250, 250, 245, 0.97)";
      lines.forEach((line, index) => {
        ctx.save();
        ctx.translate(128, 96 + (index - (lines.length - 1) / 2) * lineHeight);
        ctx.rotate(-0.05);
        ctx.fillText(line, 0, 0);
        ctx.restore();
      });
      board.commit();
    },
    dispose: () => board?.dispose(),
  };
};

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
      w.audio.playAt("wheel", g.object.position, Math.min(0.9, speed));
      if (noiseTimer <= 0) {
        noiseTimer = 1.5;
        noiseAt(g, 0.3 * Math.min(1, speed));
      }
    },
  };
};

/** Étagère métallique : bousculée, elle tremble et tout ce qu'elle porte cliquette. */
const metalShelves: Factory = (g, w) => {
  let cooldown = 0;
  return {
    update: (dt) => {
      cooldown -= dt;
      if (cooldown > 0 || g.body.isSleeping()) return;
      const v = g.body.linvel();
      const a = g.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) < 0.3 && Math.hypot(a.x, a.y, a.z) < 0.5) return;
      cooldown = 1.2;
      w.audio.playAt("rattle", g.object.position, 0.8);
      noiseAt(g, 0.4);
    },
  };
};

/** Panneau « sol glissant » : se plie et se déplie. */
const wetFloorSign: Factory = (g, w) => {
  let folded = false;
  const toggle = (): void => {
    folded = !folded;
    for (const child of g.object.children) child.scale.z = folded ? 0.2 : 1;
    w.audio.playAt("creak", g.object.position, 0.6);
  };
  return { use: toggle, poke: toggle };
};

/** Fauteuil : quand personne ne le regarde, il pivote. */
const armChair: Factory = (g, w) => {
  let timer = 10 + objectRoll(g, 4) * 15;
  return {
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
};

/** Tabouret métallique : on le fait tourner d'une pichenette. */
const metalStool: Factory = (g, w) => {
  const spin = (): void => {
    g.body.applyTorqueImpulse({ x: 0, y: 1.2, z: 0 }, true);
    // "creak" (grincement métallique) plutôt que "squeak" (couic de jouet) : un tabouret qui
    // tourne ne devrait pas sonner comme un canard en caoutchouc.
    w.audio.playAt("creak", g.object.position, 0.5);
    noiseAt(g, 0.2);
  };
  return { poke: spin, use: spin };
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
        w.audio.playAt("metalClick", g.object.position, 0.6);
        return;
      }
      state = "armed";
      timer = 5;
      w.audio.playAt("metalClick", g.object.position, 0.6);
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
      w.audio.playAt(sound, g.object.position, Math.min(1, 0.4 + speed * 0.12));
      noiseAt(g, loudness);
    },
  });
}

/** Objet fragile : se brise s'il heurte quelque chose trop fort (et disparaît). */
function breakable(minSpeed: number, loudness: number): Factory {
  return (g, w) => ({
    impact: (speed) => {
      if (speed < minSpeed) return;
      w.audio.playAt("shatter", g.object.position, 0.9);
      noiseAt(g, loudness);
      w.registry.remove(g);
    },
  });
}

/** Petit geste sonore à la gâchette (ouvrir un étui, presser un jouet...). */
function useSound(sound: "metalClick" | "rustle" | "squeak" | "whistle", loudness: number, volume = 0.7, cooldown = 0.3): Factory {
  return (g, w) => {
    let last = -Infinity;
    return {
      use: () => {
        const now = performance.now() / 1000;
        if (now - last < cooldown) return;
        last = now;
        w.audio.playAt(sound, g.object.position, volume);
        if (loudness > 0) noiseAt(g, loudness);
      },
    };
  };
}

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
      w.audio.playAt("crumple", g.object.position, 0.8);
      noiseAt(g, 0.2);
    },
  };
};

/** Aérosol : pulvérise un petit nuage ; le lubrifiant fait taire un chariot qui grince. */
function sprayCan(lubricant: boolean): Factory {
  return (g, w, system) => ({
    use: (hand) => {
      w.audio.playAt("spray", g.object.position, 0.6);
      noiseAt(g, 0.15);
      system.puff(g.object.position, hand.aimDirection);
      if (!lubricant) return;
      for (const other of w.registry.all) {
        if (other.kind === "storageCart" && other.object.position.distanceTo(g.object.position) < 1.4) system.behaviourOf(other)?.oil?.();
      }
    },
  });
}

/** Photo : annotation au dos ; quand on ne la regarde pas, l'image change (l'endroit où l'on est). */
const photo: Factory = (g, w) => {
  const front = faceOf(g);
  if (!front) return {};
  const back = findModelFace(g.object, front.normal.clone().negate());
  const frontCanvas = new FaceCanvas(g.object, front, 192, 192, { shrink: 0.82 });
  frontCanvas.visible = false;
  const backCanvas = back ? new FaceCanvas(g.object, back, 192, 192, { shrink: 0.9 }) : null;
  if (backCanvas) {
    const texts = tList("interact.photoBacks");
    const ctx = backCanvas.ctx;
    ctx.fillStyle = "#e6e2d8";
    ctx.fillRect(0, 0, 192, 192);
    ctx.fillStyle = "#1c2753";
    ctx.font = `20px ${HANDWRITING_FONT}`;
    const words = (texts[Math.floor(objectRoll(g, 6) * texts.length)] ?? "").split(" ");
    let line = "";
    let y = 40;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > 165 && line) {
        ctx.fillText(line, 14, y);
        line = word;
        y += 28;
      } else line = candidate;
    }
    ctx.fillText(line, 14, y);
    backCanvas.commit();
  }
  let unseen = 0;
  let cooldown = 0;
  return {
    update: (dt, near) => {
      cooldown -= dt;
      if (!near || cooldown > 0) return;
      const position = g.object.position;
      unseen = position.distanceTo(w.head()) < 6 && !inView(w, position, 0.35) ? unseen + dt : 0;
      if (unseen < 3) return;
      const shot = w.capturePhoto();
      cooldown = 25;
      unseen = 0;
      if (!shot) return;
      frontCanvas.ctx.drawImage(shot, 0, 0, 192, 192);
      frontCanvas.commit();
      frontCanvas.visible = true;
    },
    dispose: () => {
      frontCanvas.dispose();
      backCanvas?.dispose();
    },
  };
};

/** Cadran dessiné à la demande (boussole, montre digitale), rafraîchi quand on est près. */
function dial(size: number, rate: number, draw: (ctx: CanvasRenderingContext2D, g: Grabbable, w: InteractionWorld, face: ModelFace) => void): Factory {
  return (g, w) => {
    // Cadran sur le dessus de l'objet (sa plus grande face serait le dessous, posé à plat).
    const face = faceOf(g, UP_AXES);
    if (!face) return {};
    const canvas = new FaceCanvas(g.object, face, size, size, { shrink: 0.7, glow: true, transparent: true });
    let timer = 0;
    return {
      update: (dt, near) => {
        timer -= dt;
        if (timer > 0 || !near || g.object.position.distanceTo(w.head()) > 4) return;
        timer = rate;
        draw(canvas.ctx, g, w, face);
        canvas.commit();
      },
      dispose: () => canvas.dispose(),
    };
  };
}

const compass = dial(128, 0.1, (ctx, g, w, face) => {
  const exit = w.exitPosition();
  // Direction de la sortie dans le repère de l'objet, projetée sur le plan du cadran.
  const worldDirection = tmp.set(exit.x - g.object.position.x, 0, exit.z - g.object.position.z).normalize();
  const local = worldDirection.applyQuaternion(g.object.quaternion.clone().invert());
  const right = tmp2.crossVectors(face.up, face.normal).normalize();
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
});

const digitalWatch = dial(128, 1, (ctx, _g, w) => {
  const total = Math.floor(w.runSeconds());
  ctx.fillStyle = "#9fb08a";
  ctx.fillRect(0, 28, 128, 72);
  ctx.fillStyle = "#1f2a18";
  ctx.font = "bold 30px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`, 64, 64);
});

/** Manette : vibre dans la vraie manette du joueur. */
const gamepad: Factory = () => ({
  use: (hand) => hand.pulse(1, 450),
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
      w.audio.playAt("suction", origin, 0.8);
    },
    grab: () => {
      if (!stuck) return;
      stuck = false;
      g.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      w.audio.playAt("suction", g.object.position, 0.6);
    },
  };
};

/** Instrument de bord : les aiguilles s'affolent près du Cadreur (grésillements, tremblement). */
const spacecraftInstrument: Factory = (g, w) => {
  let tick = 0;
  return {
    update: (dt, near) => {
      if (!near || g.object.position.distanceTo(w.head()) > 3) return;
      const cadreur = w.cadreurPosition();
      const distance = cadreur ? Math.hypot(cadreur.x - g.object.position.x, cadreur.z - g.object.position.z) : Infinity;
      const intensity = distance < 25 ? 1 - distance / 25 : 0;
      tick -= dt;
      if (tick <= 0 && intensity > 0) {
        tick = 0.05 + (1 - intensity) * 0.6 * Math.random();
        w.audio.playAt("crackle", g.object.position, 0.3 + intensity * 0.4);
      }
      const jitter = intensity > 0.5 ? (intensity - 0.5) * 0.006 : 0;
      for (const child of g.object.children) child.position.set((Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter, 0);
    },
  };
};

/** Montre à gousset : ouverte, elle fait tic-tac. */
const pocketWatch: Factory = (g, w) => {
  let open = false;
  let loop: LoopHandle | null = null;
  return {
    use: () => {
      open = !open;
      w.audio.playAt("metalClick", g.object.position, 0.5);
      if (open) loop = w.audio.loop("tick", g.object, 0.35);
      else {
        loop?.stop();
        loop = null;
      }
    },
    dispose: () => loop?.stop(),
  };
};

/** Horloge murale : tic-tac… qui s'arrête quand le Cadreur approche. */
const wallClock: Factory = (g, w) => {
  let loop: LoopHandle | null = null;
  return {
    update: (_dt, near) => {
      const cadreur = w.cadreurPosition();
      const silenced = !!cadreur && Math.hypot(cadreur.x - g.object.position.x, cadreur.z - g.object.position.z) < 10;
      const ticking = near && g.object.position.distanceTo(w.head()) < 7 && !silenced;
      if (ticking && !loop) loop = w.audio.loop("tick", g.object, 0.45);
      else if (!ticking && loop) {
        loop.stop();
        loop = null;
      }
    },
    dispose: () => loop?.stop(),
  };
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
  const box = new THREE.Box3().setFromObject(g.object);
  const nozzleWorld = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
  const nozzleLocal = g.object.worldToLocal(nozzleWorld);
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
    update: (dt) => {
      if (!on) return;
      const jitter = 1 + Math.sin(performance.now() * 0.03) * 0.08 + (Math.random() - 0.5) * 0.1;
      flame.scale.set(0.045 * jitter, 0.06 * (1 + (Math.random() - 0.5) * 0.15), 1);
      flame.position.y += Math.sin(dt * 40) * 0.0003;
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
const securityCamera: Factory = (g, w, system) => {
  const direction = new THREE.Vector3(0, 0, -1);
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
      system.placeSecurityCamera(g, direction);
      log("interact", { action: "security-placed" });
      w.audio.playAt("beep", g.object.position, 0.4);
    },
    dispose: () => system.removeSecurityCamera(g),
  };
};

/** Jumelles : portées aux yeux, un zoom ×5 dans l'axe du regard (deux disques). */
const binoculars: Factory = (g, w) => {
  const mask = circleMask(true);
  const overlay = eyeOverlay(w, 0.22, 0.11, new THREE.MeshBasicMaterial({ alphaMap: mask, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  return {
    update: () => {
      const visible = atEye(g, w, 0.2);
      if (visible && !overlay.visible) log("interact", { action: "view", kind: "binoculars" });
      overlay.visible = visible;
      if (!overlay.visible) return;
      const view = w.views.use("binoculars", 256, 128, 15, 11);
      w.camera.getWorldPosition(view.camera.position);
      w.camera.getWorldQuaternion(view.camera.quaternion);
      const material = overlay.material as THREE.MeshBasicMaterial;
      if (material.map !== view.texture) {
        material.map = view.texture;
        material.needsUpdate = true;
      }
    },
    dispose: () => {
      overlay.removeFromParent();
      overlay.geometry.dispose();
      (overlay.material as THREE.Material).dispose();
      mask.dispose();
    },
  };
};

/** Loupe : ce qu'on regarde à travers le verre apparaît grossi (×2,5). */
const magnifyingGlass: Factory = (g, w, system) => {
  const face = faceOf(g);
  if (!face) return {};
  const mask = circleMask(false);
  const material = new THREE.MeshBasicMaterial({ alphaMap: mask, transparent: true, toneMapped: false });
  const lens = createFacePlane(face, material, 0.85, 1);
  lens.visible = false;
  g.object.add(lens);
  system.displays.add(lens);
  const center = new THREE.Vector3();
  return {
    update: () => {
      const visible = !!g.heldBy && g.object.position.distanceTo(w.head()) < 0.8;
      if (visible && !lens.visible) log("interact", { action: "view", kind: "magnifyingGlass" });
      lens.visible = visible;
      if (!lens.visible) return;
      lens.getWorldPosition(center);
      const head = w.head();
      const distance = Math.max(0.05, center.distanceTo(head));
      const radius = (face.width * 0.85 * g.object.scale.x) / 2;
      const fov = THREE.MathUtils.radToDeg((2 * Math.atan(radius / distance)) / 2.5);
      const view = w.views.use("loupe", 160, 160, 15, THREE.MathUtils.clamp(fov, 2, 40), [...system.displays]);
      view.camera.position.copy(head);
      view.camera.lookAt(center);
      if (material.map !== view.texture) {
        material.map = view.texture;
        material.needsUpdate = true;
      }
    },
    dispose: () => {
      system.displays.delete(lens);
      lens.geometry.dispose();
      material.dispose();
      mask.dispose();
    },
  };
};

const BEHAVIOURS: Record<string, Factory> = {
  securityCamera,
  binoculars,
  magnifyingGlass,
  television,
  chalkboard,
  storageCart,
  metalShelves,
  wetFloorSign,
  armChair,
  metalStool,
  alarmClock,
  brassPot: (g, w, s) => ({
    ...impactNoise("gong", 2, 0.8)(g, w, s),
    use: () => {
      w.audio.playAt("gong", g.object.position, 0.9);
      noiseAt(g, 0.8);
    },
  }),
  can,
  football: impactNoise("thump", 1.5, 0.4),
  hammer: impactNoise("bang", 3, 0.9),
  vase: breakable(2.5, 0.8),
  lightbulb,
  toy: useSound("squeak", 0.5),
  kettle: useSound("whistle", 0.8, 0.8, 3.2),
  cigaretteCase: useSound("metalClick", 0.1),
  cigarettePack: useSound("rustle", 0),
  cleanerTin: useSound("metalClick", 0),
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
  spacecraftInstrument,
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
};

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
  private readonly touching = new Set<string>();
  private readonly lastPoke = new Map<Grabbable, number>();
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
  }

  removeSecurityCamera(g: Grabbable): void {
    if (this.securityCamera !== g) return;
    this.securityCamera = null;
    this.world.views.release("security");
  }

  /** Oriente la caméra d'une vue comme la caméra de surveillance posée. */
  aimSecurityView(camera: THREE.PerspectiveCamera): void {
    const g = this.securityCamera;
    if (!g) return;
    camera.position.copy(g.object.position);
    camera.position.y += 0.05;
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
    this.lastPoke.delete(g);
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

  update(deltaSeconds: number, hands: readonly Hand[]): void {
    this.time += deltaSeconds;
    const head = this.world.head();
    for (const [g, behaviour] of this.behaviours) {
      const near = g.object.position.distanceTo(head) < NEAR_DISTANCE;
      behaviour.update?.(deltaSeconds, near);
      if (behaviour.impact && !g.heldBy && this.behaviours.has(g)) this.detectImpact(g, behaviour);
    }
    this.detectPokes(hands);
    this.updatePuffs(deltaSeconds);
  }

  /** Choc : la vitesse chute brutalement d'une frame à l'autre (objet lancé contre un mur, au sol). */
  private detectImpact(g: Grabbable, behaviour: Behaviour): void {
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

  /** Doigt tendu (gâchette relâchée) posé sur un objet qui réagit au toucher. */
  private detectPokes(hands: readonly Hand[]): void {
    for (const hand of hands) {
      if (!hand.tracked || hand.holding || hand.input.trigger.value > 0.5) continue;
      const tip = hand.getIndexTipWorld(tmp);
      if (!tip) continue;
      for (const [g, behaviour] of this.behaviours) {
        if (!behaviour.poke || g.heldBy || g.object.position.distanceTo(tip) > 2) continue;
        const key = `${hand.input.handedness}:${g.collider.handle}`;
        const projection = g.collider.projectPoint(tip, true);
        const touching = !!projection && (projection.isInside || tip.distanceTo(tmp2.set(projection.point.x, projection.point.y, projection.point.z)) < POKE_DISTANCE);
        if (touching && !this.touching.has(key) && this.time - (this.lastPoke.get(g) ?? -Infinity) > POKE_COOLDOWN) {
          this.lastPoke.set(g, this.time);
          hand.pulse(0.3, 25);
          log("interact", { action: "poke", kind: g.kind });
          behaviour.poke(hand);
        }
        if (touching) this.touching.add(key);
        else this.touching.delete(key);
      }
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
