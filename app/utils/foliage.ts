import { IcosahedronGeometry, InstancedMesh, MeshBasicMaterial, Vector3 } from 'three'
import type { BufferGeometry, MeshStandardMaterial, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three'

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

/**
 * A crown's stand-in for the shadow pass.
 *
 * Leaf cards are the dearest thing a cascade can draw: over a million triangles
 * in a busy view, every one through an alpha-tested depth material, which costs
 * a tiled GPU its hidden-surface removal. Taking them out of the shadow pass was
 * worth ten frames a second in the town, far more than their share of the
 * triangles. So the cards cast nothing, and an eighty-triangle ellipsoid fitted
 * to them casts in their place through the plain depth material. At the
 * cascades' resolution a crown's shadow was already a soft blot.
 *
 * The stand-in writes neither colour nor depth, so the main pass draws nothing
 * for it, and it is `gtaoExclude` because the occlusion pass overrides materials
 * and would draw it solid. It shares the batch's instance matrices rather than
 * copying them.
 */
const CANOPY_FILL = 0.82
/** Anything shorter casts nothing at all: a fern's shadow is contact shading. */
const CANOPY_MIN_HEIGHT = 1.2
const canopyMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false })
const canopyShapes = new WeakMap<BufferGeometry, BufferGeometry>()
const canopySize = new Vector3()
const canopyCentre = new Vector3()
const canopyScale = new Vector3()

export function createCanopyShadow(batch: InstancedMesh): InstancedMesh | null {
  const source = batch.geometry
  if (!source.boundingBox) source.computeBoundingBox()
  const box = source.boundingBox
  if (!box || !batch.count) return null
  box.getSize(canopySize)
  // The first instance stands for the batch: a kind is placed at one scale give
  // or take a little, and this only decides whether it is tall enough to bother.
  const e = batch.instanceMatrix.array
  canopyScale.set(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!), Math.hypot(e[8]!, e[9]!, e[10]!))
  if (Math.max(canopySize.x * canopyScale.x, canopySize.y * canopyScale.y, canopySize.z * canopyScale.z) < CANOPY_MIN_HEIGHT) return null
  let shape = canopyShapes.get(source)
  if (!shape) {
    box.getCenter(canopyCentre)
    shape = new IcosahedronGeometry(1, 1)
    shape.scale(canopySize.x / 2 * CANOPY_FILL, canopySize.y / 2 * CANOPY_FILL, canopySize.z / 2 * CANOPY_FILL)
    shape.translate(canopyCentre.x, canopyCentre.y, canopyCentre.z)
    canopyShapes.set(source, shape)
    // The shape lives as long as the leaves it was fitted to: a template reload
    // disposes those, and the cache is weak, so nothing else would free it.
    const fitted = shape
    const release = () => {
      source.removeEventListener('dispose', release)
      canopyShapes.delete(source)
      fitted.dispose()
    }
    source.addEventListener('dispose', release)
  }
  const canopy = new InstancedMesh(shape, canopyMaterial, batch.count)
  canopy.instanceMatrix = batch.instanceMatrix
  canopy.name = 'canopy shadow'
  canopy.castShadow = true
  canopy.receiveShadow = false
  canopy.userData.shadowTagged = true
  canopy.userData.gtaoExclude = true
  canopy.computeBoundingSphere()
  return canopy
}
