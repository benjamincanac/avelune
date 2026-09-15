import { BoxGeometry, CylinderGeometry, ExtrudeGeometry, Group, Mesh, Shape } from 'three'
import type { BufferGeometry, MeshStandardMaterial } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COURTYARD_ASSETS, FORTIFICATIONS } from '#shared/utils/courtyard'

type StonePalette = { stone: MeshStandardMaterial, trim: MeshStandardMaterial, dark: MeshStandardMaterial, blue: MeshStandardMaterial, gold: MeshStandardMaterial }

/** Templates share the dimensions of the shared colliders. The curtain wall and
 * bastion are solid; the gallery deck, its stairs and its rails are authored
 * placements too, so the world editor moves them like any other prop. */
export function createFortificationAssets(palette: StonePalette) {
  const { stone, trim, dark, blue, gold } = palette
  function add(group: Group, geometry: BufferGeometry, material: MeshStandardMaterial, x: number, y: number, z: number) {
    const mesh = new Mesh(geometry, material)
    mesh.position.set(x, y, z)
    group.add(mesh)
    return mesh
  }
  function box(group: Group, w: number, h: number, d: number, x: number, y: number, z: number, material = stone) {
    return add(group, new BoxGeometry(w, h, d), material, x, y, z)
  }
  const wall = new Group()
  box(wall, 4, 6, 2, 0, 3, 0)
  box(wall, 4, 0.5, 2.35, 0, 0.25, 0, trim)
  box(wall, 4, 0.2, 2.16, 0, 4.95, 0, trim)
  box(wall, 4, 0.26, 2.4, 0, 5.87, 0, trim)
  for (const side of [-1, 1]) {
    // Recessed mortar joints and alternating lengths make the wall read as masonry.
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 4; col++) {
        const width = col === 0 && row % 2 ? 0.45 : col === 3 && row % 2 ? 1.45 : 0.95
        const x = row % 2 ? [-1.75, -1, 0, 1.25][col]! : col - 1.5
        box(wall, width, 0.47, 0.065, x, 0.78 + row * 0.5, side * 1.025, row % 4 === 0 ? trim : stone)
      }
    }
    box(wall, 4, 0.3, 0.42, 0, 6.06, side * 0.95, trim)
    for (const x of [-1.5, 0.5]) {
      box(wall, 0.92, 0.88, 0.58, x, 6.58, side * 0.94)
      box(wall, 1.06, 0.15, 0.72, x, 7.06, side * 0.94, trim)
    }
  }

  const tower = new Group()
  box(tower, 6, 8.75, 6, 0, 4.375, 0)
  box(tower, 6.45, 0.55, 6.45, 0, 0.275, 0, trim)
  for (const y of [2.1, 5.8, 8.1]) box(tower, 6.16, 0.18, 6.16, 0, y, 0, trim)
  box(tower, 6.65, 0.35, 6.65, 0, 8.7, 0, trim)
  for (let side = 0; side < 4; side++) {
    const face = new Group()
    face.rotation.y = side * Math.PI / 2
    tower.add(face)
    for (let row = 0; row < 15; row++) {
      for (const x of [-2.73, 2.73]) box(face, row % 2 ? 0.72 : 0.48, 0.43, 0.09, x, 0.85 + row * 0.5, 3.03, trim)
      box(face, 4.9, 0.018, 0.012, 0, 0.6 + row * 0.5, 3.006, dark)
    }
    for (const x of [-1.55, 1.55]) {
      box(face, 0.22, 1.02, 0.025, x, 4.35, 3.055, dark)
      box(face, 0.54, 0.14, 0.09, x, 4.22, 3.08, dark)
    }
    box(face, 6.65, 0.55, 0.48, 0, 9.08, 3.04)
    for (let i = 0; i < 4; i++) {
      const x = -2.67 + i * 1.78
      box(face, 0.95, 0.94, 0.72, x, 9.78, 3.02)
      box(face, 1.12, 0.14, 0.86, x, 10.31, 3.02, trim)
      box(face, 0.32, 0.42, 0.42, x, 8.32, 3.18, trim)
    }
    box(face, 1.04, 2.35, 0.07, 0, 6.59, 3.1, gold)
    box(face, 0.9, 2.24, 0.035, 0, 6.61, 3.15, blue)
    const emblem = box(face, 0.24, 0.7, 0.045, 0, 6.66, 3.18, gold)
    emblem.rotation.z = Math.PI / 4
    const bar = add(face, new CylinderGeometry(0.055, 0.055, 1.3, 8), gold, 0, 7.86, 3.15)
    bar.rotation.z = Math.PI / 2
  }
  // The patrol gallery is a plain slab so the bake can stretch it along its
  // width. The placement's elevation is the walking surface, so it hangs below
  // the origin and leaves the street underneath open.
  const gallery = new Group()
  {
    const { width, depth, height } = COURTYARD_ASSETS.Courtyard_Gallery
    box(gallery, width, height, depth, 0, -height / 2, 0, trim)
  }

  // Parapet segment: the placement's elevation is the rail's bottom edge.
  const railing = new Group()
  {
    const { width, depth, height } = COURTYARD_ASSETS.Courtyard_Rail
    box(railing, width, height, depth, 0, height / 2, 0)
    box(railing, width + 0.05, 0.08, depth + 0.05, 0, height, 0, trim)
  }

  // Access stairs, centred on their ground footprint and climbing toward +z.
  const stairs = new Group()
  {
    const { width, depth: run, height, steps } = COURTYARD_ASSETS.Courtyard_Stairs
    const { height: railHeight, depth: railThickness } = COURTYARD_ASSETS.Courtyard_Rail
    const tread = run / steps
    const rise = height / steps
    for (let i = 0; i < steps; i++) {
      const top = (i + 1) * rise
      const z = -run / 2 + (i + 0.5) * tread
      box(stairs, width, top, tread, 0, top / 2, z)
      box(stairs, width + 0.04, 0.05, tread + 0.025, 0, top - 0.025, z - 0.025, trim)
    }
    const slope = -Math.atan2(height, run)
    for (const sign of [-1, 1]) {
      const x = sign * width / 2
      box(stairs, railThickness, railHeight, Math.hypot(run, height), x, height / 2 + railHeight / 2, 0).rotation.x = slope
      for (let i = 0; i <= 6; i++) {
        const t = i / 6
        box(stairs, 0.28, railHeight + 0.1, 0.28, x, height * t + railHeight / 2, -run / 2 + run * t, trim)
      }
    }
  }

  return new Map([
    ['Courtyard_Rampart', wall],
    ['Courtyard_Bastion', tower],
    ['Courtyard_Gallery', gallery],
    ['Courtyard_Stairs', stairs],
    ['Courtyard_Rail', railing],
  ])
}

