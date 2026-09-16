/**
 * Micro-benchmark for `stepBody` in a built-up neighbourhood.
 *
 * Not a test (no `-test` suffix, so vitest's `scripts/*-test.ts` glob skips it).
 * Installs ~400 kit pieces around a meadow point through `applyPlace`, then
 * walks 12 bodies for 1000 ticks and prints the per-tick cost — the same shape
 * as one 20 Hz server tick with a full lobby standing in a town someone built.
 *
 * Run with: pnpm exec jiti scripts/bench-step.ts
 */
import { PLAYER_SPEED, stepBody } from '../shared/utils/maze'
import type { KinematicBody } from '../shared/utils/maze'
import { CHUNK_SIZE, applyPlace, createWorld, makePlacementId } from '../shared/utils/world'
import type { World } from '../shared/utils/world'

const ORIGIN = { x: 6 * CHUNK_SIZE + 16, y: 6 * CHUNK_SIZE + 16 }
/** Override with `BENCH_PIECES=1200` to see how the cost scales with density. */
const PIECES = Number(process.env.BENCH_PIECES ?? 400)
const BODIES = 12
const TICKS = 1000
const DT = 1 / 20

const KINDS = ['Kit_Wall', 'Kit_Floor', 'Kit_Crate', 'Kit_Fence', 'Kit_Torch'] as const

/** Deterministic, so two runs of the benchmark measure the same world. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (Math.imul(a ^ (a >>> 15), a | 1) + 0x6D2B79F5) >>> 0
    return a / 4294967296
  }
}

function build(): World {
  const world = createWorld()
  const random = rng(20260916)
  for (let i = 0; i < PIECES; i++) {
    const kind = KINDS[Math.floor(random() * KINDS.length)]!
    // A ~30 tile square of clutter: dense enough that a 3×3 chunk scan reads
    // most of it on every query, which is exactly the case that got slow.
    const x = Math.round((ORIGIN.x + (random() - 0.5) * 30) / 2) * 2
    const y = Math.round((ORIGIN.y + (random() - 0.5) * 30) / 2) * 2
    applyPlace(world, {
      kind,
      x,
      y,
      rot: Math.floor(random() * 4) * (Math.PI / 2),
      scale: 1,
      z: 0,
      id: makePlacementId('bench'),
      owner: 'bench',
    })
  }
  return world
}

function run() {
  const world = build()
  const bodies: KinematicBody[] = []
  for (let i = 0; i < BODIES; i++) {
    const angle = (i / BODIES) * Math.PI * 2
    bodies.push({ x: ORIGIN.x + Math.cos(angle) * 6, y: ORIGIN.y + Math.sin(angle) * 6, z: 4, vz: 0, grounded: false })
  }
  // Settle, and warm the JIT, before anything is timed.
  for (let t = 0; t < 200; t++) for (const body of bodies) stepBody(world, body, 0.02, 0.01, DT)

  const started = performance.now()
  for (let t = 0; t < TICKS; t++) {
    const angle = t * 0.07
    const dx = Math.cos(angle) * PLAYER_SPEED * DT
    const dy = Math.sin(angle) * PLAYER_SPEED * DT
    for (const body of bodies) stepBody(world, body, dx, dy, DT)
  }
  const elapsed = performance.now() - started
  console.log(`${PIECES} pieces, ${BODIES} bodies, ${TICKS} ticks`)
  console.log(`${(elapsed / TICKS).toFixed(3)} ms per tick (${elapsed.toFixed(0)} ms total)`)
}

run()
