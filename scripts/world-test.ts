// Run with: pnpm exec jiti scripts/world-test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DASH_MULTIPLIER,
  generateHub,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  PLAYER_RADIUS,
  stepBody,
  surfaceHeight,
} from '../shared/utils/maze'
import type { FloorPlan, KinematicBody } from '../shared/utils/maze'
import { COURTYARD, COURTYARD_ASSETS } from '../shared/utils/courtyard'

const plan = generateHub()
const dt = 1 / 20
const bodyAt = (x: number, y: number): KinematicBody => ({ x, y, z: 0, vz: 0, grounded: true })

function walk(body: KinematicBody, x: number, y: number, steps = 100, speed = PLAYER_SPEED, world: FloorPlan = plan) {
  for (let i = 0; i < steps; i++) stepBody(world, body, x * speed * dt, y * speed * dt, dt)
  return body
}

test('spawn has ground and clearance in all eight directions', () => {
  assert.equal(surfaceHeight(plan, plan.start.x, plan.start.y), 0)
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 4 * i
    const body = walk(bodyAt(plan.start.x, plan.start.y), Math.cos(a), Math.sin(a), 10)
    assert.ok(Math.hypot(body.x - plan.start.x, body.y - plan.start.y) > 1.5)
    assert.equal(body.z, 0)
  }
})

test('all four perimeter sides contain walking and dashing players', () => {
  const approaches = [[28, 45, 0, 1], [25, 10, 0, -1], [10, 40, -1, 0], [45, 45, 1, 0]] as const
  for (const speed of [PLAYER_SPEED, PLAYER_SPEED * DASH_MULTIPLIER]) {
    for (const [x, y, dx, dy] of approaches) {
      const body = walk(bodyAt(x, y), dx, dy, 100, speed)
      assert.ok(body.x >= 8.3 && body.x <= 47.7 && body.y >= 8.3 && body.y <= 47.7)
    }
  }
})

test('placed buildings block their front approach, including rotated facades', () => {
  for (const prop of plan.props.filter(p => /Courtyard_(Inn|Shop|Tower)/.test(p.kind))) {
    const dx = Math.sin(prop.rot)
    const dy = Math.cos(prop.rot)
    const body = bodyAt(prop.x + dx * (prop.by! + 1), prop.y + dy * (prop.by! + 1))
    walk(body, -dx, -dy, 80)
    assert.equal(body.z, 0)
    assert.ok(Math.hypot(body.x - prop.x, body.y - prop.y) >= prop.by! - 0.01)
  }
})

test('diagonal building collision follows the visible Three.js Y rotation', () => {
  const inn = plan.props.find(p => p.kind === 'Courtyard_Inn')!
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    const prop = { ...inn, x: 28, y: 28, rot }
    const world = { ...plan, props: [prop] }
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const point = (x: number, y: number) => ({ x: prop.x + x * c + y * s, y: prop.y - x * s + y * c })
    const inside = point(3.8, 2.3)
    const outside = point(2.3, 3.8)
    assert.equal(surfaceHeight(world, inside.x, inside.y), prop.top)
    assert.equal(surfaceHeight(world, outside.x, outside.y), 0)
    // Approach an off-center part of the facade that the mirrored box misses.
    const start = point(3.5, 2.7)
    const body = walk(bodyAt(start.x, start.y), -s, -c, 8, PLAYER_SPEED, world)
    const localY = (body.x - prop.x) * s + (body.y - prop.y) * c
    assert.ok(localY > prop.by!)
    assert.equal(body.z, 0)
  }
})

test('tree trunks stop centered walking and dashing players', () => {
  for (const prop of plan.props.filter(p => p.kind === 'Courtyard_Tree')) {
    for (const speed of [PLAYER_SPEED, PLAYER_SPEED * DASH_MULTIPLIER]) {
      const body = walk(bodyAt(prop.x - prop.r - 1, prop.y), 1, 0, 100, speed)
      assert.ok(body.x <= prop.x - prop.r)
      assert.equal(body.z, 0)
    }
  }
})

test('central fountain uses its scaled collision footprint from every approach', () => {
  const fountains = plan.props.filter(p => p.kind === 'Courtyard_Fountain')
  assert.equal(fountains.length, 1)
  const prop = fountains[0]!
  assert.deepEqual({ x: prop.x, y: prop.y }, { x: COURTYARD.arena.x, y: COURTYARD.arena.y })
  assert.deepEqual(COURTYARD.fountain, { x: prop.x, y: prop.y })
  assert.equal(prop.scale, 1.4)
  assert.equal(prop.r, COURTYARD_ASSETS.Courtyard_Fountain.radius * 1.4)
  assert.equal(prop.top, COURTYARD_ASSETS.Courtyard_Fountain.height * 1.4)
  assert.equal(surfaceHeight(plan, prop.x + prop.r - 0.01, prop.y), prop.top)
  assert.equal(surfaceHeight(plan, prop.x + prop.r + 0.01, prop.y), 0)
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 4 * i
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    for (const speed of [PLAYER_SPEED, PLAYER_SPEED * DASH_MULTIPLIER]) {
      const distance = prop.r + PLAYER_RADIUS + 1
      const body = bodyAt(prop.x + dx * distance, prop.y + dy * distance)
      for (let step = 0; step < 20; step++) {
        walk(body, -dx, -dy, 1, speed)
        assert.ok(Math.hypot(body.x - prop.x, body.y - prop.y) > prop.r)
      }
      assert.equal(body.z, 0)
    }
  }
})

test('fountain blocks walking and grounded jumps', () => {
  const prop = plan.props.find(p => p.kind === 'Courtyard_Fountain')!
  for (const jump of [false, true]) {
    const body = bodyAt(prop.x, prop.y + prop.r + 0.2)
    if (jump) {
      body.vz = JUMP_VELOCITY
      body.grounded = false
    }
    walk(body, 0, -1)
    assert.ok(body.y > prop.y + prop.r)
    assert.equal(body.z, 0)
  }
})

test('bench blocks walking, supports jump landings, and allows walking off', () => {
  const prop = plan.props.find(p => p.kind === 'Courtyard_Bench' && p.x === 23)!
  const body = bodyAt(prop.x, prop.y - prop.by! - 0.2)
  walk(body, 0, 1, 10)
  assert.ok(body.y < prop.y - prop.by!)
  body.vz = JUMP_VELOCITY
  body.grounded = false
  walk(body, 0, 1, 4)
  walk(body, 0, 0, 30)
  assert.ok(body.y > prop.y - prop.by! && body.y < prop.y + prop.by!)
  assert.equal(body.z, prop.top)
  assert.equal(body.grounded, true)
  walk(body, 1, 0, 20)
  walk(body, 0, 0, 20)
  assert.equal(body.z, 0)
})

test('independently generated worlds produce identical movement', () => {
  const secondPlan = generateHub()
  assert.deepEqual(secondPlan, plan)
  const a = bodyAt(plan.start.x, plan.start.y)
  const b = { ...a }
  for (let i = 0; i < 2000; i++) {
    const x = Math.cos(i * 0.043) * PLAYER_SPEED * dt
    const y = Math.sin(i * 0.037) * PLAYER_SPEED * dt
    if (i % 37 === 0 && a.grounded) {
      a.vz = JUMP_VELOCITY
      b.vz = JUMP_VELOCITY
    }
    stepBody(plan, a, x, y, dt)
    stepBody(secondPlan, b, x, y, dt)
    assert.deepEqual(a, b)
  }
})
