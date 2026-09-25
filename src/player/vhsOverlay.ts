import * as THREE from "three";
import { getVhsNoiseTexture, vhsNoiseFrame } from "../world/vhsNoiseTexture";

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uCorruption;
  uniform float uTracking;
  uniform float uSnow;
  uniform float uBlue;
  uniform float uVignette;
  uniform sampler2DArray uNoiseMap;
  uniform float uNoiseFrame;
  uniform sampler2D uOsd;

  // Bruit VHS capturé (voir vhsNoiseTexture.ts) : image courante du flipbook.
  float vhsNoise( vec2 uv ) {
    return texture( uNoiseMap, vec3( uv, uNoiseFrame ) ).r;
  }

  float hash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  void main() {
    float scanline = sin((vUv.y + uTime * 0.03) * 700.0);
    scanline = pow(max(scanline, 0.0), 4.0) * 0.10;

    // Bruit VHS réel (vidéo de grain TV capturée), pas un hash procédural : dérive dans
    // le temps pour ne jamais se figer sur le même motif, s'intensifie avec la corruption.
    vec2 noiseUv = fract(vUv * 1.3 + vec2(uTime * 0.015, uTime * 0.011));
    float noise = vhsNoise(noiseUv);
    float grain = (noise - 0.5) * (0.35 + uCorruption * 0.45);

    float alpha = clamp(scanline + abs(grain), 0.0, 0.65);
    vec3 color = vec3(0.0);

    // Perte de tracking (téléportation, glitch fort) : bandes de neige qui défilent, barre
    // de synchro claire, voile sombre — sans jamais déplacer l'image (confort VR).
    if (uTracking > 0.001) {
      float frame = floor(uTime * 24.0);
      float band = floor(vUv.y * 38.0);
      float bandOn = step(1.0 - uTracking * 0.7, hash(vec2(band, frame)));
      float snow = vhsNoise(fract(vec2(vUv.x * 3.1 + hash(vec2(band, frame + 1.0)), vUv.y * 0.7 + uTime * 0.37)));
      float roll = fract(vUv.y * 0.8 + uTime * 1.3);
      float syncBar = smoothstep(0.0, 0.03, roll) * (1.0 - smoothstep(0.03, 0.09, roll)) * uTracking;
      color = mix(color, vec3(snow), max(bandOn, syncBar));
      alpha = max(alpha, max(bandOn * (0.35 + snow * 0.5), syncBar * 0.5));
      alpha = max(alpha, uTracking * 0.35);
    }

    // Perte de signal complète : neige plein écran (téléportation, corruption extrême).
    if (uSnow > 0.001) {
      float snow = vhsNoise(fract(vUv * vec2(2.3, 1.7) + vec2(hash(vec2(floor(uTime * 30.0), 1.0)), uTime * 0.9)));
      color = mix(color, vec3(snow * 0.9), uSnow);
      alpha = max(alpha, uSnow * 0.94);
    }

    // Écran bleu du magnétoscope avec texte OSD ("▶ PLAY", niveau) : changement de niveau.
    if (uBlue > 0.001) {
      vec2 osdUv = (vUv - 0.36) / 0.28;
      float osd = 0.0;
      if (osdUv.x > 0.0 && osdUv.x < 1.0 && osdUv.y > 0.0 && osdUv.y < 1.0) osd = texture2D(uOsd, osdUv).a;
      float wobble = step(0.97, hash(vec2(floor(vUv.y * 60.0), floor(uTime * 20.0)))) * 0.15;
      vec3 blue = vec3(0.02, 0.09, 0.62) + wobble;
      color = mix(color, mix(blue, vec3(0.95), osd), uBlue);
      alpha = max(alpha, uBlue);
    }
    // Vignette de confort (voir comfortVignette.ts), composée comme un voile noir posé
    // par-dessus l'overlay : même résultat que l'ancien quad séparé, une passe de moins. Même
    // rayon aussi : l'ancien quad était à 1 m, celui-ci à 0,9 m (d'où le facteur 1/0,9).
    float vignette = smoothstep(0.55, 1.0, length((vUv - 0.5) * (2.0 / 0.9))) * uVignette;
    float outAlpha = alpha + vignette - alpha * vignette;
    color = outAlpha > 0.0 ? color * alpha * (1.0 - vignette) / outAlpha : color;
    gl_FragColor = vec4(color, outAlpha);
  }
