import {
  CanvasTexture, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, Group,
  IcosahedronGeometry, Mesh, MeshStandardMaterial, PlaneGeometry, Shape,
  SRGBColorSpace, TorusGeometry, Vector3,
} from 'three'
import type { BufferGeometry, Material } from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COURTYARD_ASSETS } from '#shared/utils/courtyard'
import { createRng } from '#shared/utils/maze'
import { makeCourtyardSurface } from './courtyardTextures'

/** One material family for the entire town. Geometry is merged per material
 * before instancing, including the roof tiles and individual masonry blocks. */
export function createCourtyardAssets(): Map<string, Group> {
  const rng = createRng(812)
  const surface = makeCourtyardSurface('plaster')
  const mat = (color: string, extra = {}) => new MeshStandardMaterial({ color, map: surface, roughness: 0.88, ...extra })
  const stone = mat('#c8b796')
  const trim = mat('#ecdabe')
  const mortar = mat('#998e7a')
  const plaster = mat('#f0d6a4')
  const pink = mat('#dba693')
  const wood = mat('#665043')
  const darkWood = mat('#433b38')
  const gold = mat('#dfb45b', { metalness: 0.25, roughness: 0.5 })
  const teal = mat('#4c888c')
  const roof = ['#bd7359', '#c67b5e', '#cd8363', '#b46a54'].map(c => mat(c))
  const blueRoof = ['#547f8e', '#5d8795', '#668e9c', '#537888'].map(c => mat(c))
  const leaves = ['#49764b', '#65914f', '#80a85c', '#9ebc6b'].map(c => mat(c))
  const petals = ['#e4b65e', '#cc7594', '#9691c0', '#efcf9c'].map(c => mat(c))
  const window = mat('#536f70', { roughness: 0.28, metalness: 0.12 })
  const light = mat('#ffdf9a', { emissive: '#ffb85c', emissiveIntensity: 0.65 })
  const water = mat('#63bcc1', { roughness: 0.19, metalness: 0.25, transparent: true, opacity: 0.88 })
  const assets = new Map<string, Group>()

  function mesh(g: Group, geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0) {
    const m = new Mesh(geometry, material)
    m.position.set(x, y, z)
    g.add(m)
    return m
  }
  function box(g: Group, w: number, h: number, d: number, x: number, y: number, z: number, m = trim, radius = 0.045) {
    return mesh(g, new RoundedBoxGeometry(w, h, d, 1, Math.min(radius, w / 4, h / 4, d / 4)), m, x, y, z)
  }
  function cylinder(g: Group, rt: number, rb: number, h: number, x: number, y: number, z: number, m = stone, n = 12) {
    return mesh(g, new CylinderGeometry(rt, rb, h, n), m, x, y, z)
  }
  function branch(g: Group, from: Vector3, to: Vector3, radius: number) {
    const d = to.clone().sub(from)
    const b = cylinder(g, radius * 0.62, radius, d.length(), 0, 0, 0, wood, 7)
    b.position.copy(from).addScaledVector(d, 0.5)
    b.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.normalize())
  }
  function arch(g: Group, w: number, h: number, depth: number, x: number, y: number, z: number, material: Material) {
    const r = w / 2
    const shape = new Shape()
    shape.moveTo(-r, 0)
    shape.lineTo(r, 0)
    shape.lineTo(r, h - r)
    shape.absarc(0, h - r, r, 0, Math.PI, false)
    shape.lineTo(-r, 0)
    return mesh(g, new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.025, bevelSegments: 1, steps: 1, curveSegments: 10 }), material, x, y, z)
  }
  function windowAt(g: Group, x: number, y: number, z: number) {
    arch(g, 1.16, 1.7, 0.12, x, y, z, trim)
    arch(g, 0.86, 1.42, 0.08, x, y + 0.12, z + 0.15, window)
    box(g, 0.065, 1.33, 0.08, x, y + 0.82, z + 0.28, wood)
    box(g, 0.82, 0.065, 0.08, x, y + 0.84, z + 0.28, wood)
    box(g, 1.35, 0.16, 0.38, x, y, z + 0.12, trim)
    for (const side of [-1, 1]) {
      box(g, 0.38, 1.35, 0.1, x + side * 0.79, y + 0.72, z + 0.1, teal)
      for (let k = 0; k < 5; k++) box(g, 0.37, 0.045, 0.06, x + side * 0.79, y + 0.25 + k * 0.21, z + 0.18, wood)
    }
  }
  function flowers(g: Group, x: number, y: number, z: number, spread: number, count = 18) {
    for (let i = 0; i < count; i++) {
      const px = x + (rng() - 0.5) * spread
      const pz = z + (rng() - 0.5) * 0.65
      const h = 0.15 + rng() * 0.25
      cylinder(g, 0.025, 0.03, h, px, y + h / 2, pz, leaves[0], 4)
      const bloom = mesh(g, new IcosahedronGeometry(0.1 + rng() * 0.06, 0), petals[i % petals.length]!, px, y + h, pz)
      bloom.scale.y = 0.55
    }
  }
  function roofAt(g: Group, width: number, depth: number, y: number, rise: number, colors: MeshStandardMaterial[]) {
    const half = depth / 2 + 0.5
    const slope = Math.atan2(rise, half)
    const length = Math.hypot(half, rise)
    for (const side of [-1, 1]) {
      const panel = box(g, width + 0.9, 0.16, length + 0.1, 0, y + rise / 2, side * half / 2, darkWood)
      panel.rotation.x = side * slope
      const rows = Math.ceil(length / 0.44)
      const cols = Math.ceil((width + 0.9) / 0.55)
      for (let row = 0; row < rows; row++) {
        const t = (row + 0.45) / rows
        for (let col = 0; col < cols; col++) {
          const tile = box(g, (width + 0.9) / cols - 0.012, 0.095, length / rows + 0.13,
            -(width + 0.9) / 2 + (col + 0.5) * (width + 0.9) / cols,
            y + rise * (1 - t) + 0.13, side * half * t,
            colors[Math.floor(rng() * colors.length)]!, 0.045)
          tile.rotation.x = side * slope
        }
      }
    }
    for (let x = -width / 2 - 0.4; x < width / 2 + 0.4; x += 0.48) {
      const cap = cylinder(g, 0.16, 0.16, 0.5, x, y + rise + 0.16, 0, colors[1], 8)
      cap.rotation.z = Math.PI / 2
    }
    // Solid gable ends under the tile roof.
    for (const side of [-1, 1]) {
      const shape = new Shape()
      shape.moveTo(-depth / 2, 0)
      shape.lineTo(depth / 2, 0)
      shape.lineTo(0, rise * depth / (depth + 1))
      shape.closePath()
      const end = mesh(g, new ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false }), plaster, side * width / 2, y, 0)
      end.rotation.y = Math.PI / 2
    }
  }
  function sign(g: Group, text: string, x: number, y: number, z: number) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 128
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#384e50'
    ctx.fillRect(0, 0, 512, 128)
    ctx.strokeStyle = '#dfbd77'
    ctx.lineWidth = 5
    ctx.strokeRect(9, 9, 494, 110)
    ctx.font = '600 37px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#f5e3b5'
    ctx.fillText(text, 256, 67)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    box(g, 3.1, 0.85, 0.18, x, y, z, wood)
    mesh(g, new PlaneGeometry(2.95, 0.74), new MeshStandardMaterial({ map: texture, roughness: 0.85 }), x, y, z + 0.1)
  }
  function house(kind: 'Courtyard_Inn' | 'Courtyard_Shop') {
    const { width: w, depth: d, height: h } = COURTYARD_ASSETS[kind]
    const inn = kind === 'Courtyard_Inn'
    const g = new Group()
    box(g, w, h, d, 0, h / 2, 0, inn ? plaster : pink, 0.12)
    box(g, w + 0.12, 0.55, d + 0.12, 0, 0.28, 0, mortar)
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < w; i++) {
        box(g, 0.94, 0.24, 0.14, i - w / 2 + 0.5, 0.14 + row * 0.27, d / 2 + 0.08, stone)
      }
    }
    box(g, w + 0.3, 0.2, d + 0.3, 0, h - 0.12, 0, wood)
    if (inn) box(g, w + 0.14, 0.18, d + 0.14, 0, 2.65, 0, wood)
    for (const side of [-1, 1]) {
      box(g, 0.2, h, 0.2, side * (w / 2 - 0.04), h / 2, d / 2, wood)
      for (let row = 0; row < Math.floor(h / 0.45); row++) {
        box(g, row % 2 ? 0.38 : 0.58, 0.3, 0.18, side * (w / 2 - 0.18), row * 0.45 + 0.3, d / 2 + 0.08, trim)
      }
      windowAt(g, side * (inn ? 2.4 : 1.8), inn ? 3.1 : 1.3, d / 2 + 0.01)
      if (inn) {
        windowAt(g, side * 2.5, 0.8, d / 2 + 0.01)
        box(g, 1.6, 0.25, 0.5, side * 2.4, 2.95, d / 2 + 0.3, wood)
        flowers(g, side * 2.4, 3.1, d / 2 + 0.3, 1.5, 14)
      }
    }
    arch(g, 1.8, 2.45, 0.22, 0, 0.08, d / 2, trim)
    arch(g, 1.4, 2.2, 0.1, 0, 0.12, d / 2 + 0.25, darkWood)
    for (let i = -2; i <= 2; i++) box(g, 0.2, 1.72, 0.04, i * 0.25, 0.98, d / 2 + 0.38, wood)
    for (const y of [0.5, 1.5]) box(g, 1.35, 0.09, 0.05, 0, y, d / 2 + 0.43, gold)
    mesh(g, new TorusGeometry(0.085, 0.024, 5, 12), gold, 0.35, 1.06, d / 2 + 0.48)
    roofAt(g, w, d, h, inn ? 2.35 : 1.9, inn ? roof : blueRoof)
    box(g, 0.85, 2.8, 0.85, -w / 2 + 1.1, h + 1.6, -0.6, stone)
    box(g, 1.08, 0.2, 1.08, -w / 2 + 1.1, h + 3.04, -0.6, trim)
    sign(g, inn ? 'THE WAYFARER' : 'MOSS & MORTAR', 0, inn ? 3 : 2.96, d / 2 + 0.5)
    return g
  }

  assets.set('Courtyard_Inn', house('Courtyard_Inn'))
  assets.set('Courtyard_Shop', house('Courtyard_Shop'))
  {
    const g = new Group()
    const { width: w, height: h } = COURTYARD_ASSETS.Courtyard_Tower
    box(g, w, h, w, 0, h / 2, 0, plaster, 0.15)
    for (const y of [0.3, 3.2, 6.3, 8.9]) box(g, w + 0.3, 0.26, w + 0.3, 0, y, 0, trim)
    for (const x of [-1.9, 1.9]) for (const z of [-1.9, 1.9]) box(g, 0.35, h, 0.35, x, h / 2, z, stone)
    for (let side = 0; side < 4; side++) {
      const face = new Group()
      face.rotation.y = side * Math.PI / 2
      windowAt(face, 0, 6.8, 2.02)
      arch(face, 1.4, 2.4, 0.1, 0, 0, 2.03, darkWood)
      g.add(face)
    }
    cylinder(g, 0, 3.5, 3.6, 0, 10.8, 0, blueRoof[1], 4).rotation.y = Math.PI / 4
    cylinder(g, 0.045, 0.065, 1.4, 0, 13.05, 0, gold)
    box(g, 1.15, 0.6, 0.045, 0.56, 13.35, 0, teal)
    assets.set('Courtyard_Tower', g)
  }
  {
    const g = new Group()
    box(g, 4, 2.55, 0.8, 0, 1.275, 0, stone)
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 4; col++) {
        for (const s of [-1, 1]) box(g, 0.95, 0.32, 0.06, -1.5 + col, 0.2 + row * 0.34, s * 0.41, row % 3 ? stone : trim)
      }
    }
    box(g, 4.15, 0.2, 1.04, 0, 2.62, 0, trim)
    assets.set('Courtyard_Wall', g)
  }
  {
    const g = new Group()
    cylinder(g, 0.22, 0.4, 3.7, 0, 1.85, 0, wood, 9)
    for (let i = 0; i < 8; i++) {
      const a = i * 2.399
      const end = new Vector3(Math.cos(a) * (1.4 + rng()), 3.8 + rng() * 1.9, Math.sin(a) * (1.2 + rng()))
      branch(g, new Vector3(0, 2 + rng(), 0), end, 0.13)
      for (let j = 0; j < 5; j++) {
        const leaf = mesh(g, new IcosahedronGeometry(0.85 + rng() * 0.55, 2), leaves[(i + j) % 4]!, end.x + (rng() - 0.5) * 1.25, end.y + (rng() - 0.5) * 0.9, end.z + (rng() - 0.5) * 1.25)
        leaf.scale.set(1, 0.75 + rng() * 0.3, 1)
        leaf.rotation.set(rng(), rng(), rng())
      }
    }
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2
      branch(g, new Vector3(Math.cos(a) * 0.9, 0.03, Math.sin(a) * 0.9), new Vector3(0, 0.7, 0), 0.14)
    }
    assets.set('Courtyard_Tree', g)
  }
  {
    const g = new Group()
    box(g, 3, 0.55, 1.4, 0, 0.275, 0, stone)
    box(g, 3.12, 0.12, 1.52, 0, 0.56, 0, trim)
    box(g, 2.82, 0.08, 1.21, 0, 0.64, 0, mortar)
    assets.set('Courtyard_Planter', g)
  }
  {
    const g = new Group()
    for (const x of [-0.85, 0.85]) box(g, 0.25, 0.65, 0.8, x, 0.32, 0, stone)
    for (let i = 0; i < 3; i++) box(g, 2.4, 0.13, 0.23, 0, 0.63, -0.26 + i * 0.26, wood)
    for (const x of [-0.9, 0.9]) box(g, 0.1, 0.8, 0.1, x, 0.88, -0.32, darkWood)
    for (let i = 0; i < 2; i++) box(g, 2.4, 0.22, 0.1, 0, 0.94 + i * 0.26, -0.34, wood)
    assets.set('Courtyard_Bench', g)
  }
  {
    const g = new Group()
    box(g, 3.2, 1.05, 1.8, 0, 0.525, 0, wood)
    for (let i = 0; i < 11; i++) box(g, 0.25, 0.86, 0.06, -1.45 + i * 0.29, 0.53, 0.94, i % 2 ? stone : trim)
    box(g, 3.4, 0.16, 2, 0, 1.05, 0, trim)
    for (const x of [-1.65, 1.65]) for (const z of [-0.8, 0.8]) cylinder(g, 0.055, 0.065, 2.9, x, 1.45, z, wood, 8)
    const fabrics = [teal.clone(), trim.clone()]
    fabrics.forEach((material) => {
      material.side = DoubleSide
    })
    for (let i = 0; i < 8; i++) {
      const geometry = new PlaneGeometry(0.45, 2.5, 4, 14)
      geometry.rotateX(-Math.PI / 2)
      const positions = geometry.attributes.position!
      for (let j = 0; j < positions.count; j++) {
        const z = positions.getZ(j)
        positions.setY(j, 2.85 - z * 0.16 - Math.cos(z / 2.5 * Math.PI) * 0.18)
      }
      geometry.computeVertexNormals()
      mesh(g, geometry, fabrics[i % 2]!, -1.575 + i * 0.45, 0, 0)
      const hem = new Shape()
      hem.moveTo(-0.225, 0)
      hem.lineTo(0.225, 0)
      hem.lineTo(0.225, -0.14)
      hem.quadraticCurveTo(0, -0.38, -0.225, -0.14)
      hem.closePath()
      mesh(g, new ExtrudeGeometry(hem, { depth: 0.018, bevelEnabled: false, curveSegments: 10 }), fabrics[i % 2]!, -1.575 + i * 0.45, 2.65, 1.25)
    }
    for (let i = 0; i < 3; i++) {
      box(g, 0.85, 0.22, 1.2, -1.04 + i * 1.04, 1.2, 0, darkWood)
      for (let j = 0; j < 14; j++) mesh(g, new IcosahedronGeometry(0.12, 1), i === 0 ? petals[0]! : i === 1 ? pink : leaves[2]!, -1.04 + i * 1.04 + (rng() - 0.5) * 0.62, 1.37 + rng() * 0.08, (rng() - 0.5) * 0.9)
    }
    assets.set('Courtyard_Stall', g)
  }
  {
    const g = new Group()
    cylinder(g, 1.95, 2.05, 0.18, 0, 0.09, 0, stone, 24)
    cylinder(g, 1.75, 1.85, 0.25, 0, 0.28, 0, trim, 24)
    const rim = mesh(g, new TorusGeometry(1.64, 0.21, 6, 32), stone, 0, 0.54, 0)
    rim.rotation.x = Math.PI / 2
    cylinder(g, 1.5, 1.5, 0.04, 0, 0.45, 0, water, 40)
    cylinder(g, 0.3, 0.65, 1.35, 0, 0.97, 0, stone, 12)
    cylinder(g, 0.88, 0.4, 0.3, 0, 1.65, 0, trim, 16)
    cylinder(g, 0.78, 0.78, 0.03, 0, 1.81, 0, water, 24)
    cylinder(g, 0.1, 0.2, 0.8, 0, 2.2, 0, stone, 10)
    mesh(g, new IcosahedronGeometry(0.19, 1), gold, 0, 2.7, 0)
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6
      const stream = cylinder(g, 0.024, 0.04, 1.04, Math.cos(a) * 0.75, 1.05, Math.sin(a) * 0.75, water, 5)
      stream.rotation.z = Math.cos(a) * 0.1
      stream.rotation.x = Math.sin(a) * 0.1
    }
    assets.set('Courtyard_Fountain', g)
  }
  {
    const g = new Group()
    cylinder(g, 0.1, 0.2, 0.22, 0, 0.11, 0, stone)
    cylinder(g, 0.045, 0.07, 2.85, 0, 1.6, 0, darkWood, 8)
    box(g, 0.85, 0.075, 0.08, 0.35, 2.95, 0, darkWood)
    box(g, 0.08, 0.3, 0.08, 0.72, 2.82, 0, gold)
    box(g, 0.34, 0.48, 0.34, 0.72, 2.47, 0, light)
    for (const x of [-0.18, 0.18]) for (const z of [-0.18, 0.18]) box(g, 0.04, 0.5, 0.04, 0.72 + x, 2.47, z, darkWood)
    cylinder(g, 0.03, 0.34, 0.22, 0.72, 2.84, 0, darkWood, 4).rotation.y = Math.PI / 4
    box(g, 0.44, 0.07, 0.44, 0.72, 2.18, 0, darkWood)
    assets.set('Courtyard_Lantern', g)
  }

  // Bake every part into template space and merge by material. Hundreds of
  // shingles become four meshes, so placed houses stay inexpensive to render.
  for (const [kind, group] of assets) {
    group.updateMatrixWorld(true)
    const batches = new Map<Material, BufferGeometry[]>()
    group.traverse((obj) => {
      if (!(obj instanceof Mesh)) return
      const material = obj.material as Material
      const parts = batches.get(material) ?? []
      let geometry = obj.geometry.clone().applyMatrix4(obj.matrixWorld)
      if (geometry.index) {
        const nonIndexed = geometry.toNonIndexed()
        geometry.dispose()
        geometry = nonIndexed
      }
      // All built-in geometries have normals and UVs. Only these are needed.
      for (const attr of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(attr)) geometry.deleteAttribute(attr)
      parts.push(geometry)
      batches.set(material, parts)
      obj.geometry.dispose()
    })
    const merged = new Group()
    for (const [material, parts] of batches) {
      const geometry = mergeGeometries(parts)
      if (geometry) {
        const part = new Mesh(geometry, material)
        part.castShadow = !(material as MeshStandardMaterial).transparent
        part.receiveShadow = part.castShadow
        merged.add(part)
      }
      for (const part of parts) part.dispose()
    }
    assets.set(kind, merged)
  }
  // Transparent water and signs are double-sided only where needed.
  water.side = DoubleSide
  water.color.copy(new Color('#63bcc1'))
  return assets
}
