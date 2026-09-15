import { BoxGeometry, ExtrudeGeometry, Group, InstancedBufferAttribute, InstancedMesh, Mesh, MeshBasicMaterial, Object3D, RingGeometry, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, Shape } from 'three'
import type { Texture } from 'three'
import type { TownMaterials } from './townMaterials'
import { MOAT, MOAT_STAIRS } from '#shared/utils/moat'
import type { FountainInteractor } from './fountainWater'
import { FORTIFICATIONS, isInMoat } from '#shared/utils/courtyard'

/** Cosmetic moat and bridge. Traversal and banks are defined by the shared world. */
export function createCityMoat(stoneMap: Texture, materials: TownMaterials) {
  const f = FORTIFICATIONS
  const group = new Group()
  group.name = 'city-moat'
  const geometries = new Set<BoxGeometry | PlaneGeometry | ExtrudeGeometry>()
  const time = { value: 0 }
  const stone = new MeshStandardMaterial({ color: '#a8b3ad', map: stoneMap, roughness: 0.92 })
  const coping = new MeshStandardMaterial({ color: '#c4c9b9', map: stoneMap, roughness: 0.86 })
  const wetStone = new MeshStandardMaterial({ color: '#657e71', roughness: 0.94 })
  const bed = new MeshStandardMaterial({ color: '#64816c', roughness: 1 })
  for (const material of [stone, coping, wetStone]) materials.apply(material, 'stone', 1.1, 0.5, material === coping)
  materials.apply(bed, 'earth', 1.2, 0.35)
  const water = new MeshPhysicalMaterial({
    color: '#369b98', roughness: 0.18, metalness: 0,
    transparent: true, opacity: 0.76, depthWrite: false,
    ior: 1.333, clearcoat: 0.75, clearcoatRoughness: 0.2,
    envMapIntensity: 1.1,
  })
  water.onBeforeCompile = (shader) => {
    shader.uniforms.moatTime = time
    shader.vertexShader = `uniform float moatTime;\nvarying vec3 moatPosition;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        moatPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        transformed.z += sin(moatPosition.x * 1.5 + moatTime * 1.1) * 0.016
          + sin(moatPosition.z * 2.1 - moatTime * 0.85) * 0.012;`)
    shader.fragmentShader = `uniform float moatTime;\nvarying vec3 moatPosition;\n${shader.fragmentShader}`
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 rippleNormal = normalize(vec3(
          -0.045 * cos(moatPosition.x * 1.5 + moatTime * 1.1)
            -0.018 * cos(dot(moatPosition.xz, vec2(4.2, 2.8)) + moatTime * 1.8),
          1.0,
          -0.036 * cos(moatPosition.z * 2.1 - moatTime * 0.85)
            -0.012 * cos(dot(moatPosition.xz, vec2(4.2, 2.8)) + moatTime * 1.8)
        ));
        normal = normalize((viewMatrix * vec4(rippleNormal, 0.0)).xyz);
        nonPerturbedNormal = normal;`)
  }
  water.customProgramCacheKey = () => 'city-moat-ripples-v1'

  function block(x: number, y: number, z: number, width: number, height: number, depth: number, material = stone) {
    const geometry = new BoxGeometry(width, height, depth)
    geometries.add(geometry)
    const mesh = new Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }
  function surface(x: number, z: number, width: number, depth: number) {
    const geometry = new PlaneGeometry(width, depth, Math.ceil(width * 2), Math.ceil(depth * 2))
    geometries.add(geometry)
    const mesh = new Mesh(geometry, water)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, MOAT.waterHeight, z)
    mesh.receiveShadow = true
    mesh.renderOrder = 1
    group.add(mesh)
    block(x, MOAT.floorHeight - 0.1, z, width, 0.2, depth, bed)
  }
  const outerLength = f.moatOuterMax - f.moatOuterMin
  const innerLength = f.moatInnerMax - f.moatInnerMin
  const center = (f.moatOuterMax + f.moatOuterMin) / 2
  const channel = f.moatInnerMin - f.moatOuterMin
  surface(center, f.moatOuterMin + channel / 2, outerLength, channel)
  surface(center, f.moatOuterMax - channel / 2, outerLength, channel)
  surface(f.moatOuterMin + channel / 2, center, channel, innerLength)
  surface(f.moatOuterMax - channel / 2, center, channel, innerLength)

  function bank(x: number, y: number, z: number, width: number, height: number, depth: number, material: MeshStandardMaterial) {
    if (z > f.moatOuterMax - 0.5 && z < f.moatOuterMax + 0.5 && width > MOAT_STAIRS.width) {
      const left = MOAT_STAIRS.x - MOAT_STAIRS.width / 2
      const right = MOAT_STAIRS.x + MOAT_STAIRS.width / 2
      const min = x - width / 2
      const max = x + width / 2
      block((min + left) / 2, y, z, left - min, height, depth, material)
      block((right + max) / 2, y, z, max - right, height, depth, material)
    }
    else block(x, y, z, width, height, depth, material)
  }
  // Limestone courses meet the terrain at zero, with darker stone below the waterline.
  for (const [min, max, inward] of [
    [f.moatInnerMin, f.moatInnerMax, 1],
    [f.moatOuterMin, f.moatOuterMax, -1],
  ] as const) {
    const length = max - min
    for (let row = 0; row < 4; row++) {
      const y = -2.1 + row * 0.6
      const material = row < 2 ? wetStone : stone
      for (const side of [min, max]) {
        const offset = side === min ? inward * 0.18 : -inward * 0.18
        bank(center, y, side + offset, length, 0.58, 0.36, material)
        block(side + offset, y, center, 0.36, 0.58, length, material)
      }
    }
    for (const side of [min, max]) {
      const offset = side === min ? inward * 0.25 : -inward * 0.25
      bank(center, -0.08, side + offset, length, 0.16, 0.5, coping)
      block(side + offset, -0.08, center, 0.5, 0.16, length, coping)
    }
  }

  // A recessed stone stair returns to the outer meadow through the bank.
  const stair = MOAT_STAIRS
  const tread = (stair.zEnd - stair.zStart) / stair.steps
  for (let i = 0; i < stair.steps; i++) {
    const top = MOAT.floorHeight * (1 - (i + 1) / stair.steps)
    const height = top - MOAT.floorHeight + 0.12
    block(stair.x, MOAT.floorHeight - 0.12 + height / 2, stair.zStart + (i + 0.5) * tread, stair.width, height, tread, coping)
  }
  for (const sign of [-1, 1]) {
    block(stair.x + sign * (stair.width / 2 + 0.15), MOAT.floorHeight / 2, (stair.zStart + stair.zEnd) / 2, 0.3, -MOAT.floorHeight, stair.zEnd - stair.zStart, stone)
  }

  const bridgeLength = f.bridgeEnd - f.bridgeStart
  const bridgeCenter = (f.bridgeStart + f.bridgeEnd) / 2
  block(f.gateX, -0.15, bridgeCenter, f.bridgeWidth, 0.3, bridgeLength, coping)
  for (const sign of [-1, 1]) {
    const x = f.gateX + sign * (f.bridgeWidth / 2 - 0.175)
    block(x, 0.28, bridgeCenter, 0.35, 0.56, bridgeLength)
    block(x, 0.605, bridgeCenter, 0.35, 0.09, bridgeLength, coping)
    for (let i = 0; i <= 3; i++) {
      block(x, 0.33, f.bridgeStart + i * bridgeLength / 3, 0.35, 0.66, 0.5, coping)
    }
    // Three open arches expose the flowing channel beneath the bridge.
    const span = bridgeLength / 3
    for (let i = 0; i < 3; i++) {
      const shape = new Shape()
      shape.moveTo(0, -0.3)
      shape.lineTo(span, -0.3)
      shape.lineTo(span, -2.4)
      shape.lineTo(span - 0.4, -2.4)
      shape.lineTo(span - 0.4, -1.65)
      shape.bezierCurveTo(span - 0.4, -0.35, 0.4, -0.35, 0.4, -1.65)
      shape.lineTo(0.4, -2.4)
      shape.lineTo(0, -2.4)
      shape.closePath()
      const geometry = new ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false, curveSegments: 12 })
      geometries.add(geometry)
      const mesh = new Mesh(geometry, stone)
      mesh.rotation.y = -Math.PI / 2
      mesh.position.set(x + 0.25, 0, f.bridgeStart + i * span)
      mesh.castShadow = mesh.receiveShadow = true
      group.add(mesh)
    }
  }
  const rippleGeometry = new RingGeometry(0.86, 1, 32)
  const opacity = new InstancedBufferAttribute(new Float32Array(32), 1)
  rippleGeometry.setAttribute('rippleOpacity', opacity)
  const rippleMaterial = new MeshBasicMaterial({ color: '#d2f1e4', transparent: true, depthWrite: false })
  rippleMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float rippleOpacity; varying float vRippleOpacity;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRippleOpacity = rippleOpacity;')
    shader.fragmentShader = `varying float vRippleOpacity;\n${shader.fragmentShader}`
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vRippleOpacity;\n#include <opaque_fragment>')
  }
  const ripples = new InstancedMesh(rippleGeometry, rippleMaterial, 32)
  ripples.frustumCulled = false
  ripples.userData.waterRipple = true
  ripples.renderOrder = 2
  group.add(ripples)
  const waves: { x: number, z: number, start: number, strength: number }[] = []
  const swimmers = new Map<string, { x: number, z: number, last: number }>()
  const dummy = new Object3D()
  let cursor = 0
  let disposed = false
  let previousSeconds = 0
  return {
    group,
    /** `seconds` is the wrapped shader clock (see `courtyardScene.update`), so
     *  the wake timestamps have to survive it running backwards. */
    update(seconds: number, players: readonly FountainInteractor[] = []) {
      time.value = seconds
      if (seconds < previousSeconds) {
        waves.length = 0
        swimmers.clear()
      }
      previousSeconds = seconds
      const active = new Set<string>()
      for (const player of players) {
        if (!isInMoat(player.x, player.z) || player.feetY >= MOAT.waterHeight - 0.15) continue
        active.add(player.id)
        const previous = swimmers.get(player.id)
        const moving = previous && Math.hypot(player.x - previous.x, player.z - previous.z) > 0.008
        if (!previous || seconds - previous.last > (moving ? 0.25 : 0.9)) {
          waves[cursor++ % 32] = { x: player.x, z: player.z, start: seconds, strength: previous ? 0.35 : 0.7 }
          swimmers.set(player.id, { x: player.x, z: player.z, last: seconds })
        }
      }
      for (const id of swimmers.keys()) if (!active.has(id)) swimmers.delete(id)
      for (let i = 0; i < 32; i++) {
        const wave = waves[i]
        const age = wave ? (seconds - wave.start) / 1.2 : 2
        const visible = wave && age >= 0 && age < 1
        const radius = visible ? 0.18 + age * 0.8 : 0
        dummy.position.set(wave?.x ?? 0, MOAT.waterHeight + 0.035, wave?.z ?? 0)
        dummy.rotation.set(-Math.PI / 2, 0, 0)
        dummy.scale.setScalar(radius)
        dummy.updateMatrix()
        ripples.setMatrixAt(i, dummy.matrix)
        opacity.setX(i, visible ? wave.strength * (1 - age) ** 2 : 0)
      }
      ripples.instanceMatrix.needsUpdate = true
      opacity.needsUpdate = true
    },
    dispose() {
      if (disposed) return
      disposed = true
      ripples.dispose()
      rippleGeometry.dispose()
      rippleMaterial.dispose()
      geometries.forEach(geometry => geometry.dispose())
      for (const material of [stone, coping, wetStone, bed, water]) material.dispose()
      group.clear()
    },
  }
}
