// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/audio-test.ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { SURFACE, applyTerrain, createWorld } from '../shared/utils/world'
import {
  STRIDE_JOG,
  STRIDE_SPRINT,
  createFootstepState,
  footSurfaceAt,
  footSurfaceFor,
  stepFootsteps,
} from '../app/utils/audio/footsteps'

/** One frame of a body moving at a steady speed. */
function walk(speed: number, dt = 1 / 60, sprinting = false) {
  return { distance: speed * dt, dt, grounded: true, swimming: false, sprinting }
}

test('a jog puts a foot down every stride, and a sprint covers more ground per step', () => {
  const state = createFootstepState()
  let steps = 0
  let travelled = 0
  for (let i = 0; i < 600; i++) {
    travelled += walk(3.2).distance
    if (stepFootsteps(state, walk(3.2))) steps++
  }
  assert.equal(steps, Math.floor(travelled / STRIDE_JOG))

  const sprint = createFootstepState()
  let sprintSteps = 0
  for (let i = 0; i < 600; i++) if (stepFootsteps(sprint, walk(3.2, 1 / 60, true))) sprintSteps++
  assert.ok(sprintSteps < steps)
  assert.ok(STRIDE_SPRINT > STRIDE_JOG)
})

test('nothing steps while idle, airborne, swimming or creeping', () => {
  const state = createFootstepState()
  for (let i = 0; i < 300; i++) assert.equal(stepFootsteps(state, walk(0)), false)
  for (let i = 0; i < 300; i++) assert.equal(stepFootsteps(state, { ...walk(4), grounded: false }), false)
  for (let i = 0; i < 300; i++) assert.equal(stepFootsteps(state, { ...walk(4), swimming: true }), false)
  // Reconciliation nudges a standing body by millimetres. That is not a walk.
  for (let i = 0; i < 300; i++) assert.equal(stepFootsteps(state, walk(0.3)), false)
})

test('a jump does not bank the step it interrupted', () => {
  const state = createFootstepState()
  // Most of a stride on the ground, then off it: the stride is dropped, not
  // fired on touchdown where the landing sound already is.
  for (let i = 0; i < 20; i++) stepFootsteps(state, walk(3.2))
  assert.ok(state.travelled > 0)
  stepFootsteps(state, { ...walk(3.2), grounded: false })
  assert.equal(state.travelled, 0)
  assert.equal(state.airborne, true)
})

test('one footfall a frame at most, however long the frame was', () => {
  const state = createFootstepState()
  // A hitch worth four strides still lands one step.
  assert.equal(stepFootsteps(state, { distance: STRIDE_JOG * 4, dt: 1, grounded: true, swimming: false, sprinting: false }), true)
  assert.equal(state.travelled, 0)
})

test('every surface the raster can hold maps to a sound family', () => {
  assert.equal(footSurfaceFor(SURFACE.grass), 'grass')
  assert.equal(footSurfaceFor(SURFACE.dirt), 'dirt')
  assert.equal(footSurfaceFor(SURFACE.stone), 'stone')
  assert.equal(footSurfaceFor(SURFACE.sand), 'sand')
  assert.equal(footSurfaceFor(SURFACE.path), 'path')
  assert.equal(footSurfaceFor(SURFACE.water), 'water')
  assert.equal(footSurfaceFor(SURFACE.snow), 'snow')
  // An unknown or missing value is ground, not silence.
  assert.equal(footSurfaceFor(undefined), 'grass')
  assert.equal(footSurfaceFor(99), 'grass')
})

test('the surface under a foot is read from the streamed raster', () => {
  const world = createWorld()
  // Far from the town, so the protected placeholder is not in the way. The
  // paint brush rounds to the nearest corner, so this sits inside one tile.
  const x = 400.4
  const y = 400.4
  applyTerrain(world, { x, y, size: 1, mode: 'paint', surface: SURFACE.sand })
  assert.equal(footSurfaceAt(world, x, y), 'sand')

  // A chunk we do not hold cannot be sounded, and must not throw.
  const empty = createWorld({ generate: false, town: false })
  assert.equal(footSurfaceAt(empty, x, y), 'grass')
})

test('the town square is paving whatever its placeholder raster says', () => {
  const world = createWorld()
  assert.equal(footSurfaceAt(world, 72.5, 72.5), 'path')
})
