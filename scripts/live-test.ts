// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/live-test.ts
//
// The live surface the title screen reads: presence, the day's visitors, the
// nine-hour series and the world feed.
//
// The thing under test is that none of it is a fact about *this process*. A
// region runs as many instances as it needs, a socket pins its player to
// whichever accepted the upgrade, and `GET /api/status` lands wherever — so a
// second instance is faked by writing straight into the shared store, and every
// assertion below is about what a reader sees across both.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { seenKey } from '../server/utils/chunkStore'
import type { ChunkStore } from '../server/utils/chunkStore'
import type { LiveSession } from '../server/utils/live'

const NOON = Date.parse('2026-09-22T12:00:00.000Z')
const MINUTE = 60_000

/**
 * One process, freshly booted: the module registry is reset so `live.ts` starts
 * with an empty feed buffer and the store singleton behind it is a new map.
 *
 * Nothing in the test environment sets credentials, so that store is the
 * in-memory one — which is exactly the shared surface a realm's instances are
 * talking through, only without the network.
 */
async function boot(): Promise<{ store: ChunkStore } & typeof import('../server/utils/live')> {
  vi.resetModules()
  const store = (await import('../server/utils/chunkStore')).chunkStore()
  return { store, ...await import('../server/utils/live') }
}

function session(id: string, name: string, joinedAt: number): LiveSession {
  return { id, name, joinedAt }
}

/** A presence row and a visit as another instance would have written them.
 *  `instance` is the process stamp every row carries, which is how a reader
 *  counts how many processes hold the realm's sockets. */
function foreign(store: ChunkStore, id: string, name: string, joinedAt: number, lastSeen: number, instance = 'other1') {
  return store.writeLive({
    presence: [[id, `${joinedAt},${lastSeen},${instance},${name}`]],
    drop: [],
    seen: [{ key: seenKey(`d${new Date(lastSeen).toISOString().slice(0, 10)}`), ttl: 60 }],
    seenIds: [id],
    events: [],
    feedLimit: 6,
    sky: [],
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOON)
})

afterEach(() => {
  vi.useRealTimers()
})

test('the roster is the realm, not the instance that answers', async () => {
  const { store, flushLive, liveStatus, noteJoin } = await boot()
  const ann = session('ann', 'Ann', NOON - 5 * MINUTE)
  noteJoin(ann, [ann])
  await flushLive([ann], true)

  // Another instance, holding a socket this process knows nothing about.
  await foreign(store, 'bo', 'Bo', NOON - 20 * MINUTE, NOON)

  const status = await liveStatus()
  assert.equal(status.players, 2, 'both instances are in town')
  assert.equal(status.instances, 2, 'and the realm can see that it has split')
  assert.deepEqual(status.roster, [
    { name: 'Bo', minutes: 20 },
    { name: 'Ann', minutes: 5 },
  ], 'longest-standing first, wherever their socket is')

  // The whole single-instance-per-realm assumption is this number being 1.
  await foreign(store, 'cal', 'Cal', NOON, NOON, 'other1')
  assert.equal((await liveStatus()).instances, 2, 'two processes, three players')
})

