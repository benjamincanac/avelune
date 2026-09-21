import { Matrix4 } from 'three'
import type { Camera } from 'three'

/** Reflection and refraction both retain their capture projection. Camera
 * motion can therefore reuse a capture within its budget instead of redrawing
 * the world on every mouse move (or tiny camera smoothing correction). */
export function createFountainCaptureSchedule() {
  const refractionMatrix = new Matrix4()
  const projection = new Matrix4()
  const surfaceWorld = new Matrix4()
  let capturedCamera: Camera | null = null
  let capturedAt = -Infinity

  return {
    refractionMatrix,
    needsCapture(now: number, distanceSquared: number, camera: Camera, surface: Matrix4) {
      if (capturedCamera !== camera
        || !projection.equals(camera.projectionMatrix)
        || !surfaceWorld.equals(surface)) return true
      const interval = distanceSquared <= 12 * 12 ? 1000 / 30 : 1000 / 10
      return now < capturedAt || now - capturedAt >= interval
    },
    // Commit only after both renders succeed; an interrupted capture must not
    // suppress the next attempt or pair a new projection with an old texture.
    captured(now: number, camera: Camera, surface: Matrix4) {
      capturedAt = now
      capturedCamera = camera
      refractionMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      projection.copy(camera.projectionMatrix)
      surfaceWorld.copy(surface)
    },
  }
}
