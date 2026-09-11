import {
  AdditiveBlending,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Shape,
  Sprite,
  SpriteMaterial,
} from 'three'
import type { CanvasTexture } from 'three'
import { makeSmokeTexture, makeTriangleGlowTexture } from '~/utils/textures'

/**
 * The Coach's body: vercel.com's hero triangle, in 3D.
 * A black prism inside a slightly larger white one, so a white rim shows on both faces.
 * Additive glow planes fake the site's bloom; a bed of smoke sprites rises underneath.
 * Render-only; `coachPos()` in ArenaScene still places and turns the group.
 */

export interface CoachBody {
  group: Group
  update: (dt: number, elapsed: number) => void
}

/** Triangle height as a share of the Coach's overall height; the rest is hover clearance. */
const TRIANGLE_SHARE = 0.68
/** Outer prism scale: the white rim's width. */
const RIM = 1.06
const DEPTH = 0.22
/** The glow canvas draws the triangle 276 px tall on 512. */
const GLOW_SCALE = 512 / 276
const SMOKE_COUNT = 36
/** Seconds a puff takes to rise and fade. */
const SMOKE_LIFE = 3.6

/** Equilateral triangle of the given height, centroid at the origin. */
function triangleShape(height: number): Shape {
  const half = height / Math.sqrt(3)
  const shape = new Shape()
  shape.moveTo(-half, -height / 3)
  shape.lineTo(half, -height / 3)
  shape.lineTo(0, (2 * height) / 3)
  shape.closePath()
  return shape
}

interface Puff {
  sprite: Sprite
  material: SpriteMaterial
  life: number
  x: number
  z: number
  drift: number
}

// The Coach is rebuilt on every arena rebuild; the canvases are not.
let glowTex: CanvasTexture | null = null
let smokeTex: CanvasTexture | null = null
const glowTexture = () => (glowTex ??= makeTriangleGlowTexture())
const smokeTexture = () => (smokeTex ??= makeSmokeTexture())

function respawn(puff: Puff) {
  puff.x = (Math.random() - 0.5) * 0.9
  puff.z = (Math.random() - 0.5) * 0.9
  puff.drift = (Math.random() - 0.5) * 0.4
}

export function createCoachBody(totalHeight: number): CoachBody {
  const group = new Group()
  const triH = totalHeight * TRIANGLE_SHARE
  const baseY = totalHeight - triH
  const restY = baseY + triH / 3

  const body = new Group()
  body.position.y = restY
  group.add(body)

  // The black face protrudes past the white prism on both sides, so the rim reads as an outline.
  const black = new Mesh(
    new ExtrudeGeometry(triangleShape(triH), { depth: DEPTH + 0.06, bevelEnabled: false }),
    new MeshStandardMaterial({ color: '#07070a', roughness: 0.35, metalness: 0.25 }),
  )
  black.position.z = -(DEPTH + 0.06) / 2
  black.castShadow = true
  body.add(black)
  const white = new Mesh(
    new ExtrudeGeometry(triangleShape(triH * RIM), { depth: DEPTH, bevelEnabled: false }),
    new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
  )
  white.position.z = -DEPTH / 2
  white.castShadow = true
  body.add(white)

  const glowMaterial = new MeshBasicMaterial({
    map: glowTexture(),
    color: '#dfe6ff',
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  })
  const glowGeometry = new PlaneGeometry(triH * GLOW_SCALE, triH * GLOW_SCALE)
  for (const z of [DEPTH / 2 + 0.08, -(DEPTH / 2 + 0.08)]) {
    const glow = new Mesh(glowGeometry, glowMaterial)
    glow.position.z = z
    if (z < 0) glow.rotation.y = Math.PI
    body.add(glow)
  }

  const light = new PointLight('#dfe7ff', 6, 8, 1.6)
  light.position.y = restY
  group.add(light)

  const smoke = smokeTexture()
  const puffs: Puff[] = []
  for (let i = 0; i < SMOKE_COUNT; i++) {
    const material = new SpriteMaterial({ map: smoke, color: '#e4e9f3', transparent: true, opacity: 0, depthWrite: false })
    const sprite = new Sprite(material)
    group.add(sprite)
    const puff: Puff = { sprite, material, life: i / SMOKE_COUNT, x: 0, z: 0, drift: 0 }
    respawn(puff)
    puffs.push(puff)
  }

  return {
    group,
    update(dt, elapsed) {
      body.position.y = restY + Math.sin(elapsed * 1.1) * 0.1
      body.rotation.y = Math.sin(elapsed * 0.45) * 0.35
      body.rotation.x = Math.sin(elapsed * 0.7) * 0.05
      light.position.y = body.position.y
      for (const puff of puffs) {
        puff.life += dt / SMOKE_LIFE
        if (puff.life >= 1) {
          puff.life -= 1
          respawn(puff)
        }
        const t = puff.life
        puff.sprite.position.set(puff.x + puff.drift * t, 0.05 + t * (baseY + 0.6), puff.z + puff.drift * t * 0.6)
        const s = 0.7 + t * 1.3
        puff.sprite.scale.set(s, s, 1)
        puff.material.opacity = Math.sin(t * Math.PI) * 0.6
      }
    },
  }
}
