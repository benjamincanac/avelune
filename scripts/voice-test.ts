// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/voice-test.ts
//
// The pure half of proximity voice: who the server lets hear whom, the binary
// wire format, the rate limit, the jitter buffer and the transcript filter. Every
// one of these has behaviour a two-browser pass cannot show: hysteresis across
// passes, a sequence wrap, a TCP stall, a model's favourite hallucination.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  MAX_VOICE_PAYLOAD,
  VOICE_DOWN_HEADER,
  VOICE_DROP_RANGE,
  VOICE_FRAMES_PER_SECOND,
  VOICE_FRAME_BURST,
  VOICE_FRAME_KIND,
  VOICE_MAX_PEERS,
  VOICE_RANGE,
  createBucket,
  decodeVoiceDown,
  decodeVoiceUp,
  encodeVoiceDown,
  encodeVoiceUp,
  isUsableTranscript,
  matchesSpokenScript,
  selectVoicePairs,
  spendToken,
  tidyTranscript,
  voicePairKey,
  voiceSeqDelta,
} from '../shared/utils/voice'
import { createJitter, jitterMs, pullJitter, pushJitter } from '../app/utils/voice/jitter'

/* -------------------------------------------------------------------------- */
/* Pairing                                                                    */
/* -------------------------------------------------------------------------- */

