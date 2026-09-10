import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three'
import { createRng } from '#shared/utils/maze'

/** Low-contrast pigment variation, without photographic detail that fights the
 * characters. Small tiled maps keep the whole courtyard self-contained. */
export function makeCourtyardSurface(kind: 'plaster' | 'stone' | 'sand') {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  const ctx = canvas.getContext('2d')!
  const rng = createRng(kind === 'sand' ? 126 : 534)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 512, 512)
  for (let i = 0; i < 120; i++) {
    const x = rng() * 512
    const y = rng() * 512
    const radius = 12 + rng() * (kind === 'sand' ? 70 : 35)
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, `rgba(103, 88, 62, ${0.006 + rng() * 0.018})`)
    gradient.addColorStop(1, 'rgba(103, 88, 62, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }
  for (let i = 0; i < 18000; i++) {
    const light = rng() > 0.5
    ctx.fillStyle = light ? 'rgba(255,255,255,0.12)' : 'rgba(71,61,46,0.018)'
    ctx.fillRect(rng() * 512, rng() * 512, 0.5 + rng() * 1.5, 0.5 + rng() * 1.5)
  }
  if (kind === 'sand') {
    ctx.strokeStyle = 'rgba(92,75,47,0.045)'
    ctx.lineWidth = 1
    for (let i = 0; i < 110; i++) {
      const y = rng() * 512
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.bezierCurveTo(130, y - 12, 340, y + 12, 512, y)
      ctx.stroke()
    }
  }
  const map = new CanvasTexture(canvas)
  map.colorSpace = SRGBColorSpace
  map.wrapS = map.wrapT = RepeatWrapping
  map.anisotropy = 4
  return map
}
