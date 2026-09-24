import { CELL_SIZE } from "../shared/constants";
import { valueNoise } from "./lightField";

/**
 * Champ de la coupure de courant (voir `blackout.ts`), partagé CPU/GPU comme le champ de
 * lumière : un front circulaire part d'un point et s'étend (néons coupés derrière lui, qui
 * agonisent juste devant), puis les néons se rallument dans un ordre aléatoire par zones.
 * Le bord du front est irrégulier (bruit) pour ne pas dessiner un cercle parfait.
 */
export interface BlackoutState {
  on: boolean;
  originX: number;
  originZ: number;
  /** Rayon du front (m) : tout ce qui est à l'intérieur est coupé. */
  radius: number;
  /** Rallumage 0..1 (0 = tout est coupé, 1 = tout est revenu). */
  restore: number;
}

/** Largeur (m) de la bande, devant le front, où les néons grésillent avant de mourir. */
export const FRONT_WIDTH = 4;
const WOBBLE = 2.5;
const RESTORE_SPREAD = 1.1;
const RESTART_WINDOW = 0.1;

/** Lumière [0..1] à une position monde, et instabilité (front ou redémarrage) [0..1]. */
export function blackoutLightAt(state: BlackoutState, x: number, z: number): { light: number; unstable: number } {
  if (!state.on) return { light: 1, unstable: 0 };
  const distance = Math.hypot(x - state.originX, z - state.originZ) + valueNoise(x * 0.35 + 7, z * 0.35 + 7) * WOBBLE;
  const off = 1 - smoothstep(state.radius - 1.5, state.radius, distance);
  const order = valueNoise(x / CELL_SIZE + 41, z / CELL_SIZE + 41);
  const restore = state.restore * RESTORE_SPREAD;
  const back = smoothstep(order - 0.08, order, restore);
  const front = state.restore === 0 && distance > state.radius && distance < state.radius + FRONT_WIDTH ? 1 : 0;
  const restarting = off > 0.5 && order <= restore && order > restore - RESTART_WINDOW ? 1 : 0;
  return { light: 1 - off * (1 - back), unstable: Math.max(front, restarting) };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Version GLSL (identique). Nécessite `vhsValueNoise` (champ de lumière). */
export const VHS_BLACKOUT_GLSL = /* glsl */ `
  uniform vec4 uBlackout;
  uniform float uBlackoutOn;

  float vhsBlackoutLight( vec2 xz, out float unstable ) {
    unstable = 0.0;
    if ( uBlackoutOn < 0.5 ) return 1.0;
    float d = distance( xz, uBlackout.xy ) + vhsValueNoise( xz * 0.35 + 7.0 ) * ${WOBBLE.toFixed(2)};
    float off = 1.0 - smoothstep( uBlackout.z - 1.5, uBlackout.z, d );
    float order = vhsValueNoise( xz / ${CELL_SIZE.toFixed(2)} + 41.0 );
    float restore = uBlackout.w * ${RESTORE_SPREAD.toFixed(2)};
    float back = smoothstep( order - 0.08, order, restore );
    float front = ( uBlackout.w == 0.0 ? 1.0 : 0.0 ) * step( uBlackout.z, d ) * step( d, uBlackout.z + ${FRONT_WIDTH.toFixed(2)} );
    float restarting = step( 0.5, off ) * step( order, restore ) * step( restore - ${RESTART_WINDOW.toFixed(2)}, order );
    unstable = max( front, restarting );
    return 1.0 - off * ( 1.0 - back );
  }
`;
