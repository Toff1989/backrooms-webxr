import * as THREE from "three";
import { CELL_SIZE, WALL_HEIGHT } from "../shared/constants";
import { VHS_BLACKOUT_GLSL } from "./blackoutField";
import { VHS_LIGHT_FIELD_GLSL, type LightFieldParams } from "./lightField";

/** Éclairage ambiant résiduel dans une zone éteinte (proche du noir : lampe torche nécessaire). */
const DARK_ZONE_AMBIENT = 0.035;

/**
 * Uniformes partagés par tous les matériaux VHS : un seul objet mutable référencé par
 * chaque shader compilé, pas besoin de garder une liste de shaders à mettre à jour.
 */
const sharedUniforms = {
  uTime: { value: 0 },
  /** Intensité de corruption visuelle cumulable (transitions de niveau, murs-pièges). */
  uCorruption: { value: 0 },
  uLightSeed: { value: new THREE.Vector2() },
  uDarkThreshold: { value: 0 },
  uExitCell: { value: new THREE.Vector2() },
  /** Décrépitude (0..1) : croît avec la profondeur. */
  uDecay: { value: 0 },
  /** Teinte globale du niveau (dérive du jaune vers un vert malade, puis un gris froid). */
  uLevelTint: { value: new THREE.Color(1, 1, 1) },
  uDesaturate: { value: 0 },
  /** Coupure de courant (voir `blackout.ts`) : origine XZ, rayon du front, progression du rallumage. */
  uBlackout: { value: new THREE.Vector4() },
  uBlackoutOn: { value: 0 },
};

const TINT_STOPS: Array<[number, THREE.Color]> = [
  [0, new THREE.Color(1, 1, 1)],
  [4, new THREE.Color(0.9, 1.0, 0.8)],
  [8, new THREE.Color(0.82, 0.9, 0.9)],
  [14, new THREE.Color(0.72, 0.78, 0.86)],
];

/**
 * Apparence du niveau selon la profondeur : plus on descend, plus c'est sale (auréoles,
 * remontées d'humidité, dalles de plafond manquantes) et plus la lumière tourne au malsain.
 */
export function setDepthLook(depth: number): void {
  sharedUniforms.uDecay.value = Math.min(1, depth / 8);
  sharedUniforms.uDesaturate.value = Math.min(0.4, Math.max(0, depth - 5) * 0.05);
  const tint = sharedUniforms.uLevelTint.value;
  for (let i = TINT_STOPS.length - 1; i >= 0; i--) {
    const [stopDepth, color] = TINT_STOPS[i]!;
    if (depth >= stopDepth) {
      const next = TINT_STOPS[i + 1];
      if (!next) tint.copy(color);
      else tint.copy(color).lerp(next[1], (depth - stopDepth) / (next[0] - stopDepth));
      break;
    }
  }
}

export function updateVhsTime(elapsedSeconds: number): void {
  sharedUniforms.uTime.value = elapsedSeconds;
}

export function setVhsCorruption(intensity: number): void {
  sharedUniforms.uCorruption.value = THREE.MathUtils.clamp(intensity, 0, 1);
}

export function setBlackoutUniforms(on: boolean, originX: number, originZ: number, radius: number, restore: number): void {
  sharedUniforms.uBlackoutOn.value = on ? 1 : 0;
  sharedUniforms.uBlackout.value.set(originX, originZ, radius, restore);
}

export function setLightField(params: LightFieldParams): void {
  sharedUniforms.uLightSeed.value.set(params.seedX, params.seedY);
  sharedUniforms.uDarkThreshold.value = params.threshold;
  sharedUniforms.uExitCell.value.set(params.exitCellX, params.exitCellZ);
}

const COMMON_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uCorruption;
  varying vec3 vVhsWorldPos;
  varying vec3 vVhsWorldNormal;
  varying float vVhsZoneLight;

  float vhsHash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
`;

const VERTEX_PARS_GLSL = /* glsl */ `
  ${COMMON_GLSL}
  ${VHS_LIGHT_FIELD_GLSL}
  ${VHS_BLACKOUT_GLSL}
`;

/** Position/normale monde et éclairage de zone, par sommet (le champ de lumière varie sur ~12 m). */
const VERTEX_WORLD_GLSL = /* glsl */ `
  #include <displacementmap_vertex>
  {
    vec4 vhsWorld = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      vhsWorld = batchingMatrix * vhsWorld;
    #endif
    #ifdef USE_INSTANCING
      vhsWorld = instanceMatrix * vhsWorld;
    #endif
    vhsWorld = modelMatrix * vhsWorld;
    vVhsWorldPos = vhsWorld.xyz;
    float vhsBlackoutUnstable;
    vVhsZoneLight = vhsZoneLight( vhsWorld.xyz ) * vhsBlackoutLight( vhsWorld.xz, vhsBlackoutUnstable );
    vVhsWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
  }
