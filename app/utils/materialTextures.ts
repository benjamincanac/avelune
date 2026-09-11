import { CanvasTexture, NoColorSpace, RepeatWrapping, SRGBColorSpace } from 'three'

export type MaterialFamily = 'stone' | 'plaster' | 'timber' | 'terracotta' | 'earth'
export interface MaterialTextureSet {
  map: CanvasTexture
  normalMap: CanvasTexture
  roughnessMap: CanvasTexture
}

const SIZE = 512
const TAU = Math.PI * 2
const KNOTS = [[0.24, 0.32], [0.76, 0.79]] as const
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const smooth = (value: number) => value * value * (3 - 2 * value)
const wrapDistance = (value: number) => value - Math.round(value)

/** A periodic lattice is interpolated once, then reused by pigment and relief. */
function noiseField(columns: number, rows: number, seed: number): Float32Array {
  let state = seed >>> 0
  const lattice = new Float32Array(columns * rows)
  for (let i = 0; i < lattice.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    lattice[i] = state / 0x100000000
  }
  const field = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    const gy = y * rows / SIZE
    const row = Math.floor(gy)
    const sy = smooth(gy - row)
    const first = row * columns
    const second = ((row + 1) % rows) * columns
    for (let x = 0; x < SIZE; x++) {
      const gx = x * columns / SIZE
      const column = Math.floor(gx)
      const next = (column + 1) % columns
      const sx = smooth(gx - column)
      const a = lattice[first + column]! * (1 - sx) + lattice[first + next]! * sx
      const b = lattice[second + column]! * (1 - sx) + lattice[second + next]! * sx
      field[y * SIZE + x] = a * (1 - sy) + b * sy
    }
  }
  return field
}

function texture(pixels: Uint8ClampedArray, color = false): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const context = canvas.getContext('2d')!
  const image = context.createImageData(SIZE, SIZE)
  image.data.set(pixels)
  context.putImageData(image, 0, 0)
  const map = new CanvasTexture(canvas)
  map.colorSpace = color ? SRGBColorSpace : NoColorSpace
  map.wrapS = map.wrapT = RepeatWrapping
  map.generateMipmaps = true
  map.anisotropy = 8
  return map
}

/** Neutral pigment multiplies authored colors; relief carries the material detail.
 * All frequencies and derivatives wrap, including the timber knots. These maps
 * also work with world-space projection on meshes without authored UVs. */
