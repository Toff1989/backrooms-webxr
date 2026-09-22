import * as THREE from "three";

/**
 * Uniformes partagés par tous les matériaux VHS : un seul objet mutable référencé par
 * chaque shader compilé, pas besoin de garder une liste de shaders à mettre à jour.
 */
const sharedUniforms = {
  uTime: { value: 0 },
  /** Intensité de corruption visuelle cumulable des glitchs (étape 5) — 0 = pas encore piloté. */
  uCorruption: { value: 0 },
};

export function updateVhsTime(elapsedSeconds: number): void {
  sharedUniforms.uTime.value = elapsedSeconds;
}

/** Réservé à l'étape 5 (glitchs) : distorsion visuelle cumulable, dissipée dans le temps. */
export function setVhsCorruption(intensity: number): void {
  sharedUniforms.uCorruption.value = THREE.MathUtils.clamp(intensity, 0, 1);
}

/**
 * Injecte l'effet VHS dans un matériau via `onBeforeCompile` (pas de post-processing
 * `EffectComposer`, non pris en charge nativement en WebXR) :
 * - aberration chromatique légère (échantillonnage RVB décalé de la texture)
 * - grain animé
 * - quantification des couleurs (palette dégradée)
 * - teinte jaunâtre délavée
 */
export function applyVhsEffect(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uCorruption = sharedUniforms.uCorruption;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime;
        uniform float uCorruption;`,
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec2 vhsAberration = ( vMapUv - 0.5 ) * ( 0.004 + uCorruption * 0.012 );
          vec4 sampledDiffuseColor;
          sampledDiffuseColor.r = texture2D( map, vMapUv - vhsAberration ).r;
          sampledDiffuseColor.g = texture2D( map, vMapUv ).g;
          sampledDiffuseColor.b = texture2D( map, vMapUv + vhsAberration ).b;
          sampledDiffuseColor.a = texture2D( map, vMapUv ).a;
          diffuseColor *= sampledDiffuseColor;
        #endif`,
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>

        float vhsGrain = ( fract( sin( dot( gl_FragCoord.xy + uTime * 60.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453123 ) - 0.5 ) * ( 0.05 + uCorruption * 0.15 );
        gl_FragColor.rgb += vhsGrain;

        float vhsLevels = mix( 24.0, 10.0, uCorruption );
        gl_FragColor.rgb = floor( gl_FragColor.rgb * vhsLevels + 0.5 ) / vhsLevels;

        gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * vec3( 1.08, 1.0, 0.82 ), 0.35 );`,
      );
  };
  material.needsUpdate = true;
}
