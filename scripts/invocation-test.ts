// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/invocation-test.ts
//
// The hold a socket keeps on its Vercel invocation until its teardown is
// written. Seen on a preview without it: a leave's writes froze mid-flight and
// only landed when another request woke the instance, and dead sessions came
// back into presence each time one did.
import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { flushGate } from '../server/utils/flushGate'
import { holdInvocation } from '../server/utils/invocation'

/** Where `@vercel/functions` looks for the current request's context. */
const CONTEXT = Symbol.for('@vercel/request-context')
const global = globalThis as unknown as Record<symbol, unknown>

afterEach(() => {
  global[CONTEXT] = undefined
})

test('a hold keeps the invocation waiting until it is released', async () => {
  const held: Promise<unknown>[] = []
  global[CONTEXT] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => held.push(promise) }) }

  const release = holdInvocation()
  assert.equal(held.length, 1, 'the platform was handed something to wait for')

  let settled = false
  void held[0]!.then(() => {
    settled = true
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, 'and it stays unsettled while the socket is up')

  release()
  await held[0]
  assert.equal(settled, true, 'until the teardown releases it')
})

test('outside Vercel a hold is harmless', () => {
  // No request context: dev, the tests, the bots' own local server.
  const release = holdInvocation()
  assert.doesNotThrow(release)
  assert.doesNotThrow(release, 'and releasing twice is fine too')
})

// What the hold waits on has to be honest about it. A flush guarded by "return
// 0 if one is already running" answered at once with the leave's own write not
// yet in any flush, and the hold was released on that.
test('a flush asked for mid-flush waits, then carries what the running one missed', async () => {
  const pending: string[] = []
  const written: string[][] = []
  let gate!: () => void
  const flush = flushGate(async () => {
    const batch = pending.splice(0)
    await new Promise<void>((resolve) => {
      gate = resolve
    })
    written.push(batch)
    return batch.length
  }, () => pending.length > 0)

  pending.push('edit')
  const first = flush()
  // The leave notes its last position while that flush is on the wire...
  pending.push('position')
  let done = false
  const leave = flush().then(() => {
    done = true
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(done, false, 'the leave is not told it landed while the first flush is still out')

  gate()
  await first
  await new Promise(resolve => setTimeout(resolve, 10))
  gate()
  await leave
  assert.deepEqual(written, [['edit'], ['position']], 'and the pass it waited for carried its write')
})

test('a store that stays down does not hold a leave open forever', async () => {
  const pending = ['position']
  let calls = 0
  let gate!: () => void
  const flush = flushGate(async () => {
    calls++
    await new Promise<void>((resolve) => {
      gate = resolve
    })
    // A failed write puts it back, as every real flush does.
    return 0
  }, () => pending.length > 0)

  const running = flush()
  const leave = flush()
  gate()
  await running
  await new Promise(resolve => setTimeout(resolve, 10))
  gate()
  await leave
  assert.equal(calls, 2, 'one more pass, not a loop; the next timer retries')
})
