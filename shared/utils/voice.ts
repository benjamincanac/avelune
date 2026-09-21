/**
 * Proximity voice: the rules and the wire format both sides have to agree on.
 *
 * Voice rides the game's own WebSocket. There is no peer to peer connection and
 * no third party in the path: a player's audio goes to the deployment and the
 * deployment hands it to the listeners it has already decided are in range. So
 * nobody learns anybody's address, and the same socket that carries the world
 * carries the talking.
 *
 * Who may hear whom is the server's decision, exactly like every other gameplay
 * rule here. The pairing runs in `server/utils/game.ts` from the authoritative
 * positions; the client only ever obeys the `voice-peers` frame it is handed.
 * The selection itself lives here so it can be tested on its own and so the
 * client can read the same constants for its HUD.
 *
 * Audio frames are binary, alongside the JSON frames rather than inside them:
 * base64 in JSON would cost a third more bytes and a parse on the hot path. The
 * layout is at the bottom of this file and both sides read it from here.
 */

/** Inside this many tiles two players with voice on can hear each other. */
export const VOICE_RANGE = 24
/** And they stay paired until they are this far apart. The gap is the
 *  hysteresis: a pair standing on the boundary would otherwise be torn down and
 *  rebuilt every pairing pass. */
export const VOICE_DROP_RANGE = 30
/** A mesh through the server, so the listener count is the cost. Six is two full
 *  conversations. */
export const VOICE_MAX_PEERS = 6

/** How often the server recomputes the pairs, in ticks of the 20 Hz loop. A
 *  connection takes a moment to warm up and nobody walks 24 tiles in half a
 *  second. */
export const VOICE_PAIR_EVERY = 10

/** A player the pairing can see: an id and where they stand. */
export interface VoiceBody {
  id: string
  x: number
  y: number
}

/** The stable key for a pair, lowest id first. */
export function voicePairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * One entry in a `voice-peers` frame.
 *
 * `talker` is the small numeric id the server gave that player for this process.
 * The binary frames carry it instead of the string id, because a 36-character id
 * repeated 50 times a second per listener is more bytes than the audio.
 */
export interface VoicePeerInfo {
  id: string
  talker: number
}

export interface VoicePairing {
  /** Every live pair, by `voicePairKey`. */
  pairs: Set<string>
  /** Per player, the ids they should be carrying voice with right now. */
  peers: Map<string, string[]>
}

/**
 * Recompute the whole mesh from the current positions and the previous pairs.
 *
 * Pairs rather than per-player lists, because the two halves have to agree: if
 * A's list held B while B's did not hold A, the server would forward one
 * direction and drop the other and one of them would be talking into nothing.
 * Working in pairs makes symmetry structural.
 *
 * Hysteresis reads the previous set: a pair already up survives to
 * `VOICE_DROP_RANGE`, a new one only forms inside `VOICE_RANGE`. The cap is
 * applied nearest-first and symmetrically, a pair being taken only while both
 * ends still have room, so a seventh neighbour is refused by both sides at once
 * rather than half-connected.
 *
 * Above seven people all standing within range of each other the cap cannot give
 * everyone their own six nearest, because the pairs are shared. Taking the
 * closest pairs first is what this does instead: the middle of a crowd fills up
 * and the players at its edges keep whoever is left. Everyone still hears their
 * closest neighbours, and nobody is ever half-connected.
 *
 * Cost is O(n²) over the players passed in, and only players with voice on are
 * ever passed in.
 */
export function selectVoicePairs(bodies: readonly VoiceBody[], previous: ReadonlySet<string> = new Set()): VoicePairing {
  const peers = new Map<string, string[]>()
  for (const body of bodies) peers.set(body.id, [])

  const candidates: { key: string, a: string, b: string, d2: number }[] = []
  for (let i = 0; i < bodies.length; i++) {
    const one = bodies[i]!
    for (let j = i + 1; j < bodies.length; j++) {
      const two = bodies[j]!
      const dx = one.x - two.x
      const dy = one.y - two.y
      const d2 = dx * dx + dy * dy
      const key = voicePairKey(one.id, two.id)
      const limit = previous.has(key) ? VOICE_DROP_RANGE : VOICE_RANGE
      if (d2 > limit * limit) continue
      candidates.push({ key, a: one.id, b: two.id, d2 })
    }
  }
  // Nearest first, then by key, so the outcome never depends on the order the
  // roster happens to be walked in.
  candidates.sort((p, q) => p.d2 - q.d2 || (p.key < q.key ? -1 : 1))

  const pairs = new Set<string>()
  for (const candidate of candidates) {
    const a = peers.get(candidate.a)!
    const b = peers.get(candidate.b)!
    if (a.length >= VOICE_MAX_PEERS || b.length >= VOICE_MAX_PEERS) continue
    pairs.add(candidate.key)
    a.push(candidate.b)
    b.push(candidate.a)
  }

  return { pairs, peers }
}

