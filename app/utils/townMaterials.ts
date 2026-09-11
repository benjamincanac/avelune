import { Mesh, MeshStandardMaterial } from 'three'
import type { Object3D } from 'three'
import { createMaterialTextures } from './materialTextures'

type Surface = 'stone' | 'plaster' | 'timber' | 'terracotta' | 'earth'

/** One texture bank per mounted world. World projection also covers GLBs without UVs. */
export function createTownMaterials() {
  const textures = createMaterialTextures()
  function apply(material: MeshStandardMaterial, family: Surface, scale = 0.8, strength = 0.4, paving = false) {
    const maps = textures[family]
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        townColor: { value: maps.map }, townNormal: { value: maps.normalMap },
        townRoughness: { value: maps.roughnessMap }, townPaving: { value: paving ? 1 : 0 }, townScale: { value: scale }, townRelief: { value: strength },
      })
      shader.vertexShader = `varying vec3 townPosition;\nvarying vec3 townWorldNormal;\n${shader.vertexShader}`
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vec4 townVertex = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            townVertex = instanceMatrix * townVertex;
          #endif
          townPosition = (modelMatrix * townVertex).xyz;
          townWorldNormal = inverseTransformDirection(transformedNormal, viewMatrix);
        `)
      shader.fragmentShader = `
        uniform sampler2D townColor;
        uniform sampler2D townNormal;
        uniform sampler2D townRoughness;
        uniform float townScale;
        uniform float townRelief;
        uniform float townPaving;
        varying vec3 townPosition;
        varying vec3 townWorldNormal;
        vec3 townWeights() {
          vec3 weights = pow(abs(normalize(townWorldNormal)), vec3(4.0));
          return weights / max(dot(weights, vec3(1.0)), 0.0001);
        }
        vec4 townSample(sampler2D tex, vec3 p, vec3 weights) {
          return texture2D(tex, p.zy) * weights.x
            + texture2D(tex, p.xz) * weights.y
            + texture2D(tex, p.xy) * weights.z;
        }
      ${shader.fragmentShader}`
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 townP = townPosition * townScale;
          vec3 townW = townWeights();
          vec3 pigment = townSample(townColor, townP, townW).rgb;
          // A broad second scale breaks up repetition without adding baked lighting.
          vec3 broadPigment = townSample(townColor, townP * 0.173 + 0.37, townW).rgb;
          diffuseColor.rgb *= pigment * mix(vec3(0.94), vec3(1.06), broadPigment);
          if (townPaving > 0.5 && townW.y > 0.7) {
            vec2 course = vec2((townPosition.x + mod(floor(townPosition.z / 0.8), 2.0) * 0.7) / 1.4, townPosition.z / 0.8);
            vec2 edge = min(fract(course), 1.0 - fract(course));
            float seam = smoothstep(0.012, 0.032, min(edge.x, edge.y));
            float blockShade = fract(sin(dot(floor(course), vec2(127.1, 311.7))) * 43758.5453);
            diffuseColor.rgb *= mix(0.57, 0.92 + blockShade * 0.14, seam);
          }
        `)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor * townSample(townRoughness, townP, townW).g, 0.25, 1.0);
        `)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          vec2 nx = texture2D(townNormal, townP.zy).xy * 2.0 - 1.0;
          vec2 ny = texture2D(townNormal, townP.xz).xy * 2.0 - 1.0;
          vec2 nz = texture2D(townNormal, townP.xy).xy * 2.0 - 1.0;
          vec3 detail = vec3(0.0, nx.y, nx.x) * townW.x
            + vec3(ny.x, 0.0, ny.y) * townW.y
            + vec3(nz.x, nz.y, 0.0) * townW.z;
          normal = normalize(normal + mat3(viewMatrix) * detail * townRelief);
        `)
    }
    material.customProgramCacheKey = () => 'avelune-world-material-v1'
    material.needsUpdate = true
    return material
  }
  function decorate(root: Object3D) {
    const visited = new Set<MeshStandardMaterial>()
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof MeshStandardMaterial) || visited.has(material)) continue
        visited.add(material)
        const name = material.name.toLowerCase()
        if (/plaster/.test(name)) apply(material, 'plaster', 0.65, 0.28)
        else if (/walnut|wood|bark|shutter/.test(name)) apply(material, 'timber', 0.85, 0.48)
        else if (/terracotta|clay/.test(name)) apply(material, 'terracotta', 1.5, 0.45)
        else if (/limestone|relief/.test(name)) apply(material, 'stone', 0.9, 0.45)
      }
    })
  }
  return {
    apply, decorate,
    dispose() {
      for (const maps of Object.values(textures)) {
        maps.map.dispose()
        maps.normalMap.dispose()
        maps.roughnessMap.dispose()
      }
    },
  }
}
export type TownMaterials = ReturnType<typeof createTownMaterials>
