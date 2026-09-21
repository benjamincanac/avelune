import { Matrix4 } from 'three'
import type { Camera } from 'three'

/** Cache only an unchanged view: refraction samples live screen coordinates,
 * while Reflector retains its capture's texture matrix. A moved camera, changed
 * lens or moved pool therefore needs both textures refreshed immediately. */
export function createFountainCaptureSchedule() {
  const cameraWorld = new Matrix4()
  const projection = new Matrix4()
  const surfaceWorld = new Matrix4()
  let capturedCamera: Camera | null = null
  let capturedAt = -Infinity

  return {
    needsCapture(now: number, distanceSquared: number, camera: Camera, surface: Matrix4) {
      if (capturedCamera !== camera
        || !cameraWorld.equals(camera.matrixWorld)
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
      cameraWorld.copy(camera.matrixWorld)
      projection.copy(camera.projectionMatrix)
      surfaceWorld.copy(surface)
    },
  }
}
