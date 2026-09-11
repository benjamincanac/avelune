import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
} from 'three'
import type { BufferGeometry } from 'three'
import { ARENA_LAYOUT, createRng } from '#shared/utils/arena'
import type { Brand } from '~/utils/vercelBrands'
import { BRAND_RING } from '~/utils/vercelBrands'
import type { LedStripCell } from '~/utils/textures'
import {
  BOARD_FAMILY,
  drawLedStrip,
  makeCrowdTexture,
  makeGlowBandTexture,
  makeRadialGlowTexture,
  makeVercelCenterTexture,
} from '~/utils/textures'
import { PALETTE } from '~/utils/palette'

/**
 * The Vercel stadium: the arena bowl, its crowd, and the brand lights around it.
 * Render-only: nothing here is in `plan.props`, collision stays the tile ring in `generateArena`.
 * Built once and cached, since `buildFloor` clears and re-adds the group on every rebuild.
 * Inside out: LED hoarding, lower tier, LED fascia, upper tier, LED parapet, roof, LED halo, floodlights.
 * Every LED surface scrolls one brand strip (one texture per direction); glow is additive bands, not post-processing.
 */

const TAU = Math.PI * 2
const CX = ARENA_LAYOUT.center.x
const CZ = ARENA_LAYOUT.center.y
/** Y-rotation so a +Z-facing object looks at the arena centre. */
const faceIn = (dx: number, dz: number) => Math.atan2(-dx, -dz)

interface Tier {
  r0: number
  y0: number
  rows: number
  tread: number
  riser: number
}
/** Row i's tread spans r0 + i·tread to r0 + (i+1)·tread, at height y0 + i·riser. */
const LOWER: Tier = { r0: 13.05, y0: 1.3, rows: 8, tread: 0.8, riser: 0.45 }
const UPPER: Tier = { r0: 20, y0: 6.4, rows: 9, tread: 0.75, riser: 0.55 }
const tierTop = (t: Tier) => ({ r: t.r0 + t.rows * t.tread, y: t.y0 + (t.rows - 1) * t.riser })
/** The back parapet's top; the roof floats above it, leaving a gap of sky. */
const PARAPET_TOP = 12.6
const ROOF_Y = 13.8
const ROOF_INNER = 12.1
const ROOF_OUTER = 27.6
/** Radius of the dark shell the halo band hangs in, just over the sand's edge. */
const HALO_R = 12
const SEAT_PITCH = 0.5

/** LED bands: the lit face at `r`, a hair in front of the wall behind it. */
const BANDS = [
  { r: 12.95, y: 0.05, h: 1.15, reverse: false },
  { r: tierTop(LOWER).r - 0.05, y: 4.9, h: 1.2, reverse: true },
  { r: tierTop(UPPER).r - 0.05, y: 11.2, h: 1.1, reverse: false },
  { r: HALO_R - 0.1, y: 12.35, h: 1.1, reverse: true },
]

const STRIP_W = 8192
const STRIP_H = 256

/* -------------------------------------------------------------------------- */
/* Brand strip                                                                */
/* -------------------------------------------------------------------------- */

/** Frameworks flip to white cells so the ring alternates light and dark. */
function cellStyle(brand: Brand): LedStripCell['style'] {
  return brand.kind === 'framework'
    ? { bg: '#ffffff', fg: '#000000', mark: false }
    : { bg: '#000000', fg: '#ffffff', mark: true }
}

/**
 * The brand strip: 18 cells painted once, repainted when Geist lands.
 * Two textures over one canvas, one per scroll direction; flipping U instead would mirror the glyphs.
 */
function makeBrandStrips(): [CanvasTexture, CanvasTexture] {
  const canvas = document.createElement('canvas')
  canvas.width = STRIP_W
  canvas.height = STRIP_H
  const cells: LedStripCell[] = BRAND_RING.map(b => ({ label: b.label, style: cellStyle(b), logo: b.logo, wordmark: b.wordmark }))
  const paint = () => drawLedStrip(canvas.getContext('2d')!, canvas, cells, PALETTE.slime)
  paint()
  const textures: [CanvasTexture, CanvasTexture] = [new CanvasTexture(canvas), new CanvasTexture(canvas)]
  for (const texture of textures) {
    texture.colorSpace = SRGBColorSpace
    texture.wrapS = RepeatWrapping
    // Read at grazing angles around the ring; anisotropy keeps the type crisp.
    texture.anisotropy = 8
  }
  document.fonts.load(`600 64px ${BOARD_FAMILY}`).then(() => {
    paint()
    for (const texture of textures) texture.needsUpdate = true
  }).catch(() => {})
  return textures
}

