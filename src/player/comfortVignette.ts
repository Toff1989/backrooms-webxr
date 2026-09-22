import * as THREE from "three";

const MAX_ALPHA = 0.85;
const FADE_LAMBDA = 6;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uIntensity;
  void main() {
    vec2 centered = (vUv - 0.5) * 2.0;
    float dist = length(centered);
    float edge = smoothstep(0.55, 1.0, dist);
    gl_FragColor = vec4(0.0, 0.0, 0.0, edge * uIntensity);
  }
`;

/**
 * Vignette de confort : quad fixé à la tête (pas de post-processing EffectComposer en WebXR).
 * S'assombrit sur les bords pendant le déplacement fluide, se dissipe à l'arrêt.
 */
export class ComfortVignette {
  enabled = true;

  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private currentIntensity = 0;

  constructor(camera: THREE.Camera) {
    const geometry = new THREE.PlaneGeometry(4, 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: 0 } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(0, 0, -1);
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    camera.add(this.mesh);
  }

  update(movementIntensity: number, deltaSeconds: number): void {
    const target = this.enabled ? THREE.MathUtils.clamp(movementIntensity, 0, 1) * MAX_ALPHA : 0;
    this.currentIntensity = THREE.MathUtils.damp(this.currentIntensity, target, FADE_LAMBDA, deltaSeconds);
    const uniform = this.material.uniforms["uIntensity"];
    if (uniform) uniform.value = this.currentIntensity;
  }
}
