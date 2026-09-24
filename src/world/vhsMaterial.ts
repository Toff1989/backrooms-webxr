import * as THREE from "three";
import { CELL_SIZE } from "../shared/constants";
import { VHS_LIGHT_FIELD_GLSL, type LightFieldParams } from "./lightField";
import { getVhsNoiseTexture } from "./vhsNoiseTexture";

/** Nombre max de zones de glitch envoyées au shader (les plus proches du joueur). */
export const MAX_GLITCH_ZONES = 8;

/** Éclairage ambiant résiduel dans une zone éteinte (proche du noir : lampe torche nécessaire). */
const DARK_ZONE_AMBIENT = 0.035;

/**
 * Uniformes partagés par tous les matériaux VHS : un seul objet mutable référencé par
 * chaque shader compilé, pas besoin de garder une liste de shaders à mettre à jour.
 */
const sharedUniforms = {
  uTime: { value: 0 },
  /** Intensité de corruption visuelle cumulable des glitchs (étape 5). */
  uCorruption: { value: 0 },
  /** Zones de glitch : xyz = centre monde, w = rayon. */
  uGlitchA: { value: Array.from({ length: MAX_GLITCH_ZONES }, () => new THREE.Vector4()) },
  /** Zones de glitch : x = intensité, y = seed, z = type (0 corruption, 1 téléporteur, 2 fantôme). */
  uGlitchB: { value: Array.from({ length: MAX_GLITCH_ZONES }, () => new THREE.Vector4()) },
  uGlitchCount: { value: 0 },
  uVhsNoise: { value: null as THREE.Texture | null },
  uLightSeed: { value: new THREE.Vector2() },
  uDarkThreshold: { value: 0 },
};

export function updateVhsTime(elapsedSeconds: number): void {
  sharedUniforms.uTime.value = elapsedSeconds;
}

export function setVhsCorruption(intensity: number): void {
  sharedUniforms.uCorruption.value = THREE.MathUtils.clamp(intensity, 0, 1);
}

export function setLightField(params: LightFieldParams): void {
  sharedUniforms.uLightSeed.value.set(params.seedX, params.seedY);
  sharedUniforms.uDarkThreshold.value = params.threshold;
}

export interface ShaderGlitchZone {
  x: number;
  y: number;
  z: number;
  radius: number;
  intensity: number;
  seed: number;
  kind: number;
}

export function setGlitchZones(zones: readonly ShaderGlitchZone[]): void {
  const count = Math.min(zones.length, MAX_GLITCH_ZONES);
  for (let i = 0; i < count; i++) {
    const zone = zones[i]!;
    sharedUniforms.uGlitchA.value[i]!.set(zone.x, zone.y, zone.z, zone.radius);
    sharedUniforms.uGlitchB.value[i]!.set(zone.intensity, zone.seed, zone.kind, 0);
  }
  sharedUniforms.uGlitchCount.value = count;
}

