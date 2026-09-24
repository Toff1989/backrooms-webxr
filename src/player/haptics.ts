import * as THREE from "three";

interface VibrationActuator {
  playEffect?: (type: string, params: { duration: number; strongMagnitude: number; weakMagnitude: number }) => Promise<unknown>;
}

/** Pulsation sur une manette précise (API `hapticActuators` du navigateur Quest, repli sur `vibrationActuator`). */
export function pulseGamepad(gamepad: Gamepad | undefined, intensity: number, durationMs: number): void {
  if (!gamepad) return;
  const actuator = gamepad.hapticActuators?.[0];
  if (actuator?.pulse) {
    actuator.pulse(intensity, durationMs).catch(() => {});
    return;
  }
  const vibration = (gamepad as Gamepad & { vibrationActuator?: VibrationActuator }).vibrationActuator;
  vibration?.playEffect?.("dual-rumble", { duration: durationMs, strongMagnitude: intensity, weakMagnitude: intensity }).catch(() => {});
}

/** Déclenche une pulsation haptique sur toutes les manettes (signaux de pièges). */
export function triggerHapticPulse(renderer: THREE.WebGLRenderer, intensity: number, durationMs: number): void {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const source of session.inputSources) pulseGamepad(source.gamepad, intensity, durationMs);
}
