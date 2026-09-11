// Run with: pnpm exec jiti scripts/rampart-test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateHub, stepBody, JUMP_VELOCITY } from '../shared/utils/maze'
import type { KinematicBody } from '../shared/utils/maze'
import { isRampartCameraBlocked, RAMPART_STAIRS } from '../shared/utils/ramparts'

const plan = generateHub()
function body(x: number, y: number, z = 0): KinematicBody {
  return { x, y, z, vz: 0, grounded: true }
}
function travel(b: KinematicBody, x: number, y: number) {
  const steps = Math.ceil(Math.hypot(x - b.x, y - b.y) / 0.1)
  const dx = (x - b.x) / steps
  const dy = (y - b.y) / steps
  for (let i = 0; i < steps; i++) stepBody(plan, b, dx, dy, 1 / 32)
  assert.ok(Math.hypot(b.x - x, b.y - y) < 0.02, `Stopped at ${b.x},${b.y},${b.z} before ${x},${y}`)
}
for (const stair of RAMPART_STAIRS) {
  test(`stairs at ${stair.x} ascend and descend without jumping`, () => {
    const b = body(stair.x, stair.zStart - 1)
    travel(b, stair.x, 108)
    assert.equal(b.z, 6)
    assert.equal(b.grounded, true)
    travel(b, stair.x, stair.zStart - 1)
    assert.equal(b.z, 0)
    assert.equal(b.grounded, true)
  })
}
test('connected gallery can be walked around all four corners', () => {
  const b = body(40, 89)
  for (const [x, y] of [[40, 108], [36, 108], [36, 36], [108, 36], [108, 108], [104, 108], [104, 89]]) travel(b, x!, y!)
  assert.equal(b.z, 0)
})
test('ground gate passage stays open below the gallery', () => {
  const b = body(72, 125)
  travel(b, 72, 102)
  assert.equal(b.z, 0)
})
test('standing below the gallery never snaps onto its deck', () => {
  const b = body(72, 108)
  for (let i = 0; i < 100; i++) stepBody(plan, b, 0, 0, 0.05)
  assert.equal(b.z, 0)
  b.vz = JUMP_VELOCITY
  b.grounded = false
  for (let i = 0; i < 50; i++) stepBody(plan, b, 0, 0, 0.05)
  assert.equal(b.z, 0)
})
test('gallery rails prevent walking off either edge', () => {
  for (const direction of [-1, 1]) {
    const b = body(72, 36, 6)
    for (let i = 0; i < 100; i++) stepBody(plan, b, 0, direction * 0.16, 0.05)
    assert.ok(b.y > 34.7 && b.y < 37.3)
    assert.equal(b.z, 6)
  }
})
test('falling onto a gallery lands on the deck', () => {
  const b = body(72, 108, 9)
  b.grounded = false
  for (let i = 0; i < 60; i++) stepBody(plan, b, 0, 0, 0.05)
  assert.equal(b.z, 6)
})
test('stair prediction is deterministic and dash sized moves cannot skip rails', () => {
  const a = body(40, 89)
  const b = body(40, 89)
  for (let i = 0; i < 38; i++) {
    stepBody(plan, a, 0, 0.5, 0.05)
    stepBody(plan, b, 0, 0.5, 0.05)
  }
  assert.deepEqual(a, b)
  assert.equal(a.z, 6)
  for (let i = 0; i < 12; i++) stepBody(plan, a, 0, 0.5, 0.05)
  assert.ok(a.y < 109.2)
})

test('jumping on stairs lands on the same tread and cannot clip side rails', () => {
  const b = body(40, 99)
  stepBody(plan, b, 0, 0, 0.05)
  const tread = b.z
  b.vz = JUMP_VELOCITY
  b.grounded = false
  for (let i = 0; i < 30; i++) stepBody(plan, b, 0.16, 0, 0.05)
  assert.ok(b.x < 41.2)
  assert.equal(b.z, tread)
  travel(b, 40, 99)
  b.vz = JUMP_VELOCITY
  b.grounded = false
  travel(b, 40, 108)
  assert.equal(b.z, 6)
})
test('camera obstruction respects gallery slab and finite rail height', () => {
  assert.equal(isRampartCameraBlocked(72, 108, 3, 0.2), false)
  assert.equal(isRampartCameraBlocked(72, 108, 5.8, 0.2), true)
  assert.equal(isRampartCameraBlocked(72, 108, 7.5, 0.2), false)
  assert.equal(isRampartCameraBlocked(72, 109.5, 6.5, 0.2), true)
  assert.equal(isRampartCameraBlocked(41.5, 99, 4, 0.2), true)
})
