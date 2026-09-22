// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/chunk-store-test.ts
//
// Persistence, both halves: the store itself against a stand-in for Upstash's
// REST endpoint (scripts/upstash-fake.mjs), and the chunk service across a
// simulated restart — two `scripts/world-probe.ts` processes over one store.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { TERRAFORM_STEP } from '../shared/utils/world'
import { MemoryChunkStore, RedisChunkStore, chunkStoreKey, seenKey } from '../server/utils/chunkStore'
import type { ChunkStore, StoredChunk } from '../server/utils/chunkStore'
import { startUpstashFake } from './upstash-fake.mjs'
import { startRealRedis } from './redis-rest.mjs'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Open meadow, far outside the protected town, with trees on it. */
const MEADOW = { cx: 6, cy: 6 }
/** A town chunk: seeded with authored pieces, and holding editable ground just
 *  outside the protected footprint in its far corner. */
const TOWN = { cx: 3, cy: 3 }

function record(cx: number, cy: number, v: number, props: StoredChunk['props'] = []): StoredChunk {
  return { cx, cy, v, h: 'AAAA', s: 'AAAA', props }
}

async function roundTrip(store: ChunkStore) {
  assert.equal(await store.get(1, 2), null, 'an unvisited chunk has no record')

  assert.ok(await store.set(record(1, 2, 3), null), 'first write lands while the key is absent')
  const saved = await store.get(1, 2)
  assert.deepEqual(saved, record(1, 2, 3), 'what went in comes back')

  assert.ok(!(await store.set(record(1, 2, 9), null)), 'a second "there is no key" write is refused')
  assert.ok(!(await store.set(record(1, 2, 9), 2)), 'a stale version is refused')
  assert.deepEqual(await store.get(1, 2), record(1, 2, 3), 'a refused write changes nothing')

  assert.ok(await store.set(record(1, 2, 4), 3), 'the version we last saw is accepted')
  assert.equal((await store.get(1, 2))?.v, 4)

  // A batch, the way the write-behind sends one: the stale entry fails on its
  // own without taking the rest of the flush down.
  const results = await store.flush([
    { chunk: record(1, 2, 5), expectedVersion: 4 },
    { chunk: record(3, 4, 1), expectedVersion: null },
    { chunk: record(5, 6, 1), expectedVersion: 7 },
  ])
  assert.deepEqual(results, [true, true, false])
  assert.equal((await store.get(1, 2))?.v, 5)
  assert.equal((await store.get(5, 6)), null)

  const many = await store.getMany([[1, 2], [3, 4], [9, 9]])
  assert.deepEqual(many.map(c => c?.v ?? null), [5, 1, null])

  const keys = (await store.keys()).map(([cx, cy]) => chunkStoreKey(cx, cy)).sort()
  assert.deepEqual(keys, [chunkStoreKey(1, 2), chunkStoreKey(3, 4)])

  assert.equal(await store.remove([[1, 2], [9, 9]]), 1)
  assert.equal(await store.get(1, 2), null)

  // Build budgets: signed deltas, so an instance draining into a store another
  // one is already writing adds to the total instead of clobbering it.
  assert.deepEqual([...await store.readPieces()], [], 'nobody has built anything yet')
  await store.addPieces([['ann', 3], ['bo', 1]])
  await store.addPieces([['ann', -1]])
  assert.deepEqual([...(await store.readPieces())].sort(), [['ann', 2], ['bo', 1]])

  // Last positions: one field per identity, last writer wins.
  assert.equal(await store.readPosition('ann'), null, 'nobody has stood anywhere yet')
  await store.writePositions([['ann', '1.00,2.00,0.00,0.00'], ['bo', '5.00,6.00,1.50,3.14']])
  await store.writePositions([['ann', '9.00,8.00,0.00,1.00']])
  assert.equal(await store.readPosition('ann'), '9.00,8.00,0.00,1.00')
  assert.equal(await store.readPosition('bo'), '5.00,6.00,1.50,3.14')

  // The live surface: presence, the seen buckets and the feed, which the title
  // screen reads without a socket and from whatever instance serves it.
  const today = { key: seenKey('d2026-09-22'), ttl: 60 }
  const hour = { key: seenKey('h1'), ttl: 60 }
  const empty = await store.readLive([today.key], 6)
  assert.deepEqual([...empty.presence], [], 'nobody is in town yet')
  assert.deepEqual(empty.seen, [0], 'and nobody has been')
  assert.deepEqual(empty.events, [], 'and nothing has happened')
  assert.deepEqual(empty.sky, { weather: null, time: null }, 'and nobody has turned the sky')

  // Two instances writing their own share of the realm, the way they do.
  await store.writeLive({
    presence: [['ann', '100,100,Ann']],
    drop: [],
    seen: [today, hour],
    seenIds: ['ann'],
    events: ['{"at":1,"name":"Ann","kind":"join","text":"entered the town"}'],
    feedLimit: 3,
    sky: [],
  })
  await store.writeLive({
    presence: [['bo', '200,200,Bo']],
    drop: [],
    seen: [today, hour],
    seenIds: ['bo'],
    events: ['{"at":2,"name":"Bo","kind":"join","text":"entered the town"}'],
    feedLimit: 3,
    sky: [{ field: 'weather', at: 1000, value: '1000,rain' }],
  })

  const both = await store.readLive([today.key, hour.key], 6)
  assert.deepEqual([...both.presence].sort(), [['ann', '100,100,Ann'], ['bo', '200,200,Bo']], 'the roster is the union of the instances')
  const lean = await store.readLive([today.key], 6, false)
  assert.deepEqual([...lean.presence], [], 'a read that does not want presence does not get it')
  assert.deepEqual(lean.seen, [2], 'and every other field still lines up')
  assert.equal(lean.events.length, 2)
  assert.deepEqual(both.seen, [2, 2], 'two people have been here today, and in this hour')
  assert.deepEqual(both.events.map(raw => JSON.parse(raw).name), ['Bo', 'Ann'], 'the feed is newest first')

  // A set counts people, not connections: the same identity again is not a
  // second visitor. This is the whole reason the buckets are sets.
  await store.writeLive({ presence: [], drop: [], seen: [today], seenIds: ['ann', 'ann'], events: [], feedLimit: 3, sky: [] })
  assert.deepEqual((await store.readLive([today.key], 6)).seen, [2], 'a reconnect is the same person')

  // A leaver's row goes, and the feed is capped rather than kept.
  await store.writeLive({
    presence: [],
    drop: ['ann'],
    seen: [],
    seenIds: [],
    events: ['{"at":3,"name":"Bo","kind":"build","text":"raised a wall"}', '{"at":4,"name":"Bo","kind":"dig","text":"dug a pit"}'],
    feedLimit: 3,
    sky: [],
  })
  const after = await store.readLive([today.key], 6)
  assert.deepEqual([...after.presence.keys()], ['bo'], 'the row went with the player')
  assert.deepEqual(after.events.map(raw => JSON.parse(raw).at), [4, 3, 2], 'the list is trimmed to the limit')
  assert.deepEqual(after.seen, [2], 'leaving does not un-visit')
  assert.deepEqual(after.sky, { weather: '1000,rain', time: null }, 'no turn leaves the realm\'s sky alone')

  // Newest turn wins in the store, whatever order the writes land in: an
  // instance can hold a turn for a whole flush before sending it.
  await store.writeLive({ presence: [], drop: [], seen: [], seenIds: [], events: [], feedLimit: 3, sky: [{ field: 'weather', at: 3000, value: '3000,clear' }] })
  await store.writeLive({ presence: [], drop: [], seen: [], seenIds: [], events: [], feedLimit: 3, sky: [{ field: 'weather', at: 2000, value: '2000,overcast' }] })
  assert.equal((await store.readLive([], 3)).sky.weather, '3000,clear', 'a late, older turn does not overwrite a newer one')

  // And the two halves are independent: turning the hour leaves the weather.
  await store.writeLive({ presence: [], drop: [], seen: [], seenIds: [], events: [], feedLimit: 3, sky: [{ field: 'time', at: 4000, value: '4000,night' }] })
  assert.deepEqual((await store.readLive([], 3)).sky, { weather: '3000,clear', time: '4000,night' }, 'a change of hour carries no weather')

  // Nothing to say costs nothing to send.
  await store.writeLive({ presence: [], drop: [], seen: [today], seenIds: [], events: [], feedLimit: 3, sky: [] })
  assert.deepEqual((await store.readLive([today.key], 6)).seen, [2], 'an idle instance writes nothing')
}

