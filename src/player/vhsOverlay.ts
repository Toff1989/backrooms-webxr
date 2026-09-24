import * as THREE from "three";
import { getVhsNoiseTexture } from "../world/vhsNoiseTexture";

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
  uniform sampler2D uNoiseMap;

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
    float noise = texture2D(uNoiseMap, noiseUv).r;
    float grain = (noise - 0.5) * (0.35 + uCorruption * 0.45);

    float alpha = clamp(scanline + abs(grain), 0.0, 0.65);
    vec3 color = vec3(0.0);

    // Perte de tracking (téléportation, glitch fort) : bandes de neige qui défilent, barre
    // de synchro claire, voile sombre — sans jamais déplacer l'image (confort VR).
    if (uTracking > 0.001) {
      float frame = floor(uTime * 24.0);
      float band = floor(vUv.y * 38.0);
      float bandOn = step(1.0 - uTracking * 0.7, hash(vec2(band, frame)));
      float snow = texture2D(uNoiseMap, fract(vec2(vUv.x * 3.1 + hash(vec2(band, frame + 1.0)), vUv.y * 0.7 + uTime * 0.37))).r;
      float roll = fract(vUv.y * 0.8 + uTime * 1.3);
      float syncBar = smoothstep(0.0, 0.03, roll) * (1.0 - smoothstep(0.03, 0.09, roll)) * uTracking;
      color = mix(color, vec3(snow), max(bandOn, syncBar));
      alpha = max(alpha, max(bandOn * (0.35 + snow * 0.5), syncBar * 0.5));
      alpha = max(alpha, uTracking * 0.35);
    }
    gl_FragColor = vec4(color, alpha);
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
  private tracking = 0;

  constructor(camera: THREE.Camera) {
    const noiseTexture = getVhsNoiseTexture();

    const geometry = new THREE.PlaneGeometry(4, 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCorruption: { value: 0 },
        uTracking: { value: 0 },
        uNoiseMap: { value: noiseTexture },
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

  /** Perte de tracking VHS (0..1), se dissipe d'elle-même. */
  triggerTrackingLoss(strength: number): void {
    this.tracking = Math.max(this.tracking, Math.min(1, strength));
  }

  update(elapsedSeconds: number, corruption: number, deltaSeconds: number): void {
    // Une corruption forte fait aussi décrocher le signal par moments.
    if (corruption > 0.5 && Math.random() < deltaSeconds * corruption * 0.6) this.triggerTrackingLoss(0.25 + Math.random() * 0.3);
    this.tracking = THREE.MathUtils.damp(this.tracking, 0, 2.5, deltaSeconds);
    this.material.uniforms["uTime"]!.value = elapsedSeconds;
    this.material.uniforms["uCorruption"]!.value = corruption;
    this.material.uniforms["uTracking"]!.value = this.tracking;
  }
}
