import { BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, MeshStandardMaterial, Object3D } from 'three'

/**
 * The meadow's grass.
 *
 * This file used to draw the whole decorative landscape — a single heightfield
 * mesh keyed to the town constants, with the nature kit scattered over it and
 * no collision behind any of it. The ground is now real chunk terrain
 * (`terrainChunk.ts`) and the trees are real chunk placements the server
 * seeds, so all that is left here is the one thing that stays purely cosmetic:
 * wind-blown tufts, instanced per chunk and per garden bed.
 */

/** Quaternius Stylized Nature MegaKit pieces (CC0), converted by
 *  scripts/convert_nature.sh into public/models/nature/. Variants share a
 *  prefix so a placement can pick among them per family. */
export const NATURE_NAMES = [
  'tree1', 'tree2', 'tree3', 'tree4', 'tree5',
  'bush1', 'bush2',
  'fern', 'clover', 'plant',
  'flowers1', 'flowers2',
  'rock1', 'rock2', 'rock3',
] as const

/** One tuft: where it stands, how tall, and which way it fans. */
export interface GrassBlade {
  x: number
  z: number
  y: number
  size: number
  angle: number
}

/**
 * A tuft of curved, tapered blades fanning outward, with a soft base-to-tip
 * gradient and coherent GPU wind. Geometry and material are shared by every
 * patch drawn from this bank, so a patch costs exactly one draw call and the
 * whole meadow compiles one program.
 */
export function createGrassBank(time: { value: number }) {
  const color = new Color()
  let seed = 57281
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const BLADES = 9
  const SEGMENTS = 3
  for (let blade = 0; blade < BLADES; blade++) {
    // Golden-angle spacing spreads the blades evenly; a small radial offset
    // keeps the tuft from pinching to a single spike at the root.
    const angle = blade * 2.399 + random() * 0.4
    const root = 0.02 + random() * 0.05
    const lean = 0.26 + random() * 0.3
    const length = 0.16 + random() * 0.17
    const width = 0.014 + random() * 0.012
    const base = positions.length / 3
    for (let segment = 0; segment <= SEGMENTS; segment++) {
      const t = segment / SEGMENTS
      for (const side of [-1, 1]) {
        const across = side * width * (1 - t * 0.95)
        const bend = root + lean * t * t
        positions.push(Math.cos(angle) * bend + Math.sin(angle) * across, t * length, Math.sin(angle) * bend - Math.cos(angle) * across)
        // Roots sit close to the terrain's own green so tufts don't read as
        // dark stars on the lawn; tips catch the light.
        color.set('#6a9a48').lerp(new Color('#cfe28a'), t * t)
        colors.push(color.r, color.g, color.b)
      }
      if (segment < SEGMENTS) {
        const k = base + segment * 2
        indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geometry.setIndex(indices)
  // Broad upward normals give the blades a continuous meadow response to
  // sunlight, avoiding alternating dark paper faces as the camera rotates.
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  const material = new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 1 })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.landscapeTime = time
    shader.vertexShader = `uniform float landscapeTime;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 grassOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float gust = sin(landscapeTime * 0.65 - grassOrigin.x * 0.13 - grassOrigin.z * 0.09);
        float breeze = sin(landscapeTime * 1.8 + grassOrigin.x * 0.65 + grassOrigin.z * 0.43) * 0.35 + gust * 0.65;
        transformed.x += breeze * position.y * position.y * 0.8;
        transformed.z += cos(landscapeTime + grassOrigin.z * 0.7) * position.y * position.y * 0.35;
      `)
  }
  material.customProgramCacheKey = () => 'courtyard-meadow-grass-v2'

  const dummy = new Object3D()
  return {
    /** One instanced patch. The caller owns removing and disposing it; the
     *  geometry and material stay with the bank. */
    patch(blades: readonly GrassBlade[]): InstancedMesh | null {
      if (!blades.length) return null
      const mesh = new InstancedMesh(geometry, material, blades.length)
      blades.forEach((blade, i) => {
        dummy.position.set(blade.x, blade.y, blade.z)
        dummy.rotation.set(0, blade.angle, 0)
        dummy.scale.setScalar(blade.size)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        const patch = 0.5 + 0.5 * Math.sin(blade.x * 0.61 + Math.cos(blade.z * 0.49))
        mesh.setColorAt(i, color.setRGB(0.74 + patch * 0.26, 0.86 + patch * 0.14, 0.68 + patch * 0.2))
      })
      mesh.receiveShadow = true
      // A whole meadow of blades in three cascades buys nothing, and the swayed
      // vertices are not in the depth material anyway.
      mesh.castShadow = false
      mesh.userData.shadowTagged = true
      // Blades are flat cards; GTAO's opaque normal override would occlude with
      // them as solid quads.
      mesh.userData.gtaoExclude = true
      mesh.computeBoundingSphere()
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.5
      return mesh
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

export type GrassBank = ReturnType<typeof createGrassBank>
