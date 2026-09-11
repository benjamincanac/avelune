// Run with: pnpm exec jiti scripts/rampart-test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateHub, stepBody, JUMP_VELOCITY, DASH_DURATION, DASH_MULTIPLIER, PLAYER_SPEED } from '../shared/utils/maze'
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

test('jumping on stairs returns to its tread and can clear side rails', () => {
  const b = body(40, 99)
  stepBody(plan, b, 0, 0, 0.05)
  const tread = b.z
  b.vz = JUMP_VELOCITY
  b.grounded = false
  for (let i = 0; i < 30; i++) stepBody(plan, b, 0, 0, 0.05)
  assert.equal(b.z, tread)
  b.vz = JUMP_VELOCITY
  b.grounded = false
  for (let i = 0; i < 60; i++) stepBody(plan, b, 0.1, 0, 1 / 32)
  assert.ok(b.x > 42)
  assert.equal(b.z, 0)
})
test('camera obstruction respects gallery slab and finite rail height', () => {
  assert.equal(isRampartCameraBlocked(72, 108, 3, 0.2), false)
  assert.equal(isRampartCameraBlocked(72, 108, 5.8, 0.2), true)
  assert.equal(isRampartCameraBlocked(72, 108, 7.5, 0.2), false)
  assert.equal(isRampartCameraBlocked(72, 109.5, 6.5, 0.2), true)
  assert.equal(isRampartCameraBlocked(41.5, 99, 4, 0.2), true)
})

for (const [name, x, y, dx, dy] of [
  ['north', 92, 36, 0, -1], ['south', 92, 108, 0, 1],
  ['west', 36, 92, -1, 0], ['east', 108, 92, 1, 0],
] as const) {
  for (const dash of [false, true]) {
    test(`${name} rail can be jumped outward into the moat${dash ? ' with a dash' : ''}`, () => {
      const b = body(x, y, 6)
      // Walk up against the railing first, then hold the same direction and jump.
      for (let i = 0; i < 60; i++) stepBody(plan, b, dx * PLAYER_SPEED / 60, dy * PLAYER_SPEED / 60, 1 / 60)
      assert.equal(b.z, 6)
      assert.ok(Math.hypot(b.x - x, b.y - y) < 1.2)
      b.vz = JUMP_VELOCITY
      b.grounded = false
      let peak = b.z
      for (let i = 0; i < 240; i++) {
        const speed = PLAYER_SPEED * (dash && i / 60 < DASH_DURATION ? DASH_MULTIPLIER : 1)
        const before = { ...b }
        stepBody(plan, b, dx * speed / 60, dy * speed / 60, 1 / 60)
        assert.ok(Math.hypot(b.x - before.x, b.y - before.y) <= speed / 60 + 0.001)
        peak = Math.max(peak, b.z)
      }
      assert.ok(peak > 7.2 && peak < 7.7)
      assert.ok(Math.abs(b.z - (-1.95)) < 0.01)
      assert.equal(b.grounded, false)
      const outward = dx ? b.x : b.y
      assert.ok(dx + dy > 0 ? outward >= 115 && outward < 121 : outward > 23 && outward < 29)
    })
  }
}
test('jumping the inner rail lands back on city ground', () => {
  const b = body(92, 36, 6)
  for (let i = 0; i < 60; i++) stepBody(plan, b, 0, PLAYER_SPEED / 60, 1 / 60)
  b.vz = JUMP_VELOCITY
  b.grounded = false
  for (let i = 0; i < 120; i++) stepBody(plan, b, 0, PLAYER_SPEED / 60, 1 / 60)
  assert.ok(b.y > 39)
  assert.equal(b.z, 0)
})
