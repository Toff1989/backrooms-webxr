import * as THREE from "three";

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

  float vhsOverlayHash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
  }

  void main() {
    float scanline = sin((vUv.y + uTime * 0.03) * 700.0);
    scanline = pow(max(scanline, 0.0), 4.0) * 0.10;

    float grain = (vhsOverlayHash(vUv * 900.0 + uTime * 40.0) - 0.5) * 0.06;

    float alpha = clamp(scanline + grain, 0.0, 0.35);
    gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
  }
`;

/**
 * Scanlines + bruit subtils sur un quad fixé à la tête (pas de post-processing
 * EffectComposer en WebXR). Effet constant, indépendant du mouvement — à distinguer
 * de la vignette de confort (qui réagit au déplacement).
 */
export class VhsOverlay {
  private readonly material: THREE.ShaderMaterial;

  constructor(camera: THREE.Camera) {
    const geometry = new THREE.PlaneGeometry(4, 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
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

  update(elapsedSeconds: number): void {
    const uniform = this.material.uniforms["uTime"];
    if (uniform) uniform.value = elapsedSeconds;
  }
}