/** The open arch joins the two gate towers without blocking the bridge below. */
export function createFortifiedGate(stone: MeshStandardMaterial, trim: MeshStandardMaterial) {
  const group = new Group()
  const { gateX, gateZ, gateWidth, wallThickness } = FORTIFICATIONS
  const radius = gateWidth / 2
  const spring = 2.2
  const crown = spring + radius + 1.05
  const shape = new Shape()
  shape.moveTo(-radius, spring)
  shape.absarc(0, spring, radius, Math.PI, 0, true)
  shape.lineTo(radius, crown)
  shape.lineTo(-radius, crown)
  shape.closePath()
  const arch = new Mesh(new ExtrudeGeometry(shape, { depth: wallThickness, bevelEnabled: false, curveSegments: 32 }), stone)
  arch.position.set(gateX, 0, gateZ - wallThickness / 2)
  group.add(arch)
  // Individual voussoirs frame both faces of the archway.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 19; i++) {
      const a = i * Math.PI / 19 + 0.008
      const b = (i + 1) * Math.PI / 19 - 0.008
      const wedge = new Shape()
      wedge.absarc(0, 0, radius, a, b, false)
      wedge.absarc(0, 0, radius + 0.38, b, a, true)
      wedge.closePath()
      const stone = new Mesh(new ExtrudeGeometry(wedge, { depth: 0.14, bevelEnabled: false, curveSegments: 3 }), trim)
      stone.position.set(gateX, spring, gateZ + side * (wallThickness / 2 + 0.02) - (side < 0 ? 0.14 : 0))
      group.add(stone)
    }
  }
  const cornice = new Mesh(new BoxGeometry(gateWidth + 0.1, 0.27, wallThickness + 0.42), trim)
  cornice.position.set(gateX, crown, gateZ)
  group.add(cornice)
  for (let i = 0; i < 5; i++) {
    const merlon = new Mesh(new BoxGeometry(0.88, 0.85, wallThickness), stone)
    merlon.position.set(gateX - radius + 0.7 + i * (gateWidth - 1.4) / 4, crown + 0.5, gateZ)
    group.add(merlon)
  }
  group.updateMatrixWorld(true)
  const batches = new Map<MeshStandardMaterial, BufferGeometry[]>()
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const material = object.material as MeshStandardMaterial
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()
    geometry.applyMatrix4(object.matrixWorld)
    const parts = batches.get(material) ?? []
    parts.push(geometry)
    batches.set(material, parts)
    object.geometry.dispose()
  })
  const merged = new Group()
  for (const [material, parts] of batches) {
    const geometry = mergeGeometries(parts)!
    const mesh = new Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    merged.add(mesh)
    for (const part of parts) part.dispose()
  }
  return merged
}
