// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/character-animation-test.ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bodySurfaceHeight, DASH_DURATION } from '../shared/utils/maze'
import { createWorld } from '../shared/utils/world'
import { animationBlendDuration, locomotionTransitionTime, updateDashAnimation } from '../app/utils/characterAnimation'

test('dash starts immediately and ends with movement, not a half-second latch', () => {
  const state = { wasDashing: false, dashAnimUntil: 0 }
  assert.equal(updateDashAnimation(state, true, 1000), true)
  assert.equal(updateDashAnimation(state, true, 1100), true)
  assert.equal(updateDashAnimation(state, false, 1150), false)
})
test('a stationary peer with a stale dash snapshot does not replay the sprint', () => {
  const state = { wasDashing: false, dashAnimUntil: 0 }
  updateDashAnimation(state, true, 1000)
  assert.equal(updateDashAnimation(state, true, 1000 + DASH_DURATION * 1000), false)
  for (let now = 1500; now < 10000; now += 100) assert.equal(updateDashAnimation(state, true, now), false)
  updateDashAnimation(state, false, 10000)
  assert.equal(updateDashAnimation(state, true, 11000), true)
})
test('dash blend reaches full weight early in the burst and recovers quickly', () => {
  assert.ok(animationBlendDuration('Jog_Fwd_Loop', 'Sprint_Loop') < DASH_DURATION / 4)
  assert.equal(animationBlendDuration('Sprint_Loop', 'Idle_Loop'), 0.08)
  assert.equal(animationBlendDuration('Idle_Loop', 'Jog_Fwd_Loop'), 0.15)
})

test('elevated ground does not make remote players appear airborne', () => {
  const plan = createWorld()
  assert.equal(bodySurfaceHeight(plan, 72, 108, 6), 6)
  assert.equal(bodySurfaceHeight(plan, 72, 108, 0), 0)
  const stair = bodySurfaceHeight(plan, 40, 99, 4)
  assert.ok(stair > 3 && stair < 4)
  assert.ok(6.5 > bodySurfaceHeight(plan, 72, 108, 6.5) + 0.12)
})

test('jog and sprint retain the same supporting leg through speed changes', () => {
  assert.ok(Math.abs(locomotionTransitionTime('Jog_Fwd_Loop', 'Sprint_Loop', 0.6, 0.8, 0.5) - 0.375) < 1e-10)
  assert.ok(Math.abs(locomotionTransitionTime('Sprint_Loop', 'Jog_Fwd_Loop', 0.375, 0.5, 0.8) - 0.6) < 1e-10)
  assert.equal(locomotionTransitionTime('Idle_Loop', 'Sprint_Loop', 0.6, 0.8, 0.5), 0)
  assert.equal(locomotionTransitionTime('Swim_Loop', 'Jog_Fwd_Loop', 0.6, 2, 0.8), 0)
})