test('a sky one instance turns is the realm\'s sky', async () => {
  const { store, flushLive, publishSky, onRemoteSky } = await boot()
  const seen: [string, string][] = []
  onRemoteSky((field, mode) => seen.push([field, mode]))
  /** A turn as another instance would have written it. */
  const turn = (field: 'weather' | 'time', at: number, mode: string) =>
    store.writeLive({ presence: [], drop: [], seen: [], seenIds: [], events: [], feedLimit: 6, sky: [{ field, at, value: `${at},${mode}` }] })

  // This instance turns it: published, and not handed back to ourselves.
  publishSky('weather', 'rain')
  await flushLive([])
  assert.deepEqual(seen, [], 'nobody adopts their own turn')
  assert.equal((await store.readLive([], 6)).sky.weather, `${NOON},rain`)

  // Another instance turns it after us, so ours gives way on the next flush.
  await turn('weather', NOON + 1000, 'clear')
  await flushLive([])
  assert.deepEqual(seen, [['weather', 'clear']], 'the newer turn wins')

  // An older one does not, however long it sits there, and however late it
  // arrives: the store keeps the newest, so a turn another instance sat on for
  // a flush cannot land on top of this one.
  await turn('weather', NOON - 60_000, 'overcast')
  await flushLive([])
  assert.equal(seen.length, 1, 'a stale turn is not a turn')

  // A change of hour elsewhere is only a change of hour. It used to carry that
  // instance's copy of the weather with it, and undo rain asked for here.
  publishSky('weather', 'rain')
  vi.setSystemTime(NOON + 5000)
  publishSky('weather', 'rain')
  await flushLive([])
  await turn('time', NOON + 6000, 'night')
  await flushLive([])
  assert.deepEqual(seen.at(-1), ['time', 'night'], 'the hour was adopted')
  assert.equal(seen.filter(([field]) => field === 'weather').length, 1, 'and the rain was left alone')
  assert.equal((await store.readLive([], 6)).sky.weather, `${NOON + 5000},rain`)

  // Two instances turning it in the same millisecond: the store keeps one, and
  // the one it did not keep gives way instead of leaving the realm split.
  vi.setSystemTime(NOON + 20_000)
  publishSky('weather', 'clear')
  await flushLive([])
  await turn('weather', NOON + 20_000, 'rain')
  await flushLive([])
  assert.equal((await store.readLive([], 6)).sky.weather, `${NOON + 20_000},rain`, 'the store kept one of the tied turns')
  assert.deepEqual(seen.at(-1), ['weather', 'rain'], 'and the instance whose turn it did not keep adopted it')
  const settled = seen.length
  await flushLive([])
  assert.equal(seen.length, settled, 'once, not on every flush after')
})

test('players today counts people, not sessions, and never falls back', async () => {
  const { store, flushLive, liveStatus, noteJoin, noteLeave } = await boot()
  const ann = session('ann', 'Ann', NOON)
  noteJoin(ann, [ann])
  await flushLive([ann], true)
  assert.equal((await liveStatus()).today, 1)

  // The same person, reconnecting — a second tab, a redeploy, a dropped socket.
  noteLeave('ann', [])
  await flushLive([], true)
  const again = session('ann', 'Ann', NOON + MINUTE)
  noteJoin(again, [again])
  await flushLive([again], true)

  const status = await liveStatus()
  assert.equal(status.today, 1, 'one person, however many sockets they used')
  assert.equal(status.players, 1, 'and one of them is in town')

  await foreign(store, 'bo', 'Bo', NOON, NOON)
  assert.equal((await liveStatus()).today, 2, 'a second person is a second visitor')

  // The count is a set inside its window, so it only ever grows: the reason
  // this replaced a per-process peak that fell to 1 whenever a colder instance
  // served the page.
  noteLeave('ann', [])
  await flushLive([], true)
  assert.equal((await liveStatus()).today, 2, 'leaving does not un-visit')
})

test('the sparkline is the same count, hour by hour', async () => {
  const { flushLive, liveStatus, noteJoin } = await boot()
  const ann = session('ann', 'Ann', NOON)
  noteJoin(ann, [ann])
  await flushLive([ann], true)

  // Two hours on, with someone else in town.
  vi.setSystemTime(NOON + 2 * 3_600_000)
  const bo = session('bo', 'Bo', Date.now())
  noteJoin(bo, [bo])
  await flushLive([bo], true)

  const { series } = await liveStatus()
  assert.equal(series.length, 9, 'nine hours, oldest first')
  assert.equal(series.at(-1), 1, 'this hour: Bo')
  assert.equal(series.at(-3), 1, 'two hours back: Ann')
  assert.equal(series.at(-2), 0, 'and nobody in between')
})