export function createMaterialTextures(): Record<MaterialFamily, MaterialTextureSet> {
  const result = {} as Record<MaterialFamily, MaterialTextureSet>
  const families: MaterialFamily[] = ['stone', 'plaster', 'timber', 'terracotta', 'earth']
  for (const [index, family] of families.entries()) {
    const seed = 1907 + index * 997
    const broad = noiseField(4, 4, seed)
    const middle = noiseField(16, 16, seed + 1)
    const fine = noiseField(64, 64, seed + 2)
    const grit = noiseField(256, 256, seed + 3)
    const directional = noiseField(family === 'timber' ? 64 : 8, family === 'timber' ? 4 : 64, seed + 4)
    const heights = new Float32Array(SIZE * SIZE)
    const colors = new Uint8ClampedArray(SIZE * SIZE * 4)
    const roughness = new Uint8ClampedArray(colors.length)
    const normals = new Uint8ClampedArray(colors.length)
    for (let y = 0; y < SIZE; y++) {
      const v = y / SIZE
      for (let x = 0; x < SIZE; x++) {
        const u = x / SIZE
        const i = y * SIZE + x
        const b = broad[i]! - 0.5
        const m = middle[i]! - 0.5
        const f = fine[i]! - 0.5
        const g = grit[i]! - 0.5
        const d = directional[i]! - 0.5
        let relief: number
        let pigment: number
        let matte: number
        let warmth: number
        if (family === 'stone') {
          const pores = Math.pow(clamp((-f - 0.12) * 4), 2)
          const mineral = Math.pow(clamp((g - 0.18) * 4), 2)
          relief = b * 0.14 + m * 0.065 + f * 0.06 + g * 0.018 - pores * 0.065
          pigment = 0.9 + b * 0.12 + m * 0.07 + f * 0.025 - pores * 0.09 + mineral * 0.055
          matte = 0.88 + f * 0.1 + pores * 0.08 - mineral * 0.12
          warmth = m * 0.012
        }
        else if (family === 'plaster') {
          // Broad overlapping trowel ridges with a very fine lime aggregate.
          const trowel = Math.sin(TAU * (v * 12 + b * 0.8 + u * 2))
          const pores = Math.pow(clamp((-g - 0.2) * 5), 2)
          relief = b * 0.06 + m * 0.035 + d * 0.012 + trowel * 0.003 + g * 0.012 - pores * 0.018
          pigment = 0.95 + b * 0.065 + m * 0.035 + f * 0.015 - pores * 0.025
          matte = 0.94 + f * 0.05 + pores * 0.03
          warmth = 0.003 + b * 0.006
        }
        else if (family === 'timber') {
          let bend = 0
          let knots = 0
          for (const [kx, ky] of KNOTS) {
            const dx = wrapDistance(u - kx) / 0.072
            const dy = wrapDistance(v - ky) / 0.15
            const radius = Math.sqrt(dx * dx + dy * dy)
            const taper = clamp(1 - radius * radius / 9)
            const falloff = Math.exp(-radius * radius * 0.8) * taper * taper
            bend += dy * falloff * 2.8
            knots += falloff * (0.55 + Math.sin(radius * 24) * 0.22)
          }
          const grain = Math.sin(TAU * (u * 54 + b * 2.2 + d * 0.8 + bend))
          const fibers = Math.sin(TAU * (u * 146 + d * 0.4 + b * 0.9 + bend * 1.8))
          const grooves = Math.pow((grain + 1) / 2, 7)
          relief = d * 0.055 + grain * 0.01 + fibers * 0.004 - grooves * 0.026 - knots * 0.035 + g * 0.004
          pigment = 0.9 + b * 0.085 + d * 0.12 + grain * 0.022 - grooves * 0.075 - knots * 0.14
          matte = 0.78 + d * 0.1 + grooves * 0.12 + knots * 0.08
          warmth = 0.006 + d * 0.012
        }
        else if (family === 'terracotta') {
          // Shallow forming marks and fired pigment variation, without tile seams.
          const groove = Math.sin(TAU * (v * 68 + b * 0.9 + m * 0.3))
          const pores = Math.pow(clamp((-f - 0.19) * 5), 2)
          relief = b * 0.05 + m * 0.025 + d * 0.022 + groove * 0.006 + g * 0.012 - pores * 0.035
          pigment = 0.92 + b * 0.1 + m * 0.055 + d * 0.025 - pores * 0.06
          matte = 0.9 + f * 0.06 + pores * 0.05
          warmth = b * 0.015
        }
        else {
          const grains = Math.pow(clamp((g + 0.1) * 1.8), 2)
          const pits = Math.pow(clamp((-f - 0.12) * 3), 2)
          relief = b * 0.085 + m * 0.06 + f * 0.035 + grains * 0.045 - pits * 0.035
          pigment = 0.89 + b * 0.11 + m * 0.065 + f * 0.045 + grains * 0.045 - pits * 0.065
          matte = 0.97 - grains * 0.06
          warmth = 0.004 + m * 0.01
        }
        heights[i] = relief
        const offset = i * 4
        colors[offset] = clamp(pigment + warmth) * 255
        colors[offset + 1] = clamp(pigment) * 255
        colors[offset + 2] = clamp(pigment - warmth) * 255
        colors[offset + 3] = 255
        const gray = clamp(matte) * 255
        roughness[offset] = roughness[offset + 1] = roughness[offset + 2] = gray
        roughness[offset + 3] = 255
      }
    }
    // Central differences include the opposite edge, so repeat seams shade alike.
    const strength = family === 'timber' ? 9 : family === 'earth' ? 12 : 10
    for (let y = 0; y < SIZE; y++) {
      const before = ((y + SIZE - 1) % SIZE) * SIZE
      const after = ((y + 1) % SIZE) * SIZE
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x
        const dx = (heights[y * SIZE + ((x + 1) % SIZE)]! - heights[y * SIZE + ((x + SIZE - 1) % SIZE)]!) * strength
        // Canvas rows run down, while the texture's V coordinate runs up.
        const dy = (heights[before + x]! - heights[after + x]!) * strength
        const length = Math.hypot(dx, dy, 1)
        normals[i * 4] = (0.5 - dx / length * 0.5) * 255
        normals[i * 4 + 1] = (0.5 - dy / length * 0.5) * 255
        normals[i * 4 + 2] = (0.5 + 0.5 / length) * 255
        normals[i * 4 + 3] = 255
      }
    }
    result[family] = { map: texture(colors, true), normalMap: texture(normals), roughnessMap: texture(roughness) }
  }
  return result
}
