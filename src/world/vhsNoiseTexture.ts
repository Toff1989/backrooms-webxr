import * as THREE from "three";
import vhsNoiseVideoUrl from "../assets/video/vhs-noise.webm";

/** Images de bruit gardées : ~1 s de bande à la cadence ci-dessous. */
const FRAME_COUNT = 24;
/** Cadence du grain (images par seconde), celle d'une bande vidéo. */
const FRAME_RATE = 25;
/** Pas de lecture dans les images (premier avec FRAME_COUNT) : ordre mélangé, jamais deux fois la même d'affilée. */
const FRAME_STRIDE = 7;
/** Taille de la vidéo source (320 × 180) : chaque image capturée y est ramenée. */
const WIDTH = 320;
const HEIGHT = 180;

let sharedTexture: THREE.DataArrayTexture | null = null;

/**
 * Bruit VHS réel (vidéo de grain TV capturée) partagé par tous les effets qui en ont besoin
 * (overlay caméra, intérieur de la sortie), sous forme de « flipbook » : quelques images de la
 * vidéo, capturées une fois au démarrage dans une texture à couches (une par image, niveaux de
 * gris sur un octet). Avant, une `VideoTexture` : la vidéo était décodée en continu et chaque
 * image renvoyée au GPU (texImage2D complet), à chaque frame du jeu — un coût permanent sur le
 * processeur mobile du Quest pour un grain qui se répète de toute façon.
 *
 * En attendant la capture (moins d'une seconde), ou si la vidéo ne peut pas être lue, les
 * couches contiennent un bruit aléatoire : l'effet reste en place.
 *
 * Côté shader : `texture(noise, vec3(uv, frame)).r`, avec `frame` donné par `vhsNoiseFrame`.
 */
export function getVhsNoiseTexture(): THREE.DataArrayTexture {
  if (sharedTexture) return sharedTexture;
  const data = new Uint8Array(WIDTH * HEIGHT * FRAME_COUNT);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
  const texture = new THREE.DataArrayTexture(data, WIDTH, HEIGHT, FRAME_COUNT);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  sharedTexture = texture;
  captureVideoFrames(data, texture);
  return texture;
}

/** Couche à afficher à l'instant `elapsedSeconds`. */
export function vhsNoiseFrame(elapsedSeconds: number): number {
  return (Math.floor(elapsedSeconds * FRAME_RATE) * FRAME_STRIDE) % FRAME_COUNT;
}

/** Lit la vidéo le temps de copier `FRAME_COUNT` images consécutives, puis la libère. */
function captureVideoFrames(frames: Uint8Array, texture: THREE.DataArrayTexture): void {
  const video = document.createElement("video");
  video.src = vhsNoiseVideoUrl;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  let captured = 0;
  let lastTime = -1;
  const release = (): void => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
  const schedule = (): void => {
    if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(capture);
    else window.setTimeout(capture, 1000 / FRAME_RATE);
  };
  const capture = (): void => {
    // Même image qu'au dernier passage (repli sans requestVideoFrameCallback) : on attend la suivante.
    if (video.currentTime === lastTime) {
      schedule();
      return;
    }
    lastTime = video.currentTime;
    ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const layer = captured * WIDTH * HEIGHT;
    // Lignes inversées : la première ligne de la texture est le bas de l'image (comme la
    // VideoTexture d'avant, retournée à l'envoi) ; niveaux de gris : canal rouge.
    for (let y = 0; y < HEIGHT; y++) {
      const row = layer + (HEIGHT - 1 - y) * WIDTH;
      const source = y * WIDTH * 4;
      for (let x = 0; x < WIDTH; x++) frames[row + x] = pixels[source + x * 4]!;
    }
    captured++;
    if (captured < FRAME_COUNT) {
      schedule();
      return;
    }
    texture.needsUpdate = true;
    release();
  };
  video
    .play()
    .then(schedule)
    .catch(() => release());
}
