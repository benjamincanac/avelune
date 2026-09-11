import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
} from 'three'
import { ARENA_LAYOUT, PLAYER_RADIUS } from '#shared/utils/arena'
import { PALETTE } from '~/utils/palette'

/**
 * The arena floor as an LED dance floor: black panels on a 1-tile grid that light up white.
 * Render-only, like the stadium; collision and positions never read it.
 * One energy value per tile drives both a tone-mapped white core and an additive halo above it.
 * The halo reuses the Coach triangle's rim-light treatment: additive, untonemapped, same tint.
 * Built once and cached, since `buildFloor` clears and re-adds the group on every rebuild.
 */

export interface LedFloor {
  group: Group
  /** Light every panel the footprint at world (x, y) touches. Standing still keeps them lit. */
  stamp: (x: number, y: number, strength?: number) => void
  /** Fade lit tiles, fire idle sparks, and upload the frame's energy map. */
  update: (dt: number) => void
}

const SIZE = ARENA_LAYOUT.size
const CX = ARENA_LAYOUT.center.x
const CZ = ARENA_LAYOUT.center.y
/** Same disc the sand used: it runs under the LED hoarding, so no seam shows at the edge. */
const FLOOR_R = ARENA_LAYOUT.arenaRadius + 1.5
/** A lit tile is back to dark ~1.5 s after the foot leaves it. */
const FADE_TAU = 0.45
/** Idle life: a few dim sparks per second so the floor reads as LEDs when nobody moves. */
const SPARK_RATE = 2
const SPARK_LEVEL = 0.3
/** Seam width as a fraction of a tile. */
const SEAM = 0.035
/** A foot on a seam lights both panels: the footprint is sampled at its four corners. */
const FOOT = PLAYER_RADIUS * 0.9
/** Same tint as the Coach's rim light, so both halos match. */
const HALO_TINT = '#dfe6ff'

const HEADER = /* glsl */ `
uniform sampler2D uEnergy;
uniform float uSize;
varying vec2 vTile;
`

/** Tile-space position: world xz, 1 tile = 1 unit, so floor() is the tile index. */
const TILE_VERTEX = /* glsl */ `
#include <worldpos_vertex>
vTile = (modelMatrix * vec4(transformed, 1.0)).xz;
`

/** Panels stay near black; the seams go darker still, anti-aliased with fwidth. */
const SEAM_FRAGMENT = /* glsl */ `
#include <color_fragment>
vec2 tileUv = fract(vTile);
float edge = min(min(tileUv.x, 1.0 - tileUv.x), min(tileUv.y, 1.0 - tileUv.y));
float aa = fwidth(edge);
float panel = smoothstep(${SEAM} - aa, ${SEAM} + aa, edge);
diffuseColor.rgb *= mix(0.15, 1.0, panel);
`

/** The panel glows faintly at rest and white with its tile's energy; seams stay black. */
const CORE_FRAGMENT = /* glsl */ `
#include <emissivemap_fragment>
float core = texture2D(uEnergy, (floor(vTile) + 0.5) / uSize).r;
totalEmissiveRadiance = (totalEmissiveRadiance + uLit * core) * panel;
`

