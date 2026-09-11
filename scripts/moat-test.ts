import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateHub, stepBody, JUMP_VELOCITY, getSwimmingContact } from '../shared/utils/maze'
import { MOAT } from '../shared/utils/moat'

const plan = generateHub()
function body(x: number, y: number, z = 0) {
  return { x, y, z, vz: 0, grounded: true }
}
function walk(b: ReturnType<typeof body>, dx: number, dy: number, ticks = 100) {
  for (let i = 0; i < ticks; i++) stepBody(plan, b, dx * 0.16, dy * 0.16, 0.05)
}
for (const [x, y, dx, dy] of [[92, 22, 0, 1], [92, 122, 0, -1], [22, 92, 1, 0], [122, 92, -1, 0]]) {
  test(`fall into moat at ${x},${y} floats and stops at the inner bank`, () => {
    const b = body(x!, y!)
    walk(b, dx!, dy!)
    assert.ok(Math.abs(b.z - (MOAT.waterHeight - MOAT.swimDraft)) < 0.01)
    assert.equal(b.grounded, false)
    b.vz = JUMP_VELOCITY
    b.grounded = false
    walk(b, dx!, dy!)
    assert.ok(Math.abs(b.z - (MOAT.waterHeight - MOAT.swimDraft)) < 0.01)
  })
}
test('moat escape stairs connect the bed to dry exterior ground both ways', () => {
  const b = body(84, 117, MOAT.floorHeight)
  walk(b, 0, 1)
  assert.ok(b.y > 124)
  assert.equal(b.z, 0)
  walk(b, 0, -1)
  assert.ok(b.y < 118)
  assert.ok(Math.abs(b.z - (MOAT.waterHeight - MOAT.swimDraft)) < 0.01)
})
test('water limits swimming speed and repeated simulation is deterministic', () => {
  const wet = body(90, 118, MOAT.floorHeight)
  const copy = { ...wet }
  const dry = body(90, 130)
  walk(wet, 1, 0, 10)
  walk(copy, 1, 0, 10)
  walk(dry, 1, 0, 10)
  assert.deepEqual(wet, copy)
  assert.ok(wet.x - 90 < (dry.x - 90) * 0.7)
})
test('bridge supports the gate approach and preserves its underwater arch passage', () => {
  const above = body(72, 125)
  walk(above, 0, -1)
  assert.equal(above.z, 0)
  const below = body(66, 117, MOAT.floorHeight)
  walk(below, 1, 0, 130)
  assert.ok(below.x > 76)
  assert.ok(Math.abs(below.z - (MOAT.waterHeight - MOAT.swimDraft)) < 0.01)
  const jump = body(72, 117, MOAT.floorHeight)
  jump.vz = JUMP_VELOCITY
  jump.grounded = false
  for (let i = 0; i < 60; i++) {
    stepBody(plan, jump, 0, 0, 0.05)
    assert.ok(jump.z <= MOAT.bridgeUnderside - MOAT.bodyHeight)
  }
  assert.ok(Math.abs(jump.z - (MOAT.bridgeUnderside - MOAT.bodyHeight)) < 0.01)
})
test('bridge piers block underwater movement', () => {
  const b = body(66, 119.5, MOAT.floorHeight)
  walk(b, 1, 0)
  assert.ok(b.x < 68)
})

test('escape stair retaining walls prevent clipping through their sides', () => {
  for (const direction of [-1, 1]) {
    const b = body(84, 120, -1.6)
    walk(b, direction, 0)
    assert.ok(Math.abs(b.x - 84) < 1.3)
  }
})

test('deep water absorbs a high fall without teleporting and never grants a grounded jump', () => {
  const b = body(92, 118, 7.5)
  b.grounded = false
  let entered = false
  for (let i = 0; i < 240; i++) {
    const previous = b.z
    stepBody(plan, b, 0, 0, 1 / 60)
    assert.ok(b.z >= MOAT.floorHeight)
    assert.ok(Math.abs(b.z - previous) < 0.5)
    if (getSwimmingContact(plan, b)) entered = true
    if (entered) assert.equal(b.grounded, false)
  }
  assert.ok(entered)
  assert.ok(Math.abs(b.z - (MOAT.waterHeight - MOAT.swimDraft)) < 0.001)
})
test('swimming suppresses dash acceleration and agrees across 20 and 60 Hz', () => {
  const simulate = (hz: number, multiplier: number) => {
    const b = body(90, 118, MOAT.waterHeight - MOAT.swimDraft)
    b.grounded = false
    for (let i = 0; i < hz * 2; i++) stepBody(plan, b, 3.2 * multiplier / hz, 0, 1 / hz)
    return b
  }
  const server = simulate(20, 1)
  const client = simulate(60, 1)
  const dash = simulate(20, 2.9)
  assert.ok(Math.abs(server.x - 93.6) < 0.001)
  assert.ok(Math.abs(server.x - client.x) < 0.001)
  assert.ok(Math.abs(server.z - client.z) < 0.001)
  assert.ok(Math.abs(server.x - dash.x) < 0.001)
})
test('shallow escape steps and fountain basins do not activate swimming', () => {
  assert.equal(getSwimmingContact(plan, body(84, 120, -1.6)), null)
  assert.equal(getSwimmingContact(plan, body(73, 72, 0.168)), null)
  assert.ok(getSwimmingContact(plan, body(92, 118, -1.95)))
})