/** An open cylinder seen from inside: mirrored in X so inner faces are front faces and text reads left to right. */
function innerCylinder(r: number, h: number, laps = 1): BufferGeometry {
  const geometry = new CylinderGeometry(r, r, h, 128, 1, true)
  geometry.scale(-1, 1, 1)
  if (laps !== 1) {
    // Bake the lap count into U so every band shares the same strip texture.
    const uv = geometry.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * laps)
  }
  return geometry
}

/* -------------------------------------------------------------------------- */
/* Bowl                                                                       */
/* -------------------------------------------------------------------------- */

/** The bowl's section from the sand's edge to the parapet cap, reversed so the lathe faces the arena. */
function bowlProfile(): Vector2[] {
  const pts: Vector2[] = []
  const push = (r: number, y: number) => pts.push(new Vector2(r, y))
  const tier = (t: Tier) => {
    let r = t.r0
    let y = t.y0
    for (let i = 0; i < t.rows; i++) {
      r += t.tread
      push(r, y)
      if (i < t.rows - 1) {
        y += t.riser
        push(r, y)
      }
    }
  }
  push(LOWER.r0, 0)
  push(LOWER.r0, LOWER.y0)
  tier(LOWER)
  push(tierTop(LOWER).r, UPPER.y0)
  push(UPPER.r0, UPPER.y0)
  tier(UPPER)
  push(tierTop(UPPER).r, PARAPET_TOP)
  push(tierTop(UPPER).r + 0.6, PARAPET_TOP)
  return pts.reverse()
}

function buildBowl(material: MeshStandardMaterial): Mesh {
  // Non-indexed so every step gets flat normals instead of a smoothed slope.
  const geometry = new LatheGeometry(bowlProfile(), 128).toNonIndexed()
  geometry.computeVertexNormals()
  const bowl = new Mesh(geometry, material)
  bowl.position.set(CX, 0, CZ)
  return bowl
}

/* -------------------------------------------------------------------------- */
/* Crowd                                                                      */
/* -------------------------------------------------------------------------- */

const crowdTime = { value: 0 }

/** Per-instance bounce plus a Mexican wave lapping the bowl; feet stay on the tread. */
const CROWD_VERTEX = /* glsl */ `
#include <begin_vertex>
{
  vec2 seat = instanceMatrix[3].xz;
  float ph = fract(sin(dot(seat, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
  float lift = max(sin(uTime * (1.4 + ph * 0.2) + ph), 0.0) * 0.06 * step(0.55, fract(ph * 2.3));
  float turn = atan(seat.y - ${CZ.toFixed(1)}, seat.x - ${CX.toFixed(1)}) / 6.2831;
  float wave = fract(turn - uTime * 0.05);
  lift += exp(-pow((wave - 0.5) * 16.0, 2.0)) * 0.3;
  transformed.y += lift * uv.y;
}`