const HALO_VERTEX = /* glsl */ `
varying vec2 vTile;
void main() {
  vTile = (modelMatrix * vec4(position, 1.0)).xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/** Bilinear taps around the tile spread its energy over the seams and neighbours: a cheap blur. */
const HALO_FRAGMENT = /* glsl */ `
uniform sampler2D uEnergy;
uniform float uSize;
uniform vec3 uColor;
uniform float uGain;
varying vec2 vTile;
float e(vec2 p) { return texture2D(uEnergy, p / uSize).r; }
void main() {
  float sum = 2.0 * e(vTile);
  sum += e(vTile + vec2(0.7, 0.0)) + e(vTile + vec2(-0.7, 0.0)) + e(vTile + vec2(0.0, 0.7)) + e(vTile + vec2(0.0, -0.7));
  sum += 0.5 * (e(vTile + vec2(0.7, 0.7)) + e(vTile + vec2(-0.7, 0.7)) + e(vTile + vec2(0.7, -0.7)) + e(vTile + vec2(-0.7, -0.7)));
  float halo = sum / 8.0;
  halo = halo * halo * (3.0 - 2.0 * halo);
  gl_FragColor = vec4(uColor * uGain, halo);
}
`

let cached: LedFloor | null = null

export function buildLedFloor(): LedFloor {
  if (cached) return cached

  // One byte per tile; linear filtering is what the halo's blur leans on.
  const level = new Float32Array(SIZE * SIZE)
  const bytes = new Uint8Array(SIZE * SIZE)
  const energy = new DataTexture(bytes, SIZE, SIZE, RedFormat, UnsignedByteType)
  energy.minFilter = LinearFilter
  energy.magFilter = LinearFilter
  energy.generateMipmaps = false
  energy.unpackAlignment = 1
  energy.needsUpdate = true

  const uniforms = {
    uEnergy: { value: energy },
    uSize: { value: SIZE },
    uLit: { value: new Color(PALETTE.pale).multiplyScalar(1.8) },
  }

  const group = new Group()
  const geometry = new CircleGeometry(FLOOR_R, 56)

  // Panels: lit and shadowed like the sand was, so the runners still ground on it.
  // The rest glow keeps the grid legible at night, when nothing else lights the floor.
  const panelMaterial = new MeshStandardMaterial({ color: '#1a1a20', emissive: '#111116', roughness: 0.3, metalness: 0.15 })
  panelMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = `varying vec2 vTile;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>', TILE_VERTEX)
    shader.fragmentShader = `${HEADER}uniform vec3 uLit;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', SEAM_FRAGMENT)
      .replace('#include <emissivemap_fragment>', CORE_FRAGMENT)
  }
  panelMaterial.customProgramCacheKey = () => 'stadium-led-floor'
  const panels = new Mesh(geometry, panelMaterial)
  panels.rotation.x = -Math.PI / 2
  panels.position.set(CX, 0.02, CZ)
  group.add(panels)

  // Halo: the same additive, untonemapped, fog-free recipe as the Coach's rim light.
  const halo = new Mesh(geometry, new ShaderMaterial({
    uniforms: { uEnergy: uniforms.uEnergy, uSize: uniforms.uSize, uColor: { value: new Color(HALO_TINT) }, uGain: { value: 1.25 } },
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }))
  halo.rotation.x = -Math.PI / 2
  halo.position.set(CX, 0.03, CZ)
  group.add(halo)

  const stampTile = (x: number, y: number, strength: number) => {
    const tx = Math.floor(x)
    const ty = Math.floor(y)
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return
    const i = ty * SIZE + tx
    if (level[i]! < strength) level[i] = strength
  }
  const stamp = (x: number, y: number, strength = 1) => {
    for (const dx of [-FOOT, FOOT]) for (const dy of [-FOOT, FOOT]) stampTile(x + dx, y + dy, strength)
  }

  let sparkDebt = 0
  const update = (dt: number) => {
    const keep = Math.exp(-dt / FADE_TAU)
    for (let i = 0; i < level.length; i++) {
      const v = level[i]! * keep
      level[i] = v < 0.004 ? 0 : v
    }
    sparkDebt += dt * SPARK_RATE
    while (sparkDebt >= 1) {
      sparkDebt -= 1
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * (ARENA_LAYOUT.arenaRadius - 0.5)
      stampTile(CX + Math.cos(a) * r, CZ + Math.sin(a) * r, SPARK_LEVEL)
    }
    for (let i = 0; i < level.length; i++) bytes[i] = Math.round(level[i]! * 255)
    energy.needsUpdate = true
  }

  cached = { group, stamp, update }
  return cached
}
