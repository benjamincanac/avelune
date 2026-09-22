// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/invocation-test.ts
//
// The hold a socket keeps on its Vercel invocation until its teardown is
// written. Seen on a preview without it: a leave's writes froze mid-flight and
// only landed when another request woke the instance, and dead sessions came
// back into presence each time one did.
import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
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
