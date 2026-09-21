import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Matrix4, PerspectiveCamera, Vector4 } from 'three'
import { createFountainCaptureSchedule } from '../app/utils/fountainCapture'

test('water captures immediately, then limits unchanged near and distant views', () => {
  const camera = new PerspectiveCamera()
  const surface = new Matrix4()
  const near = createFountainCaptureSchedule()
  assert.equal(near.needsCapture(0, 4, camera, surface), true)
  near.captured(0, camera, surface)
  assert.equal(near.needsCapture(1000 / 60, 4, camera, surface), false)
  assert.equal(near.needsCapture(1000 / 30, 4, camera, surface), true)

  const distant = createFountainCaptureSchedule()
  distant.captured(0, camera, surface)
  assert.equal(distant.needsCapture(99, 400, camera, surface), false)
  assert.equal(distant.needsCapture(100, 400, camera, surface), true)
})

test('moving cameras obey the capture budget; projection and pool changes invalidate it', () => {
  const camera = new PerspectiveCamera(60, 1)
  const surface = new Matrix4()
  const schedule = createFountainCaptureSchedule()
  schedule.captured(0, camera, surface)

  camera.position.x = 0.001
  camera.updateMatrixWorld()
  assert.equal(schedule.needsCapture(1, 400, camera, surface), false)
  schedule.captured(1, camera, surface)

  camera.rotation.y = 0.001
  camera.updateMatrixWorld()
  assert.equal(schedule.needsCapture(2, 400, camera, surface), false)
  schedule.captured(2, camera, surface)

  camera.aspect = 2
  camera.updateProjectionMatrix()
  assert.equal(schedule.needsCapture(3, 400, camera, surface), true)
  schedule.captured(3, camera, surface)

  surface.makeTranslation(1, 0, 0)
  assert.equal(schedule.needsCapture(4, 400, camera, surface), true)
  schedule.captured(4, camera, surface)
  assert.equal(schedule.needsCapture(5, 400, camera, surface), false)
})

test('switching cameras and uncommitted captures always retry immediately', () => {
  const camera = new PerspectiveCamera()
  const surface = new Matrix4()
  const schedule = createFountainCaptureSchedule()
  assert.equal(schedule.needsCapture(0, 400, camera, surface), true)
  assert.equal(schedule.needsCapture(1, 400, camera, surface), true)
  schedule.captured(1, camera, surface)
  assert.equal(schedule.needsCapture(2, 400, camera.clone(), surface), true)
  assert.equal(schedule.needsCapture(0, 400, camera, surface), true)
})

test('a continuously moving distant camera cannot redraw the world every frame', () => {
  const camera = new PerspectiveCamera()
  const surface = new Matrix4()
  const schedule = createFountainCaptureSchedule()
  let captures = 0
  for (let frame = 0; frame < 60; frame++) {
    camera.position.x = frame * 0.01
    camera.updateMatrixWorld()
    if (schedule.needsCapture(frame * 1000 / 60, 400, camera, surface)) {
      captures++
      schedule.captured(frame * 1000 / 60, camera, surface)
    }
  }
  assert.ok(captures <= 10, `Expected at most 10 captures, got ${captures}`)
})

test('refraction retains the captured world projection until a new image is committed', () => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 3, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const surface = new Matrix4()
  const schedule = createFountainCaptureSchedule()
  schedule.captured(0, camera, surface)
  const point = new Vector4(1, 0, 0, 1)
  const captured = point.clone().applyMatrix4(schedule.refractionMatrix)
  camera.position.x = 2
  camera.updateMatrixWorld()
  assert.deepEqual(point.clone().applyMatrix4(schedule.refractionMatrix), captured)
  schedule.captured(100, camera, surface)
  assert.notDeepEqual(point.clone().applyMatrix4(schedule.refractionMatrix), captured)
  assert.deepEqual(point.clone().applyMatrix4(schedule.refractionMatrix), point.clone().applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix))
})
