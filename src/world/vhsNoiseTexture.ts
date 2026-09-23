import * as THREE from "three";
import vhsNoiseVideoUrl from "../assets/video/vhs-noise.webm";

let sharedTexture: THREE.VideoTexture | null = null;

/**
 * Texture vidéo de bruit VHS partagée : un seul `<video>` décodé, réutilisé par tous
 * les effets qui en ont besoin (overlay caméra, pièges glitch...) au lieu de décoder
 * le même fichier plusieurs fois en parallèle.
 */
export function getVhsNoiseTexture(): THREE.VideoTexture {
  if (!sharedTexture) {
    const video = document.createElement("video");
    video.src = vhsNoiseVideoUrl;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});

    sharedTexture = new THREE.VideoTexture(video);
    sharedTexture.wrapS = THREE.RepeatWrapping;
    sharedTexture.wrapT = THREE.RepeatWrapping;
    sharedTexture.magFilter = THREE.NearestFilter;
    sharedTexture.minFilter = THREE.NearestFilter;
    sharedTexture.colorSpace = THREE.NoColorSpace;
  }
  return sharedTexture;
}