/** A row of players on the x axis, `gap` tiles apart. */
function line(count: number, gap: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i}`, x: i * gap, y: 0 }))
}

test('two players inside the range are paired, and further apart they are not', () => {
  const near = selectVoicePairs([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: VOICE_RANGE - 1, y: 0 }])
  assert.deepEqual(near.peers.get('a'), ['b'])
  assert.deepEqual(near.peers.get('b'), ['a'])
  assert.equal(near.pairs.size, 1)

  const far = selectVoicePairs([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: VOICE_RANGE + 1, y: 0 }])
  assert.deepEqual(far.peers.get('a'), [])
  assert.equal(far.pairs.size, 0)
})

test('a pair already up survives past the connect range, and drops past the drop range', () => {
  const key = voicePairKey('a', 'b')
  // Just outside the range a pair would never have formed at: it stays because
  // the previous pass had it.
  const between = (VOICE_RANGE + VOICE_DROP_RANGE) / 2
  const held = selectVoicePairs([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: between, y: 0 }], new Set([key]))
  assert.equal(held.pairs.has(key), true, 'hysteresis holds the pair open')

  // Cold, the same distance forms nothing.
  const cold = selectVoicePairs([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: between, y: 0 }])
  assert.equal(cold.pairs.has(key), false, 'the same distance does not form a new pair')

  const gone = selectVoicePairs([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: VOICE_DROP_RANGE + 1, y: 0 }], new Set([key]))
  assert.equal(gone.pairs.has(key), false, 'past the drop range even a held pair goes')
})

test('the cap holds at six listeners, and holds symmetrically', () => {
  // Nine players almost on one spot: everyone is in range of everyone.
  const crowd = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, x: i * 0.5, y: 0 }))
  const { peers, pairs } = selectVoicePairs(crowd)
  for (const body of crowd) {
    assert.ok(peers.get(body.id)!.length <= VOICE_MAX_PEERS, `${body.id} is over the cap`)
  }
  // Symmetry is the property the relay depends on: if A lists B then B lists A,
  // or one of them would be talking into nothing.
  for (const [id, mine] of peers) {
    for (const other of mine) {
      assert.ok(peers.get(other)!.includes(id), `${other} does not list ${id} back`)
      assert.ok(pairs.has(voicePairKey(id, other)))
    }
  }
  // Nearest first: the player at the end of the line keeps its closest
  // neighbours, whatever the cap does to the rest.
  assert.deepEqual(peers.get('p0')!.slice(0, 3), ['p1', 'p2', 'p3'])
})

test('a player keeps their six nearest when the crowd is not mutual', () => {
  // Spread out enough that only neighbours are in range: the cap never binds and
  // everyone gets exactly who is near them.
  const spread = line(9, VOICE_RANGE - 2)
  const { peers } = selectVoicePairs(spread)
  assert.deepEqual(peers.get('p0'), ['p1'])
  assert.deepEqual(peers.get('p4')!.sort(), ['p3', 'p5'])
})

test('pairing does not depend on the order the roster is walked', () => {
  const crowd = line(9, 3)
  const forward = selectVoicePairs(crowd)
  const backward = selectVoicePairs([...crowd].reverse())
  assert.deepEqual([...forward.pairs].sort(), [...backward.pairs].sort())
})

test('a lone player with voice on is paired with nobody', () => {
  const { pairs, peers } = selectVoicePairs([{ id: 'a', x: 0, y: 0 }])
  assert.equal(pairs.size, 0)
  assert.deepEqual(peers.get('a'), [])
})

test('the pairing pass stays cheap with a crowd of talkers', () => {
  // Twenty people all talking in the square is the load the 2 Hz pass has to
  // survive. This is not a benchmark, it is a guard against an accidental cubic.
  const crowd = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, x: (i % 5) * 6, y: Math.floor(i / 5) * 6 }))
  let previous = new Set<string>()
  const started = performance.now()
  for (let pass = 0; pass < 200; pass++) {
    previous = selectVoicePairs(crowd, previous).pairs
  }
  const each = (performance.now() - started) / 200
  assert.ok(each < 2, `a pass over 20 talkers took ${each.toFixed(3)}ms`)
})

/* -------------------------------------------------------------------------- */
/* The binary format                                                          */
/* -------------------------------------------------------------------------- */

const OPUS = new Uint8Array([0x78, 0x01, 0x02, 0x03, 0xff])

test('a frame survives the trip up and back down', () => {
  const up = encodeVoiceUp(513, OPUS)
  assert.equal(up[0], VOICE_FRAME_KIND)
  const read = decodeVoiceUp(up)
  assert.ok(read)
  assert.equal(read.seq, 513)
  assert.deepEqual([...read.payload], [...OPUS])

  const down = encodeVoiceDown(7, read.seq, read.payload)
  assert.equal(down.length, VOICE_DOWN_HEADER + OPUS.length)
  const heard = decodeVoiceDown(down)
  assert.ok(heard)
  assert.equal(heard.talker, 7)
  assert.equal(heard.seq, 513)
  assert.deepEqual([...heard.payload], [...OPUS])
})

test('the header holds the whole 16-bit range', () => {
  for (const seq of [0, 1, 255, 256, 65_534, 65_535]) {
    assert.equal(decodeVoiceUp(encodeVoiceUp(seq, OPUS))!.seq, seq)
  }
  for (const talker of [1, 255, 256, 65_535]) {
    assert.equal(decodeVoiceDown(encodeVoiceDown(talker, 0, OPUS))!.talker, talker)
  }
})

test('the server refuses anything that is not a frame', () => {
  // A JSON frame starts with `{`, which is how the two are told apart.
  assert.equal(decodeVoiceUp(new TextEncoder().encode('{"t":"ping"}')), null)
  // A header with no audio behind it.
  assert.equal(decodeVoiceUp(new Uint8Array([VOICE_FRAME_KIND, 0, 0])), null)
  assert.equal(decodeVoiceUp(new Uint8Array([])), null)
  // Oversized: this is a broadcast path, so a payload is multiplied by the
  // listener count before it leaves.
  const huge = new Uint8Array(MAX_VOICE_PAYLOAD + 1)
  assert.equal(decodeVoiceUp(encodeVoiceUp(0, huge)), null)
  const largest = new Uint8Array(MAX_VOICE_PAYLOAD)
  assert.ok(decodeVoiceUp(encodeVoiceUp(0, largest)))
})

test('sequence distance reads correctly across the wrap', () => {
  assert.equal(voiceSeqDelta(10, 12), 2)
  assert.equal(voiceSeqDelta(12, 10), -2)
  // 65535 then 1 is two frames forward, not 65534 back.
  assert.equal(voiceSeqDelta(65_535, 1), 2)
  assert.equal(voiceSeqDelta(1, 65_535), -2)
})

/* -------------------------------------------------------------------------- */
/* The rate limit                                                             */
/* -------------------------------------------------------------------------- */

test('the token bucket allows the frame rate and refuses a flood', () => {
  let now = 1_000_000
  const bucket = createBucket(VOICE_FRAME_BURST, now)
  // A burst empties it and the next frame is refused.
  for (let i = 0; i < VOICE_FRAME_BURST; i++) {
    assert.ok(spendToken(bucket, VOICE_FRAMES_PER_SECOND, VOICE_FRAME_BURST, now), `frame ${i} refused`)
  }
  assert.equal(spendToken(bucket, VOICE_FRAMES_PER_SECOND, VOICE_FRAME_BURST, now), false)

  // The real rate is 50 frames a second at 20 ms. Ten seconds of it all passes.
  let sent = 0
  for (let i = 0; i < 500; i++) {
    now += 20
    if (spendToken(bucket, VOICE_FRAMES_PER_SECOND, VOICE_FRAME_BURST, now)) sent++
  }
  assert.equal(sent, 500, 'an honest sender is never throttled')

  // A sender at ten times the rate gets one second's allowance and no more, so
  // the relay's outbound cost is bounded by the rate and not by the sender.
  let flooded = 0
  for (let i = 0; i < 500; i++) {
    now += 2
    if (spendToken(bucket, VOICE_FRAMES_PER_SECOND, VOICE_FRAME_BURST, now)) flooded++
  }
  assert.ok(
    flooded <= VOICE_FRAMES_PER_SECOND + VOICE_FRAME_BURST,
    `a flood got ${flooded} frames through in one second`,
  )
  assert.ok(flooded < 500 / 4, 'most of a flood is dropped')
})

/* -------------------------------------------------------------------------- */
/* The jitter buffer                                                          */
/* -------------------------------------------------------------------------- */

const frame = (n: number) => new Uint8Array([n & 0xff])

test('playback waits for the target buffer, then runs in order', () => {
  const buffer = createJitter(60)
  assert.equal(pullJitter(buffer), null, 'nothing to play yet')
  pushJitter(buffer, 10, frame(10))
  pushJitter(buffer, 11, frame(11))
  assert.equal(pullJitter(buffer), null, 'still filling')
  pushJitter(buffer, 12, frame(12))
  assert.equal(jitterMs(buffer), 60)
  assert.deepEqual([...pullJitter(buffer)!.payload!], [10])
  assert.deepEqual([...pullJitter(buffer)!.payload!], [11])
  assert.deepEqual([...pullJitter(buffer)!.payload!], [12])
  assert.equal(pullJitter(buffer), null, 'empty again')
})

test('a gap is waited for once and then concealed', () => {
  const buffer = createJitter(60)
  // 21 never arrives. The frames around it do.
  for (const n of [20, 22, 23, 24]) pushJitter(buffer, n, frame(n))
  assert.deepEqual([...pullJitter(buffer)!.payload!], [20])
  // Now 21 is next and three frames are queued behind it, so it is not coming.
  const missed = pullJitter(buffer)
  assert.equal(missed?.payload, null, 'the hole is concealed')
  assert.equal(missed?.seq, 21)
  assert.deepEqual([...pullJitter(buffer)!.payload!], [22])
  assert.equal(buffer.lost, 1)
})

test('a frame that arrives after its slot played is counted late, not played', () => {
  const buffer = createJitter(40)
  for (const n of [5, 6]) pushJitter(buffer, n, frame(n))
  pullJitter(buffer)
  assert.equal(pushJitter(buffer, 4, frame(4)), 'late')
  assert.equal(buffer.late, 1)
  assert.equal(pushJitter(buffer, 6, frame(6)), 'duplicate')
})

test('a TCP stall is skipped rather than played back at real speed', () => {
  // The case this buffer exists for: the socket holds, then a second of audio
  // lands at once. Playing it all would leave the conversation a second behind
  // for the rest of the session.
  const buffer = createJitter(60, 200)
  for (let n = 0; n < 100; n++) pushJitter(buffer, n, frame(n))
  const first = pullJitter(buffer)
  assert.ok(first?.payload)
  // It jumped to the newest few frames rather than starting at zero.
  assert.ok(first.seq > 90, `started at ${first.seq}`)
  assert.ok(buffer.late > 80, `only ${buffer.late} frames were skipped`)
  assert.ok(jitterMs(buffer) <= 200)
})

test('the sequence wrap does not break the ordering', () => {
  const buffer = createJitter(60)
  for (const n of [65_534, 65_535, 0, 1]) pushJitter(buffer, n, frame(n))
  assert.equal(pullJitter(buffer)!.seq, 65_534)
  assert.equal(pullJitter(buffer)!.seq, 65_535)
  assert.equal(pullJitter(buffer)!.seq, 0)
  assert.equal(pullJitter(buffer)!.seq, 1)
})

/* -------------------------------------------------------------------------- */
/* Transcripts                                                                */
/* -------------------------------------------------------------------------- */

test('a transcript in a script the speaker does not write in is dropped', () => {
  // What two of these models really returned for a French speaker's quiet clip.
  assert.equal(matchesSpokenScript('Доброкомислов.', 'fr'), false)
  assert.equal(matchesSpokenScript('どうもありがとうございます。', 'fr'), false)
  assert.equal(matchesSpokenScript('Oracle, quelle heure est-il ?', 'fr'), true)
  assert.equal(matchesSpokenScript('Oracle, what time of day is it?', 'fr'), true)
  // A speaker of those languages keeps them.
  assert.equal(matchesSpokenScript('どうもありがとうございます。', 'ja'), true)
  assert.equal(matchesSpokenScript('Привет всем', 'ru'), true)
  assert.equal(matchesSpokenScript('Hello', 'ru'), false)
  // No hint means nothing to compare against, and digits alone always pass.
  assert.equal(matchesSpokenScript('Доброкомислов.'), true)
  assert.equal(matchesSpokenScript('42', 'fr'), true)
})

test('a real sentence is posted and silence is not', () => {
  assert.equal(isUsableTranscript('Meet me by the fountain'), true)
  assert.equal(isUsableTranscript('Hi!'), true)
  assert.equal(isUsableTranscript('42'), true)

  // Empty, or nothing but punctuation.
  assert.equal(isUsableTranscript(''), false)
  assert.equal(isUsableTranscript('   '), false)
  assert.equal(isUsableTranscript('.'), false)
  assert.equal(isUsableTranscript('...'), false)
  assert.equal(isUsableTranscript('?!'), false)

  // What these models actually return when handed silence or a beep. Posting one
  // would put words in a player's mouth.
  assert.equal(isUsableTranscript('[BLANK_AUDIO]'), false)
  assert.equal(isUsableTranscript('(music)'), false)
  assert.equal(isUsableTranscript('you'), false)
  assert.equal(isUsableTranscript('You.'), false)
  assert.equal(isUsableTranscript('Thanks for watching!'), false)
  assert.equal(isUsableTranscript('Thank you.'), false)
  assert.equal(isUsableTranscript('um'), false)
  assert.equal(isUsableTranscript(' Okay. '), false)

  // The filter is about the whole line, not the words in it.
  assert.equal(isUsableTranscript('thank you for the crate'), true)
  assert.equal(isUsableTranscript('[laughs] look at that tower'), true)
})

test('a transcript keeps its words and loses its whitespace', () => {
  assert.equal(tidyTranscript('  the   gate\nis  open '), 'the gate is open')
})