const COMMON_GLSL = /* glsl */ `
  #define VHS_MAX_GLITCH_ZONES ${MAX_GLITCH_ZONES}
  uniform float uTime;
  uniform float uCorruption;
  uniform vec4 uGlitchA[ VHS_MAX_GLITCH_ZONES ];
  uniform vec4 uGlitchB[ VHS_MAX_GLITCH_ZONES ];
  uniform int uGlitchCount;
  varying vec3 vVhsWorldPos;
  varying vec3 vVhsWorldNormal;
  varying float vVhsZoneLight;

  float vhsHash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  float vhsHash13( vec3 p3 ) {
    p3 = fract( p3 * 0.1031 );
    p3 += dot( p3, p3.zyx + 31.32 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  // Zone de glitch la plus influente à cette position (0 = aucune). Les fantômes (type 2)
  // sont des plaques localisées en hauteur sur les murs ; les pièges couvrent toute la
  // colonne (sol, murs proches, plafond) : la pièce entière se déchire à cet endroit.
  float vhsGlitchInfluence( vec3 wp, out vec4 zoneA, out vec4 zoneB ) {
    float best = 0.0;
    zoneA = vec4( 0.0 );
    zoneB = vec4( 0.0 );
    for ( int i = 0; i < VHS_MAX_GLITCH_ZONES; i++ ) {
      if ( i >= uGlitchCount ) break;
      vec4 a = uGlitchA[ i ];
      vec4 b = uGlitchB[ i ];
      float d = length( wp.xz - a.xz );
      float f = ( 1.0 - smoothstep( a.w * 0.2, a.w, d ) ) * b.x;
      if ( b.z > 1.5 ) f *= 1.0 - smoothstep( 0.35, 1.1, abs( wp.y - a.y ) );
      if ( f > best ) { best = f; zoneA = a; zoneB = b; }
    }
    return best;
  }

  // Coordonnées 2D "dans le plan" de la surface (sol/plafond : XZ, murs : horizontale/hauteur),
  // pour que les déchirures suivent les lignes de balayage VHS quelle que soit l'orientation.
  vec2 vhsSurfaceCoords( vec3 wp, vec3 n ) {
    if ( abs( n.y ) > 0.5 ) return wp.xz;
    return vec2( abs( n.z ) > abs( n.x ) ? wp.x : wp.z, wp.y );
  }
`;

const VERTEX_PARS_GLSL = /* glsl */ `
  ${COMMON_GLSL}
  ${VHS_LIGHT_FIELD_GLSL}
`;

/** Tremblement des sommets dans une zone de glitch : la géométrie elle-même se froisse. */
const VERTEX_GLITCH_GLSL = /* glsl */ `
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
    vec4 zoneA;
    vec4 zoneB;
    float glitch = vhsGlitchInfluence( vhsWorld.xyz, zoneA, zoneB );
    if ( glitch > 0.02 ) {
      float jitterStep = floor( uTime * ( 7.0 + zoneB.y * 9.0 ) );
      float jitter = vhsHash13( floor( vhsWorld.xyz * 3.0 ) + jitterStep + zoneB.y * 91.0 ) - 0.5;
      float amount = ( zoneB.z > 0.5 && zoneB.z < 1.5 ) ? 0.14 : 0.07;
      transformed += objectNormal * jitter * amount * glitch;
      vhsWorld.xyz += normalize( mat3( modelMatrix ) * objectNormal ) * jitter * amount * glitch;
    }
    vVhsWorldPos = vhsWorld.xyz;
    // Champ de lumière évalué par sommet (il varie sur ~12 m) : bien moins cher que par pixel.
    vVhsZoneLight = vhsZoneLight( vhsWorld.xyz );
    vVhsWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
  }
`;

const FRAGMENT_PARS_GLSL = /* glsl */ `
  ${COMMON_GLSL}
  ${VHS_LIGHT_FIELD_GLSL}
  uniform sampler2D uVhsNoise;
`;

/**
 * Calcul du glitch pour ce fragment, avant l'échantillonnage de la texture : décalage d'UV
 * (déchirure horizontale, blocs arrachés), et masque des blocs remplacés par du bruit brut.
 */