test('a row from an instance that vanished is ignored, then swept', async () => {
  const { store, liveStatus } = await boot()
  await foreign(store, 'ghost', 'Ghost', NOON - 10 * MINUTE, NOON - 10 * MINUTE)
  await foreign(store, 'bo', 'Bo', NOON, NOON)

  const status = await liveStatus()
  assert.equal(status.players, 1, 'a row nobody has refreshed is nobody')
  assert.deepEqual(status.roster.map(row => row.name), ['Bo'])

  await vi.waitFor(async () => {
    const live = await store.readLive([], 6)
    assert.deepEqual([...live.presence.keys()], ['bo'], 'and the reader drops it on its way past')
  })
})

test('the feed is shared, and a row still coalescing is held back but never hidden', async () => {
  const { flushLive, liveStatus, noteLeave, recentEvents, recordEvent } = await boot()
  const ann = session('ann', 'Ann', NOON)
  recordEvent('Ann', 'build', 'raised a wall')

  // `welcome` is built from this, so a row has to be visible on the instance
  // that recorded it before it ever reaches the store.
  assert.deepEqual(recentEvents().map(event => event.text), ['raised a wall'])

  await flushLive([ann])
  assert.deepEqual((await liveStatus()).feed, [], 'a row inside its window is still absorbing clicks')

  // Same player, same kind of act: one row, not two. The wall goes up in a
  // dozen clicks and the feed shows one line.
  recordEvent('Ann', 'build', 'raised a wall, twice')
  assert.equal(recentEvents().length, 1)

  // Past the window now, so it settles and goes out.
  vi.setSystemTime(NOON + 10_000)
  await flushLive([ann])
  const status = await liveStatus()
  assert.deepEqual(status.feed.map(event => event.text), ['raised a wall, twice'], 'one row, the latest wording')

  // ...and a leave drains whatever is left, because the tick stops with it.
  recordEvent('Ann', 'leave', 'left the world')
  noteLeave('ann', [])
  await vi.waitFor(async () => {
    const feed = (await liveStatus()).feed
    assert.deepEqual(feed.map(event => event.kind), ['leave', 'build'], 'newest first')
  })
})

test('an arrival does not split a row that is still coalescing', async () => {
  const { flushLive, liveStatus, noteJoin, noteLeave, recordEvent } = await boot()
  const ann = session('ann', 'Ann', NOON)
  const bo = session('bo', 'Bo', NOON)
  recordEvent('Ann', 'terrain:raise', 'raised land at 1, 1')

  // Somebody joins mid-dig, and somebody who is not the last one leaves.
  noteJoin(bo, [ann, bo])
  noteLeave('bo', [ann])
  await flushLive([ann])
  assert.deepEqual((await liveStatus()).feed, [], 'the row is still inside its window, so it stays here')

  // Which is what lets the next click fold into it rather than start another.
  vi.setSystemTime(NOON + 2000)
  recordEvent('Ann', 'terrain:raise', 'raised land at 2, 1')
  vi.setSystemTime(NOON + 10_000)
  await flushLive([ann])
  const feed = (await liveStatus()).feed
  assert.deepEqual(feed.map(event => event.text), ['raised land at 2, 1'], 'one row for one run of digging')
})

test('a read-back that fails does not push the same rows twice', async () => {
  const { store, flushLive, liveStatus, recordEvent } = await boot()
  const ann = session('ann', 'Ann', NOON)
  recordEvent('Ann', 'build', 'raised a wall')
  vi.setSystemTime(NOON + 10_000)

  // The write lands; the read after it does not.
  const readLive = store.readLive.bind(store)
  let failed = false
  store.readLive = async (...args) => {
    if (!failed) {
      failed = true
      throw new Error('read-back down')
    }
    return readLive(...args)
  }
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  await flushLive([ann])
  await flushLive([ann])
  quiet.mockRestore()

  assert.ok(failed, 'the read-back really did fail once')
  assert.deepEqual((await liveStatus()).feed.map(event => event.text), ['raised a wall'], 'one row, not two')
})
