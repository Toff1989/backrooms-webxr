import { CELL_SIZE } from "../shared/constants";
import { stringSeedToInt } from "../shared/rng";

/**
 * Champ de lumière du plafond : un bruit de valeur (2 octaves) échantillonné par cellule
 * décide quelles dalles lumineuses sont allumées. Sous le seuil, la zone est éteinte : les
 * néons de ces cellules ne brillent plus et l'éclairage ambiant des surfaces y tombe presque
 * à zéro (voir `vhsMaterial.ts`) — il faut la lampe torche pour y voir.
 *
 * La même formule existe en GLSL (`VHS_LIGHT_FIELD_GLSL`) : le CPU s'en sert pour l'audio
 * (ambiance plus oppressante dans le noir) et les apparitions de glitchs.
 */

/** Fréquence du bruit par cellule : ~5 cellules (12 m) entre deux zones de nature différente. */
export const LIGHT_FIELD_FREQUENCY = 0.19;
/** Rayon (en cellules) autour du spawn toujours éclairé : on ne démarre jamais dans le noir. */
export const SPAWN_LIT_RADIUS_CELLS = 3;

const BASE_DARK_THRESHOLD = 0.4;
const DARK_THRESHOLD_PER_DEPTH = 0.02;
const MAX_DARK_THRESHOLD = 0.56;

export interface LightFieldParams {
  seedX: number;
  seedY: number;
  /** Bruit sous ce seuil = cellule éteinte. Monte avec la profondeur (plus de zones sombres). */
  threshold: number;
  /** Cellule de la sortie : un néon ou deux restent allumés au-dessus (portail sombre, mais pas invisible). */
  exitCellX: number;
  exitCellZ: number;
}

/** Rayon (en cellules) toujours éclairé autour de la sortie. */
export const EXIT_LIT_RADIUS_CELLS = 1.5;

export function createLightFieldParams(levelSeed: string, depth: number, exitCellX: number, exitCellZ: number): LightFieldParams {
  const seedInt = stringSeedToInt(`${levelSeed}:lights`) >>> 0;
  return {
    seedX: (seedInt % 997) + 0.37,
    seedY: (Math.floor(seedInt / 997) % 991) + 0.71,
    threshold: Math.min(MAX_DARK_THRESHOLD, BASE_DARK_THRESHOLD + depth * DARK_THRESHOLD_PER_DEPTH),
    exitCellX,
    exitCellZ,
  };
}

function fract(value: number): number {
  return value - Math.floor(value);
}

/** Même hash que `vhsHash12` en GLSL (Dave Hoskins, sans sinus : stable sur mobile). */
export function hash12(x: number, y: number): number {
  let p3x = fract(x * 0.1031);
  let p3y = fract(y * 0.1031);
  let p3z = fract(x * 0.1031);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d;
  p3y += d;
  p3z += d;
  return fract((p3x + p3y) * p3z);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy);
  const b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1);
  const d = hash12(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Bruit de lumière en coordonnées cellule (entiers = centres de cellule). */
export function lightNoise(params: LightFieldParams, cellX: number, cellZ: number): number {
  const px = cellX * LIGHT_FIELD_FREQUENCY + params.seedX;
  const py = cellZ * LIGHT_FIELD_FREQUENCY + params.seedY;
  const spawnBoost = 0.45 * (1 - smoothstep(SPAWN_LIT_RADIUS_CELLS * 0.5, SPAWN_LIT_RADIUS_CELLS, Math.hypot(cellX, cellZ)));
  const exitBoost = 0.3 * (1 - smoothstep(EXIT_LIT_RADIUS_CELLS * 0.5, EXIT_LIT_RADIUS_CELLS, Math.hypot(cellX - params.exitCellX, cellZ - params.exitCellZ)));
  return valueNoise(px, py) * 0.65 + valueNoise(px * 2.3 + 17, py * 2.3 + 17) * 0.35 + spawnBoost + exitBoost;
}

/** Éclairage ambiant [0..1] à une position monde (0 = zone éteinte). */
export function sampleZoneLight(params: LightFieldParams, worldX: number, worldZ: number): number {
  const n = lightNoise(params, worldX / CELL_SIZE - 0.5, worldZ / CELL_SIZE - 0.5);
  return smoothstep(params.threshold - 0.07, params.threshold + 0.05, n);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Version GLSL (identique) — injectée dans les matériaux VHS. Nécessite `vhsHash12`. */
export const VHS_LIGHT_FIELD_GLSL = /* glsl */ `
  uniform vec2 uLightSeed;
  uniform float uDarkThreshold;
  uniform vec2 uExitCell;

  float vhsValueNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    float a = vhsHash12( i );
    float b = vhsHash12( i + vec2( 1.0, 0.0 ) );
    float c = vhsHash12( i + vec2( 0.0, 1.0 ) );
    float d = vhsHash12( i + vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
  }

  float vhsLightNoise( vec2 cellCoord ) {
    vec2 p = cellCoord * ${LIGHT_FIELD_FREQUENCY.toFixed(4)} + uLightSeed;
    float spawnBoost = 0.45 * ( 1.0 - smoothstep( ${(SPAWN_LIT_RADIUS_CELLS * 0.5).toFixed(2)}, ${SPAWN_LIT_RADIUS_CELLS.toFixed(2)}, length( cellCoord ) ) );
    float exitBoost = 0.3 * ( 1.0 - smoothstep( ${(EXIT_LIT_RADIUS_CELLS * 0.5).toFixed(2)}, ${EXIT_LIT_RADIUS_CELLS.toFixed(2)}, length( cellCoord - uExitCell ) ) );
    return vhsValueNoise( p ) * 0.65 + vhsValueNoise( p * 2.3 + 17.0 ) * 0.35 + spawnBoost + exitBoost;
  }

  float vhsZoneLight( vec3 worldPos ) {
    float n = vhsLightNoise( worldPos.xz / ${CELL_SIZE.toFixed(2)} - 0.5 );
    return smoothstep( uDarkThreshold - 0.07, uDarkThreshold + 0.05, n );
  }
`;
