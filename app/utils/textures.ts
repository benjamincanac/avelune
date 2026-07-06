import { CanvasTexture, SRGBColorSpace } from 'three'
import { createRng } from '#shared/utils/maze'

/**
 * Procedural canvas textures — the dungeon's entire art budget.
 *
 * Everything is drawn deterministically from a seed at runtime, so the game
 * ships zero image assets and every client paints identical stone.
 */

export interface StonePalette {
  base: string
  dark: string
  mortar: string
  moss: string
  /** 0..1 fraction of bricks that get a moss blotch. */
  mossAmount: number
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  draw(canvas.getContext('2d')!)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Weathered brick wall: offset courses, mortar seams, grime, and moss. */
export function makeBrickTexture(seed: number, palette: StonePalette): CanvasTexture {
  const rng = createRng(seed)
  return canvasTexture(256, (ctx) => {
    ctx.fillStyle = palette.mortar
    ctx.fillRect(0, 0, 256, 256)

    const rows = 8
    const bh = 256 / rows
    for (let row = 0; row < rows; row++) {
      const offset = row % 2 === 0 ? 0 : 32
      for (let col = -1; col < 4; col++) {
        const bw = 64
        const x = col * bw + offset + (rng() - 0.5) * 3
        const y = row * bh + (rng() - 0.5) * 2
        const shade = rng()
        ctx.fillStyle = shade < 0.5 ? palette.base : palette.dark
        ctx.fillRect(x + 2, y + 2, bw - 4, bh - 4)
        // Grime speckles.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.18)'
        for (let i = 0; i < 6; i++) {
          ctx.fillRect(x + 4 + rng() * (bw - 10), y + 4 + rng() * (bh - 10), 2 + rng() * 3, 1 + rng() * 2)
        }
        // Moss creeping over some bricks.
        if (rng() < palette.mossAmount) {
          ctx.fillStyle = palette.moss
          ctx.globalAlpha = 0.5 + rng() * 0.3
          ctx.beginPath()
          ctx.ellipse(x + rng() * bw, y + bh - 4, 8 + rng() * 14, 4 + rng() * 5, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }
      }
    }
  })
}

/** Cobblestone ground: jittered rounded stones over dirt. */
export function makeCobbleTexture(seed: number, palette: StonePalette): CanvasTexture {
  const rng = createRng(seed)
  return canvasTexture(256, (ctx) => {
    ctx.fillStyle = palette.mortar
    ctx.fillRect(0, 0, 256, 256)

    const grid = 6
    const cell = 256 / grid
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const cx = gx * cell + cell / 2 + (rng() - 0.5) * 8
        const cy = gy * cell + cell / 2 + (rng() - 0.5) * 8
        const shade = rng()
        ctx.fillStyle = shade < 0.55 ? palette.base : palette.dark
        ctx.beginPath()
        ctx.ellipse(cx, cy, cell * 0.42 + rng() * 4, cell * 0.36 + rng() * 4, rng() * Math.PI, 0, Math.PI * 2)
        ctx.fill()
        if (rng() < palette.mossAmount * 0.8) {
          ctx.fillStyle = palette.moss
          ctx.globalAlpha = 0.4 + rng() * 0.3
          ctx.beginPath()
          ctx.ellipse(cx + (rng() - 0.5) * 12, cy + (rng() - 0.5) * 12, 6 + rng() * 8, 4 + rng() * 6, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }
      }
    }
    // Dust highlights.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
    for (let i = 0; i < 40; i++) {
      ctx.fillRect(rng() * 256, rng() * 256, 2, 2)
    }
  })
}

/** Glowing cracks on black, used as an emissive map for the Magma Halls. */
export function makeCrackTexture(seed: number): CanvasTexture {
  const rng = createRng(seed)
  return canvasTexture(256, (ctx) => {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 256, 256)
    ctx.strokeStyle = '#ff6a1a'
    ctx.lineCap = 'round'
    for (let i = 0; i < 10; i++) {
      let x = rng() * 256
      let y = rng() * 256
      ctx.lineWidth = 1.5 + rng() * 2
      ctx.beginPath()
      ctx.moveTo(x, y)
      for (let step = 0; step < 8; step++) {
        x += (rng() - 0.5) * 60
        y += (rng() - 0.5) * 60
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  })
}

/**
 * A summoning-style teleport circle: concentric rings, radial spokes, an
 * inscribed star, and a band of glyphs. Drawn white so the material tints it.
 */
export function makeRuneCircleTexture(seed: number): CanvasTexture {
  const rng = createRng(seed)
  return canvasTexture(512, (ctx) => {
    const c = 256
    ctx.clearRect(0, 0, 512, 512)
    ctx.strokeStyle = '#ffffff'
    ctx.fillStyle = '#ffffff'

    const ring = (radius: number, width: number) => {
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.arc(c, c, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    ring(244, 5)
    ring(232, 2)
    ring(170, 3)
    ring(160, 1.5)
    ring(84, 2.5)

    // Inscribed star polygon.
    const points = 7
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i <= points; i++) {
      const angle = ((i * 3) % points) / points * Math.PI * 2 - Math.PI / 2
      const x = c + Math.cos(angle) * 160
      const y = c + Math.sin(angle) * 160
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.stroke()

    // Radial spokes between the middle rings.
    ctx.lineWidth = 1.5
    for (let i = 0; i < 28; i++) {
      const angle = (i / 28) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(angle) * 170, c + Math.sin(angle) * 170)
      ctx.lineTo(c + Math.cos(angle) * 232, c + Math.sin(angle) * 232)
      ctx.stroke()
    }

    // Glyph band: invented runes, a few strokes each.
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2
      const gx = c + Math.cos(angle) * 201
      const gy = c + Math.sin(angle) * 201
      ctx.save()
      ctx.translate(gx, gy)
      ctx.rotate(angle + Math.PI / 2)
      ctx.lineWidth = 2
      for (let stroke = 0; stroke < 3; stroke++) {
        ctx.beginPath()
        ctx.moveTo((rng() - 0.5) * 16, (rng() - 0.5) * 20)
        ctx.lineTo((rng() - 0.5) * 16, (rng() - 0.5) * 20)
        if (rng() < 0.5) ctx.lineTo((rng() - 0.5) * 16, (rng() - 0.5) * 20)
        ctx.stroke()
      }
      ctx.restore()
    }

    // Center sigil.
    ctx.lineWidth = 2.5
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 - Math.PI / 2
      ctx.beginPath()
      ctx.arc(c + Math.cos(angle) * 34, c + Math.sin(angle) * 34, 26, 0, Math.PI * 2)
      ctx.stroke()
    }
  })
}
