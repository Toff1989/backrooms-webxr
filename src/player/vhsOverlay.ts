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
  uniform sampler2D uNoiseMap;

  void main() {
    float scanline = sin((vUv.y + uTime * 0.03) * 700.0);
    scanline = pow(max(scanline, 0.0), 4.0) * 0.10;

    // Bruit VHS réel (vidéo de grain TV capturée), pas un hash procédural : dérive dans
    // le temps pour ne jamais se figer sur le même motif, s'intensifie avec la corruption.
    vec2 noiseUv = fract(vUv * 1.3 + vec2(uTime * 0.015, uTime * 0.011));
    float noise = texture2D(uNoiseMap, noiseUv).r;
    float grain = (noise - 0.5) * (0.35 + uCorruption * 0.45);

    float alpha = clamp(scanline + abs(grain), 0.0, 0.65);
    gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
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

  constructor(camera: THREE.Camera) {
    const noiseTexture = getVhsNoiseTexture();

    const geometry = new THREE.PlaneGeometry(4, 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCorruption: { value: 0 },
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

  update(elapsedSeconds: number, corruption: number): void {
    this.material.uniforms["uTime"]!.value = elapsedSeconds;
    this.material.uniforms["uCorruption"]!.value = corruption;
  }
}
