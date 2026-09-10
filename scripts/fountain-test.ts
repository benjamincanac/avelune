import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFountainSimulation } from '../app/utils/fountainSimulation.ts'

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
        sim.impulse(Math.cos(angle) * 1.03, Math.sin(angle) * 1.03, -0.07, 0.065)
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
})