/* -------------------------------------------------------------------------- */
/* The audio codec                                                            */
/* -------------------------------------------------------------------------- */

/** Opus, mono, 48 kHz, in 20 ms frames. The browser's own encoder, through
 *  WebCodecs, so there is no WASM to ship. */
export const VOICE_SAMPLE_RATE = 48_000
export const VOICE_FRAME_MS = 20
export const VOICE_BITRATE = 28_000

/**
 * The largest audio payload the relay will carry.
 *
 * A 28 kbps Opus frame of 20 ms is about 70 bytes and a loud one is under 120.
 * Four hundred leaves room for a burst without leaving room for a channel: this
 * is a broadcast path, so anything that fits here is multiplied by the listener
 * count.
 */
export const MAX_VOICE_PAYLOAD = 400

/** 20 ms frames are 50 a second. The allowance is 60, so a client that runs a
 *  little fast is not punished, and the burst covers a scheduler hiccup. */
export const VOICE_FRAMES_PER_SECOND = 60
export const VOICE_FRAME_BURST = 30

/* -------------------------------------------------------------------------- */
/* The binary wire format                                                     */
/* -------------------------------------------------------------------------- */

/**
 * First byte of every binary frame.
 *
 * JSON frames start with `{` (0x7b), so one byte tells the two apart without a
 * parse and without a second socket. Anything that is neither is dropped.
 */
export const VOICE_FRAME_KIND = 1

/** `[u8 kind][u16 seq]` then the Opus payload. */
export const VOICE_UP_HEADER = 3
/** `[u8 kind][u16 talker][u16 seq]` then the Opus payload. Big endian, because
 *  a wire format that a human has to read in a hex dump should read left to
 *  right. */
export const VOICE_DOWN_HEADER = 5

/** Sequence numbers wrap at 16 bits, which is 21 minutes of talking. */
export const VOICE_SEQ_MODULO = 0x10000

/** One inbound audio frame as the server reads it. */
export interface VoiceFrameUp {
  seq: number
  payload: Uint8Array
}

/** One inbound audio frame as a client reads it. */
export interface VoiceFrameDown extends VoiceFrameUp {
  /** The small numeric id the server gave that talker, announced on
   *  `voice-peers` beside their player id. */
  talker: number
}

/** Pack one frame for the trip up to the server. The concrete `ArrayBuffer`
 *  parameter is not decoration: `WebSocket.send` will not take a view over a
 *  possibly-shared buffer. */
export function encodeVoiceUp(seq: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(VOICE_UP_HEADER + payload.length)
  frame[0] = VOICE_FRAME_KIND
  frame[1] = (seq >> 8) & 0xff
  frame[2] = seq & 0xff
  frame.set(payload, VOICE_UP_HEADER)
  return frame
}

/**
 * Read one frame the server received, or null if it is not one.
 *
 * Deliberately total: this runs on untrusted bytes on the hot path, so every
 * malformed shape has to come back as null rather than throw into the socket
 * handler.
 */
export function decodeVoiceUp(bytes: Uint8Array): VoiceFrameUp | null {
  if (bytes.length <= VOICE_UP_HEADER) return null
  if (bytes[0] !== VOICE_FRAME_KIND) return null
  if (bytes.length - VOICE_UP_HEADER > MAX_VOICE_PAYLOAD) return null
  return { seq: (bytes[1]! << 8) | bytes[2]!, payload: bytes.subarray(VOICE_UP_HEADER) }
}

/**
 * Restamp an inbound frame for one listener.
 *
 * The payload is copied once into the outgoing frame and the header is written
 * over it, which is the only allocation the relay makes per listener. The
 * sequence number travels untouched so the receiver's jitter buffer sees exactly
 * what the sender numbered.
 */
export function encodeVoiceDown(talker: number, seq: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(VOICE_DOWN_HEADER + payload.length)
  frame[0] = VOICE_FRAME_KIND
  frame[1] = (talker >> 8) & 0xff
  frame[2] = talker & 0xff
  frame[3] = (seq >> 8) & 0xff
  frame[4] = seq & 0xff
  frame.set(payload, VOICE_DOWN_HEADER)
  return frame
}

/** Read one frame a client received, or null if it is not one. */
export function decodeVoiceDown(bytes: Uint8Array): VoiceFrameDown | null {
  if (bytes.length <= VOICE_DOWN_HEADER) return null
  if (bytes[0] !== VOICE_FRAME_KIND) return null
  return {
    talker: (bytes[1]! << 8) | bytes[2]!,
    seq: (bytes[3]! << 8) | bytes[4]!,
    payload: bytes.subarray(VOICE_DOWN_HEADER),
  }
}

