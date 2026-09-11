import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFountainInteractions, createFountainSimulation } from '../app/utils/fountainSimulation.ts'

function energy(sim: ReturnType<typeof createFountainSimulation>) {
  return sim.heights.reduce((sum, h, i) => sum + h * h + sim.velocities[i]! ** 2, 0)
}

test('resting pool stays still and the pedestal excludes water', () => {
  const sim = createFountainSimulation()
  for (let i = 0; i < 120; i++) sim.step()
  assert.equal(energy(sim), 0)
  assert.equal(sim.active[32 * 64 + 32], 0)
  assert.equal(sim.active[0], 0)
})

test('an impact propagates and dissipates without changing pool volume', () => {
  const sim = createFountainSimulation()
  sim.impulse(0.8, 0, 0.3)
  for (let i = 0; i < 30; i++) sim.step()
  const initial = energy(sim)
  assert.ok(initial > 0)
  assert.ok(sim.heights.some(h => h > 0.0001))
  for (let i = 0; i < 900; i++) sim.step()
  assert.ok(energy(sim) < initial * 0.01)
  assert.ok(Math.abs(sim.heights.reduce((sum, h) => sum + h, 0)) < 0.00001)
})

test('continuous fountain impacts remain below the stone rim', () => {
  const sim = createFountainSimulation()
  let maximum = 0
  for (let frame = 0; frame < 1800; frame++) {
    if (frame % 2 === 0) {
      for (let jet = 0; jet < 12; jet++) {
        const angle = jet * Math.PI / 6
        sim.impact(Math.cos(angle) * 1.03, Math.sin(angle) * 1.03, 5.6)
      }
    }
    sim.step()
    for (let i = 0; i < sim.heights.length; i++) {
      assert.ok(Number.isFinite(sim.heights[i]!))
      if (!sim.active[i]) assert.equal(sim.heights[i], 0)
      maximum = Math.max(maximum, Math.abs(sim.heights[i]!))
    }
  }
  assert.ok(maximum < 0.07, `wave height ${maximum} exceeds basin clearance`)
  sim.reset()
  assert.equal(energy(sim), 0)
  assert.ok(sim.foam.every(value => value === 0))
})

test('faster impacts transfer more momentum and foam fades after flow stops', () => {
  const slow = createFountainSimulation()
  const fast = createFountainSimulation()
  slow.impact(0.8, 0, 2)
  fast.impact(0.8, 0, 6)
  assert.ok(energy(fast) > energy(slow) * 8)
  const initialFoam = fast.foam.reduce((sum, value) => sum + value, 0)
  assert.ok(initialFoam > 0)
  for (let step = 0; step < 240; step++) fast.step()
  assert.ok(fast.foam.reduce((sum, value) => sum + value, 0) < initialFoam * 0.01)
})

test('surface queries interpolate active cells and tolerate basin boundaries', () => {
  const sim = createFountainSimulation(24, 0.44, 0)
  for (let i = 0; i < sim.heights.length; i++) {
    if (sim.active[i]) sim.heights[i] = 0.025
  }
  assert.ok(Math.abs(sim.sampleHeight(0.1, 0.05) - 0.025) < 1e-8)
  assert.equal(sim.sampleHeight(Number.NaN, 0), 0)
  assert.ok(Number.isFinite(sim.sampleHeight(0.44, 0)))
  sim.reset()
  sim.impact(0, 0, 3)
  for (let i = 0; i < 60; i++) sim.step()
  assert.ok(Math.abs(sim.sampleHeight(0, 0)) > 0)
})

test('invalid impacts never poison the simulation', () => {
  const sim = createFountainSimulation()
  sim.impact(0.8, 0, Number.NaN)
  sim.impact(0.8, 0, -5)
  sim.impulse(0.8, 0, 1, 0)
  sim.step()
  assert.equal(energy(sim), 0)
  assert.throws(() => createFountainSimulation(2), RangeError)
})

test('impact displacement is locally volume-balanced before integration, including near walls', () => {
  for (const x of [0.8, 1.43, 0.37]) {
    const sim = createFountainSimulation()
    sim.impact(x, 0, 6)
    const momentum = sim.velocities.reduce((sum, value) => sum + value, 0)
    assert.ok(Math.abs(momentum) < 1e-6, `unbalanced impact at ${x}: ${momentum}`)
    assert.ok(sim.velocities.some(value => value < 0))
    assert.ok(sim.velocities.some(value => value > 0))
    assert.equal(sim.sampleHeight(-0.8, 0), 0)
  }
})

test('surface normals follow slopes and foam spreads with bounded surface flow', () => {
  const sim = createFountainSimulation()
  assert.deepEqual(sim.sampleNormal(0.8, 0), { x: 0, y: 1, z: 0 })
  sim.impact(0.8, 0, 6)
  const initialCoverage = sim.foam.filter(value => value > 1e-6).length
  for (let i = 0; i < 60; i++) sim.step()
  assert.ok(sim.foam.filter(value => value > 1e-6).length > initialCoverage)
  assert.ok(sim.flowX.some(value => Math.abs(value) > 1e-6))
  for (const x of [0.4, 0.8, 1.4]) {
    const n = sim.sampleNormal(x, 0)
    assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-8)
    assert.ok(n.y > 0)
  }
  for (let i = 0; i < sim.foam.length; i++) {
    assert.ok(sim.foam[i]! >= 0 && sim.foam[i]! <= 1)
    if (!sim.active[i]) assert.equal(sim.foam[i], 0)
  }
  sim.reset()
  assert.ok(sim.flowX.every(value => value === 0))
  assert.ok(sim.flowZ.every(value => value === 0))
})

test('wading creates wakes while stationary bodies, first observations and teleports stay quiet', () => {
  const sim = createFountainSimulation(96, 3.05, 0.56)
  const interactions = createFountainInteractions(sim, 0.48, 0.12)
  const body = { id: 'walker', x: 1, z: 0, feetY: 0.12 }
  interactions.update(0, [body])
  interactions.update(1 / 60, [body])
  assert.equal(energy(sim), 0)
  for (let frame = 2; frame <= 30; frame++) {
    interactions.update(frame / 60, [{ ...body, x: 1 + frame * 0.025 }])
    sim.step()
  }
  assert.ok(energy(sim) > 0)
  assert.ok(sim.foam.some(value => value > 0))
  assert.ok(Math.abs(sim.heights.reduce((sum, h) => sum + h, 0)) < 1e-5)
  sim.reset()
  interactions.update(31 / 60, [{ ...body, x: -2 }])
  assert.equal(energy(sim), 0)
  interactions.update(32 / 60, [])
  interactions.update(33 / 60, [body])
  assert.equal(energy(sim), 0)
})

test('entering water splashes once, but a suspended body and reconnect do not disturb it', () => {
  const sim = createFountainSimulation(96, 3.05, 0.56)
  const interactions = createFountainInteractions(sim, 0.48, 0.12)
  const body = { id: 'jumper', x: 1.5, z: 0, feetY: 0.8 }
  let splashes = 0
  const splash = () => splashes++
  interactions.update(0, [body], splash)
  interactions.update(0.1, [{ ...body, x: 1.6 }], splash)
  assert.equal(energy(sim), 0)
  interactions.update(0.2, [{ ...body, x: 1.6, feetY: 0.3 }], splash)
  assert.equal(splashes, 1)
  assert.ok(energy(sim) > 0)
  sim.reset()
  interactions.update(2, [{ ...body, feetY: 0.12 }], splash)
  assert.equal(energy(sim), 0)
  assert.equal(splashes, 1)
})