function makeCrowdMaterial(): MeshLambertMaterial {
  // Lambert, not Standard, so `tagShadows` leaves thousands of quads out of the shadow pass.
  const material = new MeshLambertMaterial({ map: makeCrowdTexture(), alphaTest: 0.2, alphaToCoverage: true })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = crowdTime
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader.replace('#include <begin_vertex>', CROWD_VERTEX)}`
    // Night "floodlight" is emissive scaled by the instance colour, so the crowd keeps its colours instead of greying out.
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= diffuseColor.rgb;')
  }
  return material
}

/** Home crowd: mostly Vercel black and white, grey and slime-blue scarves, a few odd hues. */
function crowdColor(rng: () => number, out: Color): Color {
  const t = rng()
  if (t < 0.34) return out.set('#15161a')
  if (t < 0.58) return out.set('#f2f2f3')
  if (t < 0.72) return out.set('#6c7079')
  if (t < 0.86) return out.set(PALETTE.slime)
  if (t < 0.94) return out.set(PALETTE.deep)
  return out.setHSL(rng(), 0.55, 0.5)
}

function buildCrowd(tiers: Tier[], material: MeshLambertMaterial, rng: () => number): InstancedMesh {
  const seats: Array<{ r: number, y: number, a: number }> = []
  for (const t of tiers) {
    for (let i = 0; i < t.rows; i++) {
      const r = t.r0 + (i + 0.55) * t.tread
      const y = t.y0 + i * t.riser
      const n = Math.floor((TAU * r) / SEAT_PITCH)
      for (let k = 0; k < n; k++) {
        if (rng() > 0.92) continue
        seats.push({ r, y, a: ((k + rng() * 0.3) / n) * TAU })
      }
    }
  }
  const geometry = new PlaneGeometry(0.42, 0.62)
  geometry.translate(0, 0.31, 0)
  const crowd = new InstancedMesh(geometry, material, seats.length)
  const dummy = new Object3D()
  const color = new Color()
  seats.forEach((s, i) => {
    const dx = Math.cos(s.a)
    const dz = Math.sin(s.a)
    dummy.position.set(CX + dx * s.r, s.y, CZ + dz * s.r)
    dummy.rotation.set(0, faceIn(dx, dz), 0)
    const standing = rng() < 0.08
    dummy.scale.set(0.85 + rng() * 0.25, (standing ? 1.45 : 0.9) + rng() * 0.2, 1)
    dummy.updateMatrix()
    crowd.setMatrixAt(i, dummy.matrix)
    crowd.setColorAt(i, crowdColor(rng, color))
  })
  return crowd
}

/* -------------------------------------------------------------------------- */
/* Roof and lights                                                            */
/* -------------------------------------------------------------------------- */

function buildRoof(group: Group, material: MeshStandardMaterial) {
  const deck = new Mesh(new RingGeometry(ROOF_INNER, ROOF_OUTER, 128, 1), material)
  deck.rotation.x = -Math.PI / 2
  deck.position.set(CX, ROOF_Y, CZ)
  group.add(deck)

  const dummy = new Object3D()
  const TRUSSES = 48
  const mid = (ROOF_INNER + ROOF_OUTER) / 2
  const trusses = new InstancedMesh(new BoxGeometry(ROOF_OUTER - ROOF_INNER - 0.4, 0.35, 0.18), material, TRUSSES)
  for (let i = 0; i < TRUSSES; i++) {
    const a = (i / TRUSSES) * TAU
    dummy.position.set(CX + Math.cos(a) * mid, ROOF_Y - 0.25, CZ + Math.sin(a) * mid)
    dummy.rotation.set(0, -a, 0)
    dummy.updateMatrix()
    trusses.setMatrixAt(i, dummy.matrix)
  }
  group.add(trusses)
  for (const r of [16.5, 23.5]) {
    const beam = new Mesh(new CylinderGeometry(r, r, 0.35, 128, 1, true), material)
    beam.position.set(CX, ROOF_Y - 0.25, CZ)
    group.add(beam)
  }

  // Columns behind the parapet carry the deck and show through the sky gap.
  const COLUMNS = 16
  const columns = new InstancedMesh(new BoxGeometry(0.5, ROOF_Y, 0.5), material, COLUMNS)
  for (let i = 0; i < COLUMNS; i++) {
    const a = ((i + 0.5) / COLUMNS) * TAU
    dummy.position.set(CX + Math.cos(a) * (ROOF_OUTER - 0.4), ROOF_Y / 2, CZ + Math.sin(a) * (ROOF_OUTER - 0.4))
    dummy.rotation.set(0, -a, 0)
    dummy.updateMatrix()
    columns.setMatrixAt(i, dummy.matrix)
  }
  group.add(columns)
}

const FLOOD_OFF = new Color('#3b3e46')
const FLOOD_ON = new Color('#ffffff')

/** Eight banks on the roof's inner rim, tilted at the sand, each with a bloom sprite. */
function buildFloodlights(group: Group, material: MeshBasicMaterial, glow: SpriteMaterial) {
  const BANKS = 8
  const banks = new InstancedMesh(new BoxGeometry(2.4, 0.5, 0.35), material, BANKS)
  const dummy = new Object3D()
  const r = ROOF_INNER + 1.9
  for (let i = 0; i < BANKS; i++) {
    const a = ((i + 0.5) / BANKS) * TAU
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    dummy.position.set(CX + dx * r, ROOF_Y - 0.55, CZ + dz * r)
    dummy.rotation.set(0.35, faceIn(dx, dz), 0, 'YXZ')
    dummy.updateMatrix()
    banks.setMatrixAt(i, dummy.matrix)
    const sprite = new Sprite(glow)
    sprite.position.set(CX + dx * (r - 0.3), ROOF_Y - 0.9, CZ + dz * (r - 0.3))
    sprite.scale.setScalar(5.5)
    group.add(sprite)
  }
  group.add(banks)
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

export interface Stadium {
  group: Group
  /** Per frame: scroll the LEDs, animate the crowd, dial the lights by `night` (0 day, 1 night). */
  update: (dt: number, elapsed: number, night: number) => void
}

let cached: Stadium | null = null
/** The stadium, built on first use and shared by every arena rebuild. */
export function buildStadium(): Stadium {
  cached ??= createStadium()
  return cached
}

function createStadium(): Stadium {
  const group = new Group()
  const rng = createRng(7)
  const [strip, stripBack] = makeBrandStrips()

  const bowlMaterial = new MeshStandardMaterial({ color: '#2b2e34', roughness: 0.95 })
  group.add(buildBowl(bowlMaterial))

  const roofMaterial = new MeshStandardMaterial({ color: '#30333a', roughness: 0.9, side: DoubleSide })
  buildRoof(group, roofMaterial)

  // The dark shell the halo band hangs in, closed against the roof.
  const housing = new Mesh(
    new CylinderGeometry(HALO_R, HALO_R, ROOF_Y - HALO_R, 128, 1, true),
    new MeshStandardMaterial({ color: '#111216', roughness: 0.8, side: BackSide }),
  )
  housing.position.set(CX, (ROOF_Y + HALO_R) / 2, CZ)
  group.add(housing)

  // Unlit and untonemapped so the LEDs stay white-hot under ACES and glow after dark.
  const glowMaterial = new MeshBasicMaterial({
    map: makeGlowBandTexture(),
    color: PALETTE.light,
    transparent: true,
    opacity: 0.3,
    blending: AdditiveBlending,
    depthWrite: false,
    side: BackSide,
    toneMapped: false,
    fog: false,
  })
  for (const band of BANDS) {
    // Integer laps keep the wrap seam invisible; cells stretch a few percent to fit.
    const laps = Math.max(1, Math.round((TAU * band.r / band.h) / (STRIP_W / STRIP_H)))
    const led = new Mesh(
      innerCylinder(band.r, band.h, laps),
      new MeshBasicMaterial({ map: band.reverse ? stripBack : strip, toneMapped: false, fog: false }),
    )
    led.position.set(CX, band.y + band.h / 2, CZ)
    group.add(led)
    // The spill sits just behind the band, so only its edges show past the LEDs.
    const glow = new Mesh(new CylinderGeometry(band.r + 0.03, band.r + 0.03, band.h * 2.4, 128, 1, true), glowMaterial)
    glow.position.copy(led.position)
    group.add(glow)
  }

  const crowdMaterial = makeCrowdMaterial()
  group.add(buildCrowd([LOWER, UPPER], crowdMaterial, rng))

  const floodMaterial = new MeshBasicMaterial({ color: FLOOD_OFF, toneMapped: false, fog: false })
  const floodGlow = new SpriteMaterial({
    map: makeRadialGlowTexture(),
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  })
  buildFloodlights(group, floodMaterial, floodGlow)

  return {
    group,
    update(dt, elapsed, night) {
      strip.offset.x = (strip.offset.x + dt * 0.012) % 1
      stripBack.offset.x = (stripBack.offset.x - dt * 0.012 + 1) % 1
      crowdTime.value = elapsed
      glowMaterial.opacity = 0.16 + 0.3 * night
      // Floodlit at night: the bowl and crowd self-light a little so they don't vanish.
      bowlMaterial.emissive.setScalar(0.05 * night)
      crowdMaterial.emissive.setScalar(0.7 * night)
      floodMaterial.color.copy(FLOOD_OFF).lerp(FLOOD_ON, night)
      floodGlow.opacity = 0.85 * night
    },
  }
}

let centerMark: CanvasTexture | null = null
/** The centre-sand inlay (touchline ring, centre circle, ▲), drawn once. */
export function centerMarkTexture(): CanvasTexture {
  centerMark ??= makeVercelCenterTexture()
  return centerMark
}