`;

const FRAGMENT_PARS_GLSL = /* glsl */ `
  ${COMMON_GLSL}
  ${VHS_LIGHT_FIELD_GLSL}
  ${VHS_BLACKOUT_GLSL}
  uniform float uDecay;
  uniform vec3 uLevelTint;
  uniform float uDesaturate;

  // Décrépitude : facteur de couleur à appliquer à l'albédo (avant l'éclairage).
  vec3 vhsDecayColor( vec3 wp, vec3 n ) {
    if ( uDecay < 0.001 ) return vec3( 1.0 );
    vec3 stainColor = vec3( 0.52, 0.47, 0.3 );
    float stain = 0.0;
    float edge = 0.0;
    if ( abs( n.y ) < 0.5 ) {
      // Mur : remontée d'humidité depuis la plinthe, bord irrégulier plus sombre (ligne de marée),
      // et quelques coulures qui descendent du plafond.
      float along = abs( n.z ) > abs( n.x ) ? wp.x : wp.z;
      float height = ( 0.1 + vhsValueNoise( vec2( along * 0.8, 3.1 ) ) * 0.8 ) * uDecay * 1.4;
      stain = 1.0 - smoothstep( height - 0.15, height, wp.y );
      edge = smoothstep( height - 0.09, height - 0.03, wp.y ) * ( 1.0 - smoothstep( height - 0.03, height, wp.y ) );
      float column = floor( along * 6.0 );
      float dripLength = 0.4 + vhsHash12( vec2( column, 9.0 ) ) * 1.4 * uDecay;
      float drip = step( 1.0 - uDecay * 0.12, vhsHash12( vec2( column, 7.0 ) ) ) * smoothstep( ${WALL_HEIGHT.toFixed(2)} - dripLength, ${WALL_HEIGHT.toFixed(2)} - dripLength * 0.3, wp.y );
      stain = max( stain, drip * 0.7 );
    } else {
      // Sol / plafond : grandes auréoles.
      float blot = vhsValueNoise( wp.xz * 0.4 + 11.0 ) * 0.7 + vhsValueNoise( wp.xz * 1.6 ) * 0.3;
      float threshold = 0.74 - uDecay * 0.28;
      stain = smoothstep( threshold, threshold + 0.06, blot );
      edge = smoothstep( threshold - 0.015, threshold + 0.01, blot ) * ( 1.0 - smoothstep( threshold + 0.01, threshold + 0.04, blot ) );
    }
    vec3 factor = mix( vec3( 1.0 ), stainColor, stain * ( 0.3 + uDecay * 0.45 ) );
    return factor * ( 1.0 - edge * 0.35 * uDecay );
  }
`;

const FRAGMENT_SETUP_GLSL = /* glsl */ `
  float vhsMissingTile = 0.0;
`;

const MAP_FRAGMENT_GLSL = /* glsl */ `
  #ifdef USE_MAP
    vec2 vhsAberration = ( vMapUv - 0.5 ) * ( 0.004 + uCorruption * 0.012 );
    vec4 sampledDiffuseColor;
    sampledDiffuseColor.r = texture2D( map, vMapUv - vhsAberration ).r;
    sampledDiffuseColor.g = texture2D( map, vMapUv ).g;
    sampledDiffuseColor.b = texture2D( map, vMapUv + vhsAberration ).b;
    sampledDiffuseColor.a = texture2D( map, vMapUv ).a;
    diffuseColor *= sampledDiffuseColor;
  #endif
  diffuseColor.rgb *= vhsDecayColor( vVhsWorldPos, normalize( vVhsWorldNormal ) );
