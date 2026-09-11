import { CanvasTexture, SRGBColorSpace } from 'three'
import { createRng } from '#shared/utils/arena'
import type { BrandLogo } from '~/utils/vercelBrands'

/**
 * Procedural canvas textures — the arena's entire art budget.
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

/** Meadow grass: layered blades over soil, with dirt patches and clover flecks. */
export function makeGrassTexture(seed: number, palette: StonePalette): CanvasTexture {
  const rng = createRng(seed)
  return canvasTexture(256, (ctx) => {
    // Soil base.
    ctx.fillStyle = palette.dark
    ctx.fillRect(0, 0, 256, 256)

    // A few bare-earth patches so the ground isn't a flat green.
    ctx.fillStyle = palette.mortar
    for (let i = 0; i < 7; i++) {
      ctx.globalAlpha = 0.5 + rng() * 0.3
      ctx.beginPath()
      ctx.ellipse(rng() * 256, rng() * 256, 12 + rng() * 26, 10 + rng() * 20, rng() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Dense blades: short strokes in green shades, brighter toward the tips.
    ctx.lineCap = 'round'
    const greens = [palette.base, palette.dark, palette.moss]
    for (let i = 0; i < 2600; i++) {
      const x = rng() * 256
      const y = rng() * 256
      const len = 3 + rng() * 6
      const lean = (rng() - 0.5) * 4
      ctx.strokeStyle = greens[(rng() * greens.length) | 0]!
      ctx.globalAlpha = 0.5 + rng() * 0.5
      ctx.lineWidth = 0.8 + rng() * 0.9
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + lean, y - len)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // Occasional pale clover/flower flecks.
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = rng() < 0.5 ? palette.moss : '#c9d6a0'
      ctx.globalAlpha = 0.5 + rng() * 0.4
      ctx.beginPath()
      ctx.arc(rng() * 256, rng() * 256, 0.8 + rng() * 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
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

/* -------------------------------------------------------------------------- */
/* Stadium: LED brand strip, centre mark, crowd, glow                         */
/* -------------------------------------------------------------------------- */

/** Brand face. A web font, so early boards are redrawn once it lands (see stadium.ts). */
export const BOARD_FAMILY = 'Geist'
const BOARD_FONT = `${BOARD_FAMILY}, ui-sans-serif, system-ui, sans-serif`

export interface BoardStyle {
  bg: string
  fg: string
  /** Lead with the Vercel triangle. */
  mark: boolean
}

/** The Vercel mark: an equilateral triangle `size` tall, centred on (cx, cy). */
export function drawVercelMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const half = size / Math.sqrt(3)
  ctx.beginPath()
  ctx.moveTo(cx, cy - size / 2)
  ctx.lineTo(cx + half, cy + size / 2)
  ctx.lineTo(cx - half, cy + size / 2)
  ctx.closePath()
  ctx.fill()
}

export interface LedStripCell {
  label: string
  style: BoardStyle
  /** The brand's own mark, drawn instead of the ▲. */
  logo?: BrandLogo
  /** False when the logo already is the wordmark (v0). */
  wordmark?: boolean
}

/** One LED cell at (x, y): solid field, the brand's mark or the ▲, and a label fitted to the cell width. */
export function drawBrandCell(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cell: LedStripCell) {
  const { style, logo } = cell
  const label = cell.wordmark === false ? '' : cell.label
  ctx.fillStyle = style.bg
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = style.fg

  const pad = h * 0.18
  // A logo is a square box; the ▲ is measured by its height.
  const mark = logo ? h * (label ? 0.5 : 0.62) : style.mark ? h * 0.4 : 0
  const markWidth = logo ? mark : (2 * mark) / Math.sqrt(3)
  const gap = mark && label ? h * 0.15 : 0
  // Fit the label: long names shrink, short ones cap, so every cell fills its field.
  let px = Math.round(h * 0.4)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  for (; px > 8; px -= 2) {
    ctx.font = `600 ${px}px ${BOARD_FONT}`
    if (markWidth + gap + ctx.measureText(label).width <= w - pad * 2) break
  }
  // Centre the mark + label as one group.
  let lx = x + (w - (markWidth + gap + ctx.measureText(label).width)) / 2
  if (logo) {
    ctx.save()
    ctx.translate(lx, y + (h - mark) / 2)
    ctx.scale(mark / 24, mark / 24)
    ctx.fillStyle = logo.color ?? style.fg
    ctx.fill(new Path2D(logo.path))
    ctx.restore()
    ctx.fillStyle = style.fg
    lx += markWidth + gap
  }
  else if (style.mark) {
    drawVercelMark(ctx, lx + markWidth / 2, y + h / 2, mark)
    lx += markWidth + gap
  }
  // `middle` centres the em box; caps sit a touch high, so nudge down.
  if (label) ctx.fillText(label, lx, y + h / 2 + px * 0.04)
}

/**
 * A continuous LED ribbon: the cells side by side with accent dividers and rails.
 * Meant to wrap a cylinder with `RepeatWrapping` and scroll via `offset.x`.
 * Draws into the caller's canvas so it can be repainted once the web font lands.
 */
export function drawLedStrip(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, cells: LedStripCell[], accent: string) {
  const { width: w, height: h } = canvas
  const cw = w / cells.length
  cells.forEach((cell, i) => drawBrandCell(ctx, Math.round(i * cw), 0, Math.ceil(cw), h, cell))
  ctx.fillStyle = accent
  const bar = Math.max(2, Math.round(h * 0.025))
  // One divider per seam, including the wrap seam, so the loop never shows a joint.
  for (let i = 0; i <= cells.length; i++) ctx.fillRect(Math.round(i * cw) - bar / 2, 0, bar, h)
  ctx.fillRect(0, 0, w, bar)
  ctx.fillRect(0, h - bar, w, bar)
}

/** A soft, faceless spectator silhouette, white so each instance can tint it. */
export function makeCrowdTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.filter = 'blur(1.2px)'
  ctx.fillStyle = '#ffffff'
  // Shoulders and torso.
  ctx.beginPath()
  ctx.moveTo(9, 96)
  ctx.lineTo(9, 54)
  ctx.quadraticCurveTo(9, 37, 25, 35)
  ctx.lineTo(39, 35)
  ctx.quadraticCurveTo(55, 37, 55, 54)
  ctx.lineTo(55, 96)
  ctx.closePath()
  ctx.fill()
  // Head.
  ctx.beginPath()
  ctx.arc(32, 20, 13, 0, Math.PI * 2)
  ctx.fill()
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Vertical soft falloff, white on transparent: the additive spill behind an LED band. */
export function makeGlowBandTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 128)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.9)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 4, 128)
  return new CanvasTexture(canvas)
}

/** Radial soft falloff, white on transparent: a floodlight's bloom sprite. */
export function makeRadialGlowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  return new CanvasTexture(canvas)
}

