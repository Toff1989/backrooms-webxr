import * as THREE from "three";
import { CELL_SIZE, WALL_HEIGHT } from "../shared/constants";
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
  uExitCell: { value: new THREE.Vector2() },
  /** Décrépitude (0..1) : croît avec la profondeur. */
  uDecay: { value: 0 },
  /** Teinte globale du niveau (dérive du jaune vers un vert malade, puis un gris froid). */
  uLevelTint: { value: new THREE.Color(1, 1, 1) },
  uDesaturate: { value: 0 },
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

export function setLightField(params: LightFieldParams): void {
  sharedUniforms.uLightSeed.value.set(params.seedX, params.seedY);
  sharedUniforms.uDarkThreshold.value = params.threshold;
  sharedUniforms.uExitCell.value.set(params.exitCellX, params.exitCellZ);
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
      // La surface respire (ondulation lente et continue), elle ne "saute" pas par blocs.
      float swell = vhsValueNoise( vhsWorld.xz * 1.3 + vhsWorld.y * 0.9 + uTime * 0.6 + zoneB.y * 30.0 ) - 0.5;
      float amount = ( zoneB.z > 0.5 && zoneB.z < 1.5 ) ? 0.09 : 0.045;
      transformed += objectNormal * swell * amount * glitch;
      vhsWorld.xyz += normalize( mat3( modelMatrix ) * objectNormal ) * swell * amount * glitch;
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

/**
 * Calcul du glitch pour ce fragment, avant l'échantillonnage de la texture : décalage d'UV
 * (déchirure horizontale, blocs arrachés), et masque des blocs remplacés par du bruit brut.
 */
const FRAGMENT_GLITCH_SETUP_GLSL = /* glsl */ `
  vec4 vhsZoneA;
  vec4 vhsZoneB;
  float vhsGlitch = vhsGlitchInfluence( vVhsWorldPos, vhsZoneA, vhsZoneB );
  // Sorties du glitch, consommées par l'échantillonnage de la texture puis la couleur finale.
  vec2 vhsUvOffset = vec2( 0.0 );
  float vhsGhost = 0.0;
  vec2 vhsGhostOffset = vec2( 0.0 );
  float vhsDrip = 0.0;
  vec2 vhsDripShift = vec2( 0.0 );
  float vhsDarken = 0.0;
  float vhsTearLine = 0.0;
  float vhsBand = 0.0;
  float vhsVoid = 0.0;
  float vhsSpeck = 0.0;
  float vhsMissingTile = 0.0;

  if ( vhsGlitch > 0.01 ) {
    float seed = vhsZoneB.y;
    bool teleporter = vhsZoneB.z > 0.5 && vhsZoneB.z < 1.5;
    vec2 sp = vhsSurfaceCoords( vVhsWorldPos, normalize( vVhsWorldNormal ) );
    // Temps saccadé à 12 images/s pour la déformation : l'effet "saute" comme une bande lue
    // avec un mauvais tracking, au lieu de glisser comme un filtre numérique.
    float tape = floor( uTime * 12.0 ) / 12.0;

    // Masque organique qui respire (bruit de valeur), jamais de damier ni de disque net.
    float breath = vhsValueNoise( sp * 1.6 + seed * 37.0 + vec2( 0.0, uTime * 0.3 ) );
    float m = smoothstep( 0.15, 0.85, vhsGlitch * 1.35 - 0.3 + breath * 0.55 );

    if ( m > 0.001 ) {
      // 1. Ondulation de balayage : la texture ondule horizontalement selon la hauteur.
      float wobble = sin( sp.y * ( 8.0 + seed * 6.0 ) + tape * 6.0 ) * 0.6 + sin( sp.y * 31.0 - tape * 11.0 ) * 0.25;
      vhsUvOffset.x += wobble * 0.03 * m;

      // 2. Glissement de tracking : par à-coups, toute la zone se décale d'un bloc.
      float slipTime = floor( uTime * 3.0 + seed * 5.0 );
      float slip = step( 0.72, vhsHash12( vec2( slipTime, seed * 17.0 ) ) );
      vhsUvOffset.x += slip * ( vhsHash12( vec2( slipTime, 3.0 + seed ) ) - 0.5 ) * 0.3 * m;

      // 3. Image fantôme (bavure chroma VHS) : la texture est dédoublée, décalée, rouge/cyan.
      vhsGhost = 0.8 * m;
      vhsGhostOffset = vec2( 0.03 + 0.06 * m, 0.0 );

      // 3b. Bandes de tracking qui défilent : dans chaque bande, la texture s'étire en traînées
      // horizontales et s'éclaircit (lisible même sur une moquette uniforme).
      for ( int k = 0; k < 2; k++ ) {
        float fk = float( k );
        float speed = 0.25 + vhsHash12( vec2( seed * 7.0, fk ) ) * 0.35;
        float center = fract( uTime * speed + seed + fk * 0.5 ) * 3.2 - 0.3;
        float thickness = 0.05 + 0.12 * vhsHash12( vec2( floor( uTime * 2.0 ), fk + seed ) );
        float along = abs( fract( sp.y / 3.2 ) * 3.2 - center );
        vhsBand = max( vhsBand, ( 1.0 - smoothstep( thickness * 0.6, thickness, along ) ) * m );
      }

      // 4. Coulures : des colonnes fines de texture s'étirent vers le bas, comme de la cire.
      float column = floor( sp.x / 0.04 + seed * 11.0 );
      float columnHash = vhsHash12( vec2( column, seed * 13.0 ) );
      if ( columnHash > 1.0 - 0.3 * m ) {
        float flow = 0.5 + 0.5 * sin( uTime * ( 0.4 + columnHash ) + column );
        vhsDrip = smoothstep( 0.2, 0.9, m );
        vhsDripShift = vec2( 0.0, ( 0.1 + columnHash * 0.5 ) * flow * m );
      }

      // 5. Ligne de tracking : un trait fin, clair et bruité qui traverse la zone.
      float lineHeight = fract( vhsHash12( vec2( floor( uTime * 2.0 ), seed * 29.0 ) ) + uTime * 0.25 ) * 3.0;
      vhsTearLine = ( 1.0 - smoothstep( 0.0, 0.012, abs( fract( sp.y / 3.0 ) * 3.0 - lineHeight ) ) ) * m;

      vhsDarken = 0.45 * m;

      if ( teleporter ) {
        // Téléporteur : la texture tourne en vortex (continu, pas saccadé) vers un noyau noir
        // où grésillent quelques flocons de neige.
        vec2 toCenter = vVhsWorldPos.xz - vhsZoneA.xz;
        float d = length( toCenter ) / vhsZoneA.w;
        float twist = pow( max( 0.0, 1.0 - d ), 2.0 ) * ( 3.0 + sin( uTime * 0.7 ) );
        float angle = twist + uTime * 0.5 * ( 1.0 - d );
        vec2 rotated = vec2( cos( angle ) * toCenter.x - sin( angle ) * toCenter.y, sin( angle ) * toCenter.x + cos( angle ) * toCenter.y );
        vhsUvOffset += ( rotated - toCenter ) / ${CELL_SIZE.toFixed(2)};
        vhsVoid = 1.0 - smoothstep( 0.08, 0.42, d );
        vec2 noiseUv = fract( sp * 0.6 + vec2( floor( uTime * 15.0 ) * 0.173, uTime * 0.21 ) );
        vhsSpeck = step( 0.9, texture2D( uVhsNoise, noiseUv ).r ) * vhsVoid;
        vhsGhost = max( vhsGhost, 0.7 * ( 1.0 - d ) );
      }
    }
  }
`;

const MAP_FRAGMENT_GLSL = /* glsl */ `
  #ifdef USE_MAP
    vec2 vhsUv = vMapUv + vhsUvOffset;
    // Bande de tracking : coordonnée horizontale écrasée -> traînées étirées.
    vhsUv.x = mix( vhsUv.x, floor( vhsUv.x * 3.0 ) / 3.0 + fract( vhsUv.x * 3.0 ) * 0.04, vhsBand );
    vec2 vhsAberration = ( vMapUv - 0.5 ) * ( 0.004 + uCorruption * 0.012 );
    vec4 sampledDiffuseColor;
    sampledDiffuseColor.r = texture2D( map, vhsUv - vhsAberration ).r;
    sampledDiffuseColor.g = texture2D( map, vhsUv ).g;
    sampledDiffuseColor.b = texture2D( map, vhsUv + vhsAberration ).b;
    sampledDiffuseColor.a = texture2D( map, vhsUv ).a;
    if ( vhsDrip > 0.0 ) {
      // Coulure : le texel d'un peu plus haut est étiré vers le bas.
      sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, texture2D( map, vhsUv + vhsDripShift ).rgb, vhsDrip );
    }
    if ( vhsGhost > 0.0 ) {
      vec3 ghostRed = texture2D( map, vhsUv + vhsGhostOffset ).rgb * vec3( 1.0, 0.35, 0.3 );
      vec3 ghostCyan = texture2D( map, vhsUv - vhsGhostOffset ).rgb * vec3( 0.3, 0.8, 1.0 );
      sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, ( ghostRed + ghostCyan ) * 0.75, vhsGhost * 0.45 );
    }
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

  // Glitch : zone assombrie et délavée, trait de tracking, noyau noir des téléporteurs.
  float vhsLuma = dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( vhsLuma ) * 0.7, vhsDarken );
  float vhsFrameNoise = fract( sin( dot( gl_FragCoord.xy + floor( uTime * 30.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453123 );
  gl_FragColor.rgb += vhsTearLine * ( 0.25 + 0.5 * vhsFrameNoise );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * 1.35 + 0.06 + ( vhsFrameNoise - 0.5 ) * 0.12, vhsBand );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( vhsSpeck * 0.55 ), vhsVoid );

  float vhsGrain = ( fract( sin( dot( gl_FragCoord.xy + uTime * 60.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453123 ) - 0.5 ) * ( 0.05 + uCorruption * 0.15 + vhsGlitch * 0.08 );
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