`;

/** Néons du plafond : chaque cellule est allumée, morte ou agonisante selon le champ de lumière. */
const CEILING_EMISSIVE_GLSL = /* glsl */ `
  #include <emissivemap_fragment>
  {
    vec2 cell = floor( vVhsWorldPos.xz / ${CELL_SIZE.toFixed(2)} );
    float n = vhsLightNoise( cell );
    float lamp = step( uDarkThreshold, n );
    float cellHash = vhsHash12( cell + uLightSeed * 3.1 );
    // Quelques néons morts même en zone éclairée : casse la régularité de la grille.
    lamp *= step( 0.07, cellHash );
    // Néons agonisants en bordure de zone sombre, et quelques-uns au hasard : clignotement irrégulier.
    if ( n < uDarkThreshold + 0.04 || cellHash > 0.95 ) {
      float flick = vhsHash12( vec2( floor( uTime * ( 6.0 + cellHash * 10.0 ) ), cell.x * 7.0 + cell.y ) );
      lamp *= step( 0.3, flick ) * ( 0.5 + 0.5 * flick );
    }
    // Coupure : néon coupé derrière le front ; juste devant, il agonise (grésillement, sursauts).
    float blackoutUnstable;
    lamp *= step( 0.5, vhsBlackoutLight( ( cell + 0.5 ) * ${CELL_SIZE.toFixed(2)}, blackoutUnstable ) );
    if ( blackoutUnstable > 0.0 ) {
      float spasm = vhsHash12( vec2( floor( uTime * ( 9.0 + cellHash * 16.0 ) ), cell.x * 3.0 + cell.y * 5.0 ) );
      lamp *= step( 0.5, spasm ) * ( 0.3 + 0.7 * spasm );
    }
    // Décrépitude : dalles de plafond tombées (trou noir, plus de néon dessous).
    vec2 tile = floor( vVhsWorldPos.xz / ${(CELL_SIZE / 4).toFixed(4)} );
    vhsMissingTile = step( 1.0 - uDecay * 0.16, vhsHash12( tile * 1.37 + uLightSeed ) );
    totalEmissiveRadiance *= lamp * ( 1.0 - vhsMissingTile );
  }
`;

/** Assombrit l'éclairage ambiant (hémisphère + ambiante) dans les zones éteintes. La lampe
 * torche (lumière directe) n'est pas touchée : c'est elle qui éclaire les zones sombres. */
const ZONE_LIGHT_GLSL = /* glsl */ `
  #if defined( RE_IndirectDiffuse )
    irradiance *= mix( ${DARK_ZONE_AMBIENT.toFixed(3)}, 1.0, vVhsZoneLight );
  #endif
  #include <lights_fragment_maps>
`;

const FINAL_GLSL = /* glsl */ `
  #include <dithering_fragment>

  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( 0.006, 0.005, 0.004 ), vhsMissingTile );
  gl_FragColor.rgb *= uLevelTint;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) ), uDesaturate );

  float vhsGrain = ( fract( sin( dot( gl_FragCoord.xy + uTime * 60.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453123 ) - 0.5 ) * ( 0.05 + uCorruption * 0.15 );
  gl_FragColor.rgb += vhsGrain;

  float vhsLevels = mix( 24.0, 10.0, uCorruption );
  gl_FragColor.rgb = floor( gl_FragColor.rgb * vhsLevels + 0.5 ) / vhsLevels;

  gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * vec3( 1.08, 1.0, 0.82 ), 0.35 );
`;

export interface VhsEffectOptions {
  /** Plafond : les néons de la texture d'émission s'éteignent selon le champ de lumière. */
  ceilingLights?: boolean;
  /** Faux pour les objets lumineux (sortie) : ils ne sont pas assombris par les zones éteintes. */
  zoneLighting?: boolean;
}

/**
 * Injecte l'effet VHS dans un matériau via `onBeforeCompile` (pas de post-processing
 * `EffectComposer`, non pris en charge nativement en WebXR) :
 * - aberration chromatique, grain animé, quantification des couleurs, teinte délavée
 * - zones sombres (champ de lumière) et extinction des néons du plafond
 */
export function applyVhsEffect(material: THREE.Material, options: VhsEffectOptions = {}): void {
  const ceilingLights = options.ceilingLights ?? false;
  const zoneLighting = options.zoneLighting ?? true;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS_GLSL}`)
      .replace("#include <displacementmap_vertex>", VERTEX_WORLD_GLSL);

    let fragment = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS_GLSL}`)
      .replace("#include <map_fragment>", `${FRAGMENT_SETUP_GLSL}\n${MAP_FRAGMENT_GLSL}`)
      .replace("#include <dithering_fragment>", FINAL_GLSL);
    if (ceilingLights) fragment = fragment.replace("#include <emissivemap_fragment>", CEILING_EMISSIVE_GLSL);
    if (zoneLighting) fragment = fragment.replace("#include <lights_fragment_maps>", ZONE_LIGHT_GLSL);
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => `vhs:${ceilingLights ? 1 : 0}${zoneLighting ? 1 : 0}`;
  material.needsUpdate = true;
}
