// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/session-test.ts
//
// The gate on the WebSocket upgrade. The cookie half needs a runtime config to
// sign with, so what is covered here is the origin half: a pure function, and
// one whose edges are exactly where a same-origin check is usually got wrong —
// a proxy's forwarded host, a sandboxed frame's literal `null`, a port that does
// not match.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { sameOriginUpgrade } from '../server/utils/session'

/** The handshake headers a browser or a bot would arrive with. */
function headers(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

test('the game opening a socket on its own page is let through', () => {
  assert.equal(sameOriginUpgrade(headers({ host: 'avelune.example', origin: 'https://avelune.example' })), true)
  assert.equal(sameOriginUpgrade(headers({ host: 'localhost:3000', origin: 'http://localhost:3000' })), true)
})

test('another site opening a socket with a stolen cookie is refused', () => {
  assert.equal(sameOriginUpgrade(headers({ host: 'avelune.example', origin: 'https://evil.example' })), false)
  // A subdomain is a different host, and a look-alike prefix is not a match.
  assert.equal(sameOriginUpgrade(headers({ host: 'avelune.example', origin: 'https://avelune.example.evil.com' })), false)
  // The port is part of the host: dev on 3000 must not accept 3001.
  assert.equal(sameOriginUpgrade(headers({ host: 'localhost:3000', origin: 'http://localhost:3001' })), false)
})

test('a sandboxed frame, which sends the literal null, is refused', () => {
  assert.equal(sameOriginUpgrade(headers({ host: 'avelune.example', origin: 'null' })), false)
  assert.equal(sameOriginUpgrade(headers({ host: 'avelune.example', origin: 'not a url' })), false)
})

test('behind a proxy the forwarded name is what the page typed', () => {
  // The socket's own host is the internal one; matching against it would refuse
  // every real player on Vercel.
  assert.equal(sameOriginUpgrade(headers({
    'host': 'internal.vercel.internal',
    'x-forwarded-host': 'avelune.example',
    'origin': 'https://avelune.example',
  })), true)
  assert.equal(sameOriginUpgrade(headers({
    'host': 'internal.vercel.internal',
    'x-forwarded-host': 'avelune.example',
    'origin': 'https://evil.example',
  })), false)
})

test('a chain of proxies is read from the client end', () => {
  assert.equal(sameOriginUpgrade(headers({
    'host': 'internal',
    'x-forwarded-host': 'avelune.example, inner.proxy',
    'origin': 'https://avelune.example',
  })), true)
})

test('a handshake with no origin is not a page, and is let through', () => {
  // `ws-test.mjs` and `spawn-bots.mjs`. Nothing that is not a browser can be
  // carrying somebody else's cookie without their knowing.
  assert.equal(sameOriginUpgrade(headers({ host: 'localhost:3000' })), true)
  assert.equal(sameOriginUpgrade(undefined), true)
})

test('an origin with no host to check it against is refused', () => {
  assert.equal(sameOriginUpgrade(headers({ origin: 'https://avelune.example' })), false)
})
