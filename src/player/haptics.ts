import * as THREE from "three";

/** Déclenche une pulsation haptique sur les manettes disponibles (signal de piège glitch). */
export function triggerHapticPulse(renderer: THREE.WebGLRenderer, intensity: number, durationMs: number): void {
  const session = renderer.xr.getSession();
  if (!session) return;

  for (const source of session.inputSources) {
    const actuator = source.gamepad?.hapticActuators?.[0];
    actuator?.pulse(intensity, durationMs).catch(() => {});
  }
}