/**
 * Signed distance from `a` to `b` across the 16-bit wrap.
 *
 * A jitter buffer has to know whether frame 3 came after frame 65534 or long
 * before it, and plain subtraction says the wrong thing once an hour.
 */
export function voiceSeqDelta(a: number, b: number): number {
  const half = VOICE_SEQ_MODULO / 2
  let delta = (b - a) % VOICE_SEQ_MODULO
  if (delta >= half) delta -= VOICE_SEQ_MODULO
  if (delta < -half) delta += VOICE_SEQ_MODULO
  return delta
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

/** A continuously refilled allowance. The same shape the edit budget uses, kept
 *  here because voice needs three of them and they all have to be testable. */
export interface TokenBucket {
  tokens: number
  at: number
}

export function createBucket(burst: number, now = Date.now()): TokenBucket {
  return { tokens: burst, at: now }
}

/**
 * Spend one token, or refuse.
 *
 * A refused frame still costs the caller nothing here: it is dropped in silence,
 * because answering a flood is how a flood becomes amplification.
 */
export function spendToken(bucket: TokenBucket, rate: number, burst: number, now = Date.now()): boolean {
  bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) / 1000 * rate)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

/* -------------------------------------------------------------------------- */
/* Speech to chat                                                             */
/* -------------------------------------------------------------------------- */

/** A push-to-talk clip shorter than this is a key tap, not a sentence. */
export const MIN_CLIP_MS = 400
/** And one longer than this is not a chat line. */
export const MAX_CLIP_MS = 10_000
/** Ten seconds of Opus in a WebM container is well under this. The byte cap is
 *  what the server actually enforces, since a duration is a claim. */
export const MAX_CLIP_BYTES = 256 * 1024

/**
 * Things a speech to text model returns when it was handed silence.
 *
 * Every one of these is a real observed output on an empty or noise-only clip,
 * not a guess: the models have favourite hallucinations and they are the same
 * few every time. Posting one as a chat line would be worse than posting
 * nothing, because the player did not say it.
 */
const TRANSCRIPT_NOISE = new Set([
  'you',
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'thanks for watching!',
  'bye',
  'okay',
  'ok',
  'uh',
  'um',
  'hmm',
  'mm',
  'mhm',
  'yeah',
  'so',
  'the',
  'a',
  'blank_audio',
  'silence',
  'music',
  'applause',
  'inaudible',
  'foreign',
  'subs by www.zeoranger.co.uk',
])

/**
 * Whether a transcript is worth putting in the chat.
 *
 * Bracketed stage directions (`[BLANK_AUDIO]`, `(music)`) are stripped first,
 * because a clip of silence usually comes back as one of those and nothing else.
 * What is left has to contain a letter or a digit and not be on the noise list.
 */
export function isUsableTranscript(text: string): boolean {
  const stripped = text
    .replace(/[[(<][^\])>]*[\])>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return false
  if (!/[\p{L}\p{N}]/u.test(stripped)) return false
  const plain = stripped.toLowerCase().replace(/[.,!?;:"'’]+$/g, '').trim()
  if (!plain) return false
  return !TRANSCRIPT_NOISE.has(plain)
}

/**
 * The writing system a spoken language is transcribed in, for the handful that
 * are not Latin. Everything else is Latin.
 */
const LANGUAGE_SCRIPT: Record<string, RegExp> = {
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  bg: /\p{Script=Cyrillic}/u,
  sr: /\p{Script=Cyrillic}|\p{Script=Latin}/u,
  el: /\p{Script=Greek}/u,
  he: /\p{Script=Hebrew}/u,
  ar: /\p{Script=Arabic}/u,
  fa: /\p{Script=Arabic}/u,
  hi: /\p{Script=Devanagari}/u,
  th: /\p{Script=Thai}/u,
  ko: /\p{Script=Hangul}/u,
  ja: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u,
  zh: /\p{Script=Han}/u,
}
const LATIN = /\p{Script=Latin}/u

/**
 * Whether a transcript is written the way the speaker's language is written.
 *
 * Handed a clip with no real speech in it, these models do not return nothing.
 * They return a fluent sentence in some other language, and the favourites are a
 * Japanese thank you and a Cyrillic non-word. A French speaker did not say
 * either, so a transcript with no letter of the expected script is dropped. With
 * no hint there is nothing to compare against and everything passes.
 */
export function matchesSpokenScript(text: string, language?: string): boolean {
  if (!language) return true
  if (!/\p{L}/u.test(text)) return true
  return (LANGUAGE_SCRIPT[language] ?? LATIN).test(text)
}

/** Clean a transcript for the chat: the model's own whitespace and nothing else.
 *  Length capping and the rest belong to the chat path this feeds into. */
export function tidyTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