type ProbeResult = {
  ids: string[]
  town: number
  base: number
  height: number
  version: number
  written: number
  pieces: number
  felled?: string
}

/** One chunk service, in its own process, over the given store. */
async function probeAgainst(
  fake: { url: string, token: string },
  command: 'edit' | 'read' | 'conflict' | 'town-edit' | 'town-read',
  chunk: { cx: number, cy: number } = MEADOW,
): Promise<ProbeResult> {
  const { stdout } = await run(
    resolve(root, 'node_modules/.bin/jiti'),
    [resolve(root, 'scripts/world-probe.ts'), command, String(chunk.cx), String(chunk.cy)],
    {
      cwd: root,
      env: {
        ...process.env,
        UPSTASH_REDIS_REST_URL: fake.url,
        UPSTASH_REDIS_REST_TOKEN: fake.token,
        JITI_ALIAS: JSON.stringify({ '#shared': resolve(root, 'shared') }),
      },
    },
  )
  const line = stdout.split('\n').filter(l => l.startsWith('PROBE ')).pop()
  assert.ok(line, `probe ${command} printed nothing: ${stdout}`)
  return JSON.parse(line.slice('PROBE '.length)) as ProbeResult
}

test('memory store: round trip and compare-and-set', async () => {
  await roundTrip(new MemoryChunkStore())
})