const FRAGMENT_GLITCH_SETUP_GLSL = /* glsl */ `
  vec4 vhsZoneA;
  vec4 vhsZoneB;
  float vhsGlitch = vhsGlitchInfluence( vVhsWorldPos, vhsZoneA, vhsZoneB );
  vec2 vhsUvOffset = vec2( 0.0 );
  float vhsAberrationBoost = 0.0;
  float vhsReplace = 0.0;
  vec3 vhsReplaceColor = vec3( 0.0 );
  vec3 vhsGlow = vec3( 0.0 );
  float vhsScan = 0.0;
  vec3 vhsTint = vec3( 0.0 );

  if ( vhsGlitch > 0.01 ) {
    float seed = vhsZoneB.y;
    bool teleporter = vhsZoneB.z > 0.5 && vhsZoneB.z < 1.5;
    vec2 sp = vhsSurfaceCoords( vVhsWorldPos, normalize( vVhsWorldNormal ) );
    float fast = floor( uTime * ( 10.0 + seed * 14.0 ) );
    float slow = floor( uTime * ( 3.0 + seed * 4.0 ) );

    // Bord irrégulier : l'intensité varie par bandes (pas de disque propre, pas de damier).
    float edgeBand = floor( sp.y * 6.0 + slow );
    float m = clamp( vhsGlitch * ( 1.2 + vhsHash12( vec2( edgeBand, seed * 31.0 ) ) * 0.8 ) - 0.15, 0.0, 1.0 );

    if ( m > 0.0 ) {
      vec2 noiseUv = fract( sp * vec2( 0.9, 0.23 ) + vec2( fast * 0.173, slow * 0.291 ) );
      float noiseValue = texture2D( uVhsNoise, noiseUv ).r;

      // 1. Déchirure de balayage : bandes horizontales de hauteur variable, décalées
      // latéralement, avec dérive de chrominance et saut de luminosité (tracking VHS).
      float bandHeight = mix( 0.06, 0.35, vhsHash12( vec2( floor( sp.y * 3.0 ), slow + seed * 5.0 ) ) );
      float band = floor( sp.y / bandHeight + fast * 0.21 );
      float bandHash = vhsHash12( vec2( band, fast + seed * 13.0 ) );
      float torn = step( 0.62 - m * 0.4, bandHash );
      float shift = ( vhsHash12( vec2( band, fast * 1.7 + 3.0 ) ) - 0.5 );
      vhsUvOffset.x += torn * shift * ( 0.15 + m * 0.5 );
      vhsAberrationBoost = ( 0.01 + m * 0.03 ) * ( 1.0 + torn * 2.0 );

      // 2. Traînée de tête de lecture : dans certaines bandes, le texel se fige et s'étire
      // horizontalement (le motif du papier peint "coule" en lignes).
      float smear = step( 0.86 - m * 0.3, vhsHash12( vec2( band, slow * 3.1 + seed ) ) );
      if ( smear > 0.5 ) vhsUvOffset.x += ( floor( sp.x * 1.5 ) / 1.5 - sp.x ) * 0.9;

      // 3. Dropouts : traits fins horizontaux de neige blanche ou de noir, comme une bande abîmée.
      vec2 dropCell = floor( sp * vec2( 1.6, 38.0 ) + vec2( fast * 0.7, 0.0 ) );
      float dropHash = vhsHash12( dropCell + seed * 71.0 + fast * 0.13 );
      if ( dropHash > 0.955 - m * 0.12 ) {
        vhsReplace = 0.85;
        vhsReplaceColor = dropHash > 0.99 ? vec3( 0.02 ) : vec3( 0.55 + noiseValue * 0.5 );
      }

      // 4. Rares blocs arrachés : la texture est trouée, on voit la neige ou le vide derrière.
      vec2 blockId = floor( sp * vec2( 2.2, 3.5 ) + seed * 11.0 );
      float blockHash = vhsHash12( blockId + slow * 1.3 );
      if ( blockHash > 0.93 - m * 0.1 ) {
        vhsReplace = 1.0;
        vhsReplaceColor = blockHash > 0.975 ? vec3( 0.0 ) : vec3( noiseValue ) * vec3( 0.85, 0.9, 1.0 );
      }

      // 5. Barre de synchro qui défile + lignes de balayage + dérive de teinte par bande.
      float roll = fract( sp.y * 0.45 - uTime * ( 0.6 + seed * 0.5 ) );
      vhsScan = smoothstep( 0.0, 0.03, roll ) * ( 1.0 - smoothstep( 0.03, 0.08, roll ) ) * m;
      vhsScan += ( 0.5 + 0.5 * sin( sp.y * 260.0 + uTime * 40.0 ) ) * 0.18 * m;
      vhsTint = torn * vec3( shift * 0.25, -shift * 0.12, -shift * 0.2 ) * m;

      vhsGlow = vec3( noiseValue ) * 0.05 * m;

      if ( teleporter ) {
        // Téléporteur : la surface est aspirée en spirale vers un noyau noir qui grésille.
        vec2 toCenter = vVhsWorldPos.xz - vhsZoneA.xz;
        float d = length( toCenter ) / vhsZoneA.w;
        float swirl = ( 1.0 - d ) * ( 2.2 + sin( uTime * 1.3 ) * 0.8 );
        vhsUvOffset += vec2( cos( swirl ), sin( swirl ) ) * ( 1.0 - d ) * 0.35 * vhsGlitch;
        vhsAberrationBoost += 0.05 * ( 1.0 - d );
        float core = 1.0 - smoothstep( 0.12, 0.45, d );
        float sparkle = step( 0.88, noiseValue );
        vhsReplace = max( vhsReplace, core );
        vhsReplaceColor = mix( vhsReplaceColor, vec3( 0.2, 0.7, 0.85 ) * sparkle * noiseValue, core );
        vhsGlow += vec3( 0.05, 0.3, 0.38 ) * noiseValue * ( 1.0 - d ) * vhsGlitch * ( 0.6 + 0.4 * sin( uTime * 5.0 ) );
      }
    }
  }
`;