/**
 * The stadium's centre mark, pitch-style: the touchline ring, a centre circle,
 * and the Vercel triangle inside it. White, so the material tints it.
 */
export function makeVercelCenterTexture(): CanvasTexture {
  return canvasTexture(512, (ctx) => {
    const c = 256
    ctx.clearRect(0, 0, 512, 512)
    ctx.strokeStyle = '#ffffff'
    ctx.fillStyle = '#ffffff'
    for (const [radius, width] of [[244, 6], [228, 2], [104, 3]] as const) {
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.arc(c, c, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    // A ▲'s mass sits low; lift it a touch so it reads centred in the circle.
    ctx.globalAlpha = 0.6
    drawVercelMark(ctx, c, c - 8, 120)
    ctx.globalAlpha = 1
  })
}

/* -------------------------------------------------------------------------- */
/* Coach: triangle rim light and smoke                                       */
/* -------------------------------------------------------------------------- */

/** The vercel.com hero's rim light: a blurred white triangle outline, brightest at the apex. */
export function makeTriangleGlowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  const ctx = canvas.getContext('2d')!
  // Equilateral, 276 px tall, centroid on the canvas centre.
  const outline = () => {
    ctx.beginPath()
    ctx.moveTo(256, 72)
    ctx.lineTo(416, 348)
    ctx.lineTo(96, 348)
    ctx.closePath()
  }
  ctx.strokeStyle = '#ffffff'
  ctx.lineJoin = 'round'
  ctx.shadowColor = '#ffffff'
  for (const [blur, width, alpha] of [[70, 14, 0.35], [30, 8, 0.6], [8, 4, 1]] as const) {
    ctx.shadowBlur = blur
    ctx.lineWidth = width
    ctx.globalAlpha = alpha
    outline()
    ctx.stroke()
  }
  // Apex hot spot.
  ctx.shadowBlur = 0
  ctx.globalAlpha = 1
  const g = ctx.createRadialGradient(256, 92, 0, 256, 92, 110)
  g.addColorStop(0, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 512, 512)
  return new CanvasTexture(canvas)
}

/** A soft puff on transparent, white so the sprite tints it: one smoke particle. */
export function makeSmokeTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const rng = createRng(11)
  for (let i = 0; i < 7; i++) {
    const x = 64 + (rng() - 0.5) * 50
    const y = 64 + (rng() - 0.5) * 50
    const r = 26 + rng() * 22
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(255,255,255,0.32)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
  }
  return new CanvasTexture(canvas)
}