test('redis store: round trip and compare-and-set over the REST protocol', async () => {
  const fake = await startUpstashFake()
  try {
    await roundTrip(new RedisChunkStore(fake.url, fake.token))
  }
  finally {
    await fake.close()
  }
})

// The fake reimplements the compare-and-set; it never compiles the Lua. A real
// server does, which is the only way to catch a script Redis would refuse — an
// unescaped newline in the version pattern, for one. Skipped where
// `redis-server` is not installed rather than failed: the fake still runs.
test('redis store: the compare-and-set script against a real redis-server', async (t) => {
  const real = await startRealRedis()
  if (!real) return t.skip('redis-server is not on PATH')
  try {
    await roundTrip(new RedisChunkStore(real.url, real.token))
  }
  finally {
    await real.close()
  }
})

test('redis store: a wrong token is rejected', async () => {
  const fake = await startUpstashFake()
  try {
    const store = new RedisChunkStore(fake.url, 'not-the-token')
    await assert.rejects(store.get(0, 0))
  }
  finally {
    await fake.close()
  }
})

test('a terraformed chunk and a felled tree survive a restart', async () => {
  const fake = await startUpstashFake()
  try {
    const before = await probeAgainst(fake, 'edit')
    assert.ok(before.felled, 'the first instance felled a tree')
    assert.ok(Math.abs(before.height - (before.base + TERRAFORM_STEP)) < 1e-9, 'the corner really moved')
    assert.ok(before.ids.length, 'the chunk still has vegetation on it')
    assert.ok(!before.ids.includes(before.felled), 'the felled tree is gone from the live chunk')

    const stored = await new RedisChunkStore(fake.url, fake.token).get(MEADOW.cx, MEADOW.cy)
    assert.ok(stored, 'the edited chunk reached the store')
    assert.deepEqual(stored.props.map(p => p.id).sort(), before.ids, 'the store holds the surviving trees')

    // A second process, the same store: the restart.
    const after = await probeAgainst(fake, 'read')
    assert.equal(after.height, before.height, 'the raised corner came back raised')
    assert.notEqual(after.height, after.base, 'and is not what generation would have produced')
    assert.deepEqual(after.ids, before.ids, 'vegetation was restored, not generated a second time')
    assert.ok(!after.ids.includes(before.felled), 'the felled tree stayed felled')
    assert.equal(before.pieces, 1, 'the first instance counted the crate it placed')
    assert.equal(after.pieces, 1, 'and the restarted instance still owes that piece to the budget')
  }
  finally {
    await fake.close()
  }
})

test('a lost compare-and-set reloads the chunk instead of overwriting it', async () => {
  const fake = await startUpstashFake()
  try {
    const result = await probeAgainst(fake, 'conflict')
    assert.equal(result.written, 0, 'the stale flush wrote nothing')
    assert.deepEqual(result.ids, [], 'the rival chunk replaced ours in memory')
    const stored = await new RedisChunkStore(fake.url, fake.token).get(MEADOW.cx, MEADOW.cy)
    assert.deepEqual(stored?.props ?? null, [], 'and the store still holds the rival copy')
  }
  finally {
    await fake.close()
  }
})

// The town used to be excluded from the store entirely, because a restore would
// have doubled its seeded pieces. It holds editable ground now — everything in
// its chunks outside the protected footprint — so it has to persist, and the
// `town:` placements are what gets left out of the record instead.
test('a town chunk persists its editable ground without duplicating the town', async () => {
  const fake = await startUpstashFake()
  try {
    const before = await probeAgainst(fake, 'town-edit', TOWN)
    assert.ok(before.town > 0, 'the town chunk is seeded with authored pieces')
    assert.ok(Math.abs(before.height - (before.base + TERRAFORM_STEP)) < 1e-9, 'the corner just outside the road moved')

    const stored = await new RedisChunkStore(fake.url, fake.token).get(TOWN.cx, TOWN.cy)
    assert.ok(stored, 'the town chunk reached the store')
    assert.deepEqual(stored.props.filter(p => p.id.startsWith('town:')), [], 'the record carries no authored pieces')

    const after = await probeAgainst(fake, 'town-read', TOWN)
    assert.equal(after.height, before.height, 'the raised corner came back raised')
    assert.notEqual(after.height, after.base, 'and is not what generation would have produced')
    assert.equal(after.town, before.town, 'the authored town was re-seeded, not duplicated')
    assert.deepEqual(after.ids, before.ids, 'and nothing else in the chunk changed')
  }
  finally {
    await fake.close()
  }
})
