import { CanvasTexture, PlaneGeometry, SRGBColorSpace } from 'three'
import { createOutfitMaterialPool } from './appearance'

export const BLOB_RADIUS = 0.34
export const BLOB_OPACITY = 0.35

/** Shared by every player in one scene. Player components borrow the blob
 * geometry and texture and release outfit leases before this owner disposes. */
export function createPlayerResources() {
  const blobGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
  gradient.addColorStop(0.45, 'rgba(0, 0, 0, 0.72)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  const blobTexture = new CanvasTexture(canvas)
  blobTexture.colorSpace = SRGBColorSpace
  const outfits = createOutfitMaterialPool()
  let disposed = false

  return {
    blobGeometry,
    blobTexture,
    outfits,
    dispose() {
      if (disposed) return
      disposed = true
      outfits.dispose()
      blobGeometry.dispose()
      blobTexture.dispose()
    },
  }
}

export type PlayerResources = ReturnType<typeof createPlayerResources>