`;

/**
 * Scanlines + vrai bruit VHS (vidéo de grain TV, pas un hash procédural) sur un quad
 * fixé à la tête (pas de post-processing EffectComposer en WebXR). Effet constant,
 * renforcé par la corruption cumulable (glitchs, transitions de level) — à distinguer
 * de la vignette de confort (qui réagit au déplacement).
 */
export class VhsOverlay {
  private readonly material: THREE.ShaderMaterial;
  private readonly osdCanvas: HTMLCanvasElement;
  private readonly osdTexture: THREE.CanvasTexture;
  private tracking = 0;
  private snowSeconds = 0;
  private blueSeconds = 0;
  private blueDuration = 1;

  constructor(camera: THREE.Camera) {
    const noiseTexture = getVhsNoiseTexture();

    this.osdCanvas = document.createElement("canvas");
    this.osdCanvas.width = 512;
    this.osdCanvas.height = 512;
    this.osdTexture = new THREE.CanvasTexture(this.osdCanvas);

    const geometry = new THREE.PlaneGeometry(4, 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCorruption: { value: 0 },
        uTracking: { value: 0 },
        uSnow: { value: 0 },
        uBlue: { value: 0 },
        uVignette: { value: 0 },
        uNoiseMap: { value: noiseTexture },
        uNoiseFrame: { value: 0 },
        uOsd: { value: this.osdTexture },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.position.set(0, 0, -0.9);
    mesh.renderOrder = 998;
    mesh.frustumCulled = false;
    camera.add(mesh);
  }

  /** Assombrissement des bords (vignette de confort, 0..1). */
  setVignette(intensity: number): void {
    this.material.uniforms["uVignette"]!.value = intensity;
  }

  /** Perte de tracking VHS (0..1), se dissipe d'elle-même. */
  triggerTrackingLoss(strength: number): void {
    this.tracking = Math.max(this.tracking, Math.min(1, strength));
  }

  /** Perte de signal complète (neige plein champ), brève. */
  signalLoss(seconds: number): void {
    this.snowSeconds = Math.max(this.snowSeconds, seconds);
  }

  /** Écran bleu du magnétoscope avec texte OSD (lignes centrées sous "▶ PLAY"). */
  blueScreen(seconds: number, lines: string[]): void {
    const ctx = this.osdCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.font = "bold 44px monospace";
    ctx.textAlign = "left";
    ctx.fillText("\u25B6 PLAY", 20, 60);
    ctx.textAlign = "center";
    ctx.font = "bold 60px monospace";
    lines.forEach((line, index) => ctx.fillText(line, 256, 250 + index * 80));
    this.osdTexture.needsUpdate = true;
    this.blueSeconds = seconds;
    this.blueDuration = seconds;
  }

  update(elapsedSeconds: number, corruption: number, deltaSeconds: number): void {
    // Une corruption forte fait aussi décrocher le signal par moments, jusqu'à la neige complète.
    if (corruption > 0.5 && Math.random() < deltaSeconds * corruption * 0.6) this.triggerTrackingLoss(0.25 + Math.random() * 0.3);
    if (corruption > 0.75 && Math.random() < deltaSeconds * 0.08) this.signalLoss(0.15 + Math.random() * 0.2);
    this.tracking = THREE.MathUtils.damp(this.tracking, 0, 2.5, deltaSeconds);
    this.snowSeconds = Math.max(0, this.snowSeconds - deltaSeconds);
    this.blueSeconds = Math.max(0, this.blueSeconds - deltaSeconds);
    // Bleu plein pendant l'essentiel de la durée, coupure franche sur la fin (neige brève).
    const blueProgress = 1 - this.blueSeconds / this.blueDuration;
    this.material.uniforms["uBlue"]!.value = this.blueSeconds > 0 ? (blueProgress < 0.85 ? 1 : 0) : 0;
    this.material.uniforms["uSnow"]!.value = this.snowSeconds > 0 || (this.blueSeconds > 0 && blueProgress >= 0.85) ? 1 : 0;
    this.material.uniforms["uTime"]!.value = elapsedSeconds;
    this.material.uniforms["uNoiseFrame"]!.value = vhsNoiseFrame(elapsedSeconds);
    this.material.uniforms["uCorruption"]!.value = corruption;
    this.material.uniforms["uTracking"]!.value = this.tracking;
  }
}
