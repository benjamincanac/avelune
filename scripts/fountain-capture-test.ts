import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Matrix4, PerspectiveCamera } from 'three'
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

test('camera motion, rotation, projection and pool transforms invalidate captured projections', () => {
  const camera = new PerspectiveCamera(60, 1)
  const surface = new Matrix4()
  const schedule = createFountainCaptureSchedule()
  schedule.captured(0, camera, surface)

  camera.position.x = 0.001
  camera.updateMatrixWorld()
  assert.equal(schedule.needsCapture(1, 400, camera, surface), true)
  schedule.captured(1, camera, surface)

  camera.rotation.y = 0.001
  camera.updateMatrixWorld()
  assert.equal(schedule.needsCapture(2, 400, camera, surface), true)
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
