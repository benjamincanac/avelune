import type { MeshStandardMaterial, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three'

/**
 * Wind sway and backlit translucency for the nature kit's alpha-cut cards.
 *
 * The kit's leaves, ferns, flowers and bark all ship as `alphaMode: MASK`
 * geometry, so callers select them with `material.alphaTest > 0`.
 *
 * The sun direction is a fixed high, slightly south-east vector rather than the
 * live directional light. Foliage batches are built once per floor and the
 * translucency is deliberately subtle, so threading the day/night sun through
 * every instanced batch would cost more than the term is worth; the wrap reads
 * as leaves catching the sky, not as a second key light.
 */
const SUN_DIRECTION = 'vec3(0.42, 0.66, 0.62)'

export function applyFoliage(material: MeshStandardMaterial, time: { value: number }): MeshStandardMaterial {
  if (material.userData.foliageShader) return material
  material.userData.foliageShader = true
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey
  material.onBeforeCompile = function (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) {
    // Chain: the town pigment shader (or any other hook) still owns its own
    // injections; three only keeps one callback per material.
    previous?.call(this, shader, renderer)
    shader.uniforms.foliageTime = time
    shader.vertexShader = `uniform float foliageTime;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Phase comes from the instance origin so a whole crown leans as one
        // piece instead of every card fluttering independently.
        vec3 foliageOrigin = vec3(0.0);
        #ifdef USE_INSTANCING
          foliageOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif
        float foliageGust = sin(foliageTime * 0.55 - foliageOrigin.x * 0.11 - foliageOrigin.z * 0.08);
        float foliageBreeze = sin(foliageTime * 1.35 + foliageOrigin.x * 0.31 + foliageOrigin.z * 0.23);
        // Amplitude is a fraction of local height, so it survives the very
        // different instance scales the kit is placed at.
        float foliageAmp = max(position.y, 0.0) * 0.03;
        transformed.x += (foliageGust * 0.7 + foliageBreeze * 0.3) * foliageAmp;
        transformed.z += (cos(foliageTime * 1.1 + foliageOrigin.z * 0.29) * 0.6 + foliageGust * 0.4) * foliageAmp * 0.65;
        transformed.y += sin(foliageTime * 3.1 + position.x * 5.5 + position.z * 4.7) * foliageAmp * 0.14;
      `)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // Cards are flat quads, so the wrap fires wherever the sun sits behind
        // the surface; tinting by the card's own albedo keeps bark quiet.
        vec3 foliageSun = normalize((viewMatrix * vec4(${SUN_DIRECTION}, 0.0)).xyz);
        float foliageBack = max(dot(-normal, foliageSun), 0.0);
        totalEmissiveRadiance += diffuseColor.rgb * vec3(0.62, 0.78, 0.30) * pow(foliageBack, 1.7) * 0.55;
      `)
  }
  material.customProgramCacheKey = function () {
    return `avelune-foliage-v1|${previousKey ? previousKey.call(this) : ''}`
  }
  material.needsUpdate = true
  return material
}