const MAP_FRAGMENT_GLSL = /* glsl */ `
  #ifdef USE_MAP
    vec2 vhsUv = vMapUv + vhsUvOffset;
    vec2 vhsAberration = ( vMapUv - 0.5 ) * ( 0.004 + uCorruption * 0.012 ) + vec2( vhsAberrationBoost, vhsAberrationBoost * 0.3 );
    vec4 sampledDiffuseColor;
    sampledDiffuseColor.r = texture2D( map, vhsUv - vhsAberration ).r;
    sampledDiffuseColor.g = texture2D( map, vhsUv ).g;
    sampledDiffuseColor.b = texture2D( map, vhsUv + vhsAberration ).b;
    sampledDiffuseColor.a = texture2D( map, vhsUv ).a;
    diffuseColor *= sampledDiffuseColor;
  #endif
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
    totalEmissiveRadiance *= lamp;
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

  gl_FragColor.rgb = mix( gl_FragColor.rgb, vhsReplaceColor, vhsReplace );
  gl_FragColor.rgb += vhsGlow + vhsTint;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * 0.35 + vec3( 0.12 ), vhsScan * 0.6 );

  float vhsGrain = ( fract( sin( dot( gl_FragCoord.xy + uTime * 60.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453123 ) - 0.5 ) * ( 0.05 + uCorruption * 0.15 + vhsGlitch * 0.2 );
  gl_FragColor.rgb += vhsGrain;

  float vhsLevels = mix( 24.0, 10.0, max( uCorruption, vhsGlitch * 0.8 ) );
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
 * - glitchs intégrés à la surface elle-même (déchirures de balayage, blocs arrachés,
 *   trous de bruit vidéo, tremblement des sommets) autour des zones de glitch actives
 * - zones sombres (champ de lumière) et extinction des néons du plafond
 */
export function applyVhsEffect(material: THREE.Material, options: VhsEffectOptions = {}): void {
  const ceilingLights = options.ceilingLights ?? false;
  const zoneLighting = options.zoneLighting ?? true;
  material.onBeforeCompile = (shader) => {
    // Paresseux : la vidéo de bruit n'est créée qu'à la première compilation (rendu réel).
    sharedUniforms.uVhsNoise.value ??= getVhsNoiseTexture();
    Object.assign(shader.uniforms, sharedUniforms);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS_GLSL}`)
      .replace("#include <displacementmap_vertex>", VERTEX_GLITCH_GLSL);

    let fragment = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS_GLSL}`)
      .replace("#include <map_fragment>", `${FRAGMENT_GLITCH_SETUP_GLSL}\n${MAP_FRAGMENT_GLSL}`)
      .replace("#include <dithering_fragment>", FINAL_GLSL);
    if (ceilingLights) fragment = fragment.replace("#include <emissivemap_fragment>", CEILING_EMISSIVE_GLSL);
    if (zoneLighting) fragment = fragment.replace("#include <lights_fragment_maps>", ZONE_LIGHT_GLSL);
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => `vhs:${ceilingLights ? 1 : 0}${zoneLighting ? 1 : 0}`;
  material.needsUpdate = true;
}
