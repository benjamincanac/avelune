import type { Ref } from 'vue'
import type { ServerMessage } from '#shared/types/game'
import { MAX_CLIP_BYTES, encodeClipUp, encodeVoiceUp } from '#shared/utils/voice'
import type { VoiceFrameDown, VoicePeerInfo } from '#shared/utils/voice'
import type { AudioPoint, VoiceSink } from '~/utils/audio'
import { createLevelMeter, createVoiceSink, setVoiceVolume, unlockAudio, voiceBus } from '~/utils/audio'
import { createVoiceCapture, createVoicePlayback, voiceSupported, voiceSupportedSync } from '~/utils/voice/codec'
import type { VoiceCapture, VoicePlayback } from '~/utils/voice/codec'
import { createClipRecorder } from '~/utils/voice/recorder'
import type { ClipRecorder } from '~/utils/voice/recorder'

/**
 * Proximity voice, on the client.
 *
 * Module state like `useAudio` and `useWorld`, because the Escape menu, the key
 * handler, the 3D scene and the socket all have to agree about one microphone and
 * none of them owns the others.
 *
 * Four rules shape this file:
 *
 * 1. **Opt in.** `getUserMedia` is never called until the player turns voice on.
 *    The preference is remembered, but a remembered preference still only opens
 *    the mic once they are in the arena, not on page load.
 * 2. **The server decides who hears you.** Nothing here computes a range or a
 *    peer list. `voice-peers` arrives and this converges on it.
 * 3. **Nothing is sent unless you are talking.** Push to talk starts the encoder
 *    and stops it; open mic leaves it running. An idle player runs no codec.
 * 4. **Only push to talk becomes chat.** The same utterance is recorded a second
 *    time into a container and uploaded on release, so it can be transcribed.
 *    Open mic is never transcribed, because a model call per utterance on an
 *    always-on microphone is a bill and a way to fill the chat with room noise.
 */

const KEY = 'avelune:voice'

/** How loud an RMS reading has to be to count as speech. Below this is a fan, a
 *  keyboard and the room. */
const TALK_THRESHOLD = 0.02
/** Below this the mic is carrying nothing at all, and for this long it is worth
 *  saying so. */
/**
 * The loudest moment of an utterance has to clear this for the clip to be sent.
 * A model handed near silence does not answer with nothing: it invents a line,
 * and the favourites are a polite Japanese thank you and a Cyrillic non-word.
 * Speech sits around 0.02 to 0.2 on this meter, a quiet room well under 0.005.
 */
const QUIET_PEAK = 0.008
const SILENT_LEVEL = 0.00005
const SILENT_AFTER = 2500
/** Speech is bursty: hold an indicator briefly past a gap so it does not flicker
 *  between syllables. */
const TALK_HOLD = 350
/** How often the meters and the peer stats are read. */
const METER_INTERVAL = 70

export type MicState = 'off' | 'asking' | 'blocked' | 'live'
export type VoiceMode = 'ptt' | 'open'
/** What became of the last spoken line. */
/** `quiet` is a clip that was never sent, because the mic picked up nothing worth
 *  a model call while the key was held. */
export type SayState = 'idle' | 'sending' | 'failed' | 'quiet'
/** What the talk key ran into: voice is off, the mic is muted, the browser
 *  cannot do it, the mic was refused, or it is still being asked for. */
export type VoiceHint = 'off' | 'muted' | 'unsupported' | 'blocked' | 'asking'

export interface VoicePeer {
  id: string
  /** The numeric id this peer's audio frames arrive under. */
  talker: number
  /** Inbound RMS, measured on this client's own voice bus. */
  level: number
  /** Whether frames have been arriving recently. The talking indicator needs no
   *  wire bit: audio turning up IS the signal. */
  speaking: boolean
  framesIn: number
  lost: number
  late: number
  bufferMs: number
  /** Last moment this peer's level was over the threshold. On the row, so a peer
   *  that drops takes its hold timer with it. */
  spokeAt?: number
}

export interface VoiceDebug {
  enabled: boolean
  supported: boolean | null
  mode: VoiceMode
  mic: MicState
  talking: boolean
  sttEnabled: boolean
  peers: { id: string, talker: number, framesIn: number, lost: number, late: number, bufferMs: number, level: number }[]
  sent: { frames: number, bytes: number }
  lastTranscript: string | null
  lastTranscriptMs: number | null
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const enabled = ref(false)
const mode = ref<VoiceMode>('ptt')
/**
 * The microphone is muted: nothing this player says leaves the machine.
 *
 * A fact about the person and not about the mode, so it gates push to talk and
 * open mic alike, and it is persisted: a reload that quietly reopened a muted
 * mic would be the one failure this whole file exists to avoid. The track itself
 * stays warm (see `requestMic`), so what a mute stops is the encoder.
 */
const micMuted = ref(false)
const volume = ref(1)
/** Post what I say to chat. On by default, and only ever applies to push to
 *  talk. */
const speechToChat = ref(true)
/** Whether the one-off notice has been shown. */
const noticeSeen = ref(false)
const mic = ref<MicState>('off')
/** Whether this browser can encode Opus at all. Null until detection has run. */
const supported = ref<boolean | null>(null)
const talking = ref(false)
/** The mic is open and frames are going out: the key is held, or open mic is on.
 *  This is what the HUD answers the key with. `talking` only turns true once the
 *  level crosses the speech threshold, which a quiet voice may never do. */
const micOpen = ref(false)
/** The mic has been open for a while and has carried nothing at all: the wrong
 *  input is selected, or it is muted in the system. */
const micSilent = ref(false)
let openedAt = 0
let heardAt = 0
/** The loudest reading since the key went down. */
let utterancePeak = 0
let quietTimer: ReturnType<typeof setTimeout> | undefined
const level = ref(0)
const say = ref<SayState>('idle')
const peers = ref<VoicePeer[]>([])
/** Why the talk key did nothing, shown for a moment. A key that silently does
 *  nothing reads as broken, and voice being off is the normal state. */
const hint = ref<VoiceHint | null>(null)
let hintTimer: ReturnType<typeof setTimeout> | undefined

let loaded = false

/** Read the saved preference. Storage throws in a private window, and a session
 *  that cannot remember a switch is not a session that should fail. */
function load(): void {
  if (loaded || import.meta.server) return
  loaded = true
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, unknown>
      if (typeof saved.enabled === 'boolean') enabled.value = saved.enabled
      if (saved.mode === 'ptt' || saved.mode === 'open') mode.value = saved.mode
      if (typeof saved.micMuted === 'boolean') micMuted.value = saved.micMuted
      if (typeof saved.volume === 'number') volume.value = Math.min(1, Math.max(0, saved.volume))
      if (typeof saved.speechToChat === 'boolean') speechToChat.value = saved.speechToChat
      if (typeof saved.noticeSeen === 'boolean') noticeSeen.value = saved.noticeSeen
    }
  }
  catch {
    // No storage, or something wrote nonsense under our key. Defaults it is.
  }
  setVoiceVolume(volume.value)
  // Detection is async and the menu reads the answer, so start it now rather
  // than when somebody reaches for the switch.
  void voiceSupported().then((ok) => {
    supported.value = ok
  })
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      enabled: enabled.value,
      mode: mode.value,
      micMuted: micMuted.value,
      volume: volume.value,
      speechToChat: speechToChat.value,
      noticeSeen: noticeSeen.value,
    }))
  }
  catch {
    // Storage refused. The setting still applies for this session.
  }
}

/* -------------------------------------------------------------------------- */
/* The microphone                                                             */
/* -------------------------------------------------------------------------- */

let stream: MediaStream | null = null
let meter: ReturnType<typeof createLevelMeter> = null
let capture: VoiceCapture | null = null
let recorder: ClipRecorder | null = null
/** Push-to-talk held, independent of the open-mic mode. */
let pressed = false
/** Last moment the local level was over the threshold. */
let spokeAt = 0
/** Sequence number for outbound frames. Wraps at 16 bits, as the wire does. */
let seq = 0
const sent = { frames: 0, bytes: 0 }
let lastTranscript: string | null = null
let lastTranscriptMs: number | null = null

/**
 * Mono at the codec's own rate, with the browser's cleanup on.
 *
 * Echo cancellation matters more here than anywhere else: two players in the same
 * room with speakers on is the normal case, not the edge one.
 */
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    sampleRate: 48_000,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
}

/** The permission prompt in flight, so a second caller waits on the same answer
 *  rather than opening a second stream over the first. */
let opening: Promise<boolean> | null = null

function openMic(): Promise<boolean> {
  opening ??= requestMic().finally(() => {
    opening = null
  })
  return opening
}

async function requestMic(): Promise<boolean> {
  if (stream) return true
  if (import.meta.server || !navigator.mediaDevices?.getUserMedia) {
    mic.value = 'blocked'
    return false
  }
  mic.value = 'asking'
  try {
    stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
  }
  catch {
    // Denied, or there is no input device. Saying so is the whole job here; it
    // must not retry in a loop.
    stream = null
    mic.value = 'blocked'
    return false
  }
  // The track stays enabled from here on, and what is gated is what leaves this
  // machine: the encoder and the clip recorder only run while the player talks.
  // Flipping `enabled` at the key press instead made the browser's gain control
  // and noise suppression start cold on the first word, which came out clipped
  // and was what the transcripts got wrong ("Grok, what time" for "Oracle, what
  // time"). A warm track has already settled by the time anyone speaks.
  // The menu click that got here is a gesture, so this is never an autoplay
  // attempt; the context has to be running before a peer can be heard.
  unlockAudio()
  meter = createLevelMeter(stream)
  capture = createVoiceCapture(stream, sendFrame)
  recorder = createClipRecorder(stream)
  mic.value = 'live'
  return true
}

function closeMic(): void {
  capture?.dispose()
  capture = null
  recorder?.dispose()
  recorder = null
  meter?.dispose()
  meter = null
  for (const track of stream?.getAudioTracks() ?? []) track.stop()
  stream = null
  pressed = false
  talking.value = false
  level.value = 0
  if (mic.value !== 'blocked') mic.value = 'off'
}

/**
 * The language the player most likely speaks, as a hint for the transcriber.
 *
 * A model guessing the language of a three second clip gets it wrong often enough
 * to matter, and then a French sentence comes back as English sounding noise. The
 * browser's own language is the best guess available without asking. It is only a
 * hint: measured on the model in use, English spoken under a French hint still
 * comes back as English.
 */
function spokenLanguage(): string | undefined {
  const code = (typeof navigator === 'undefined' ? '' : navigator.language).slice(0, 2).toLowerCase()
  return /^[a-z]{2}$/.test(code) ? code : undefined
}

/** One encoded frame, straight onto the socket. */
function sendFrame(payload: Uint8Array): void {
  if (!net) return
  const frame = encodeVoiceUp(seq, payload)
  seq = (seq + 1) % 0x10000
  net.sendVoiceFrame(frame)
  sent.frames++
  sent.bytes += frame.length
}

/**
 * Pick a stored opt in back up on a fresh session.
 *
 * The preference survives a reload and the microphone does not. Without this the
 * menu showed voice as on while the mic was never reopened, so the talk key had
 * nothing to open and the server was never told. The player already said yes,
 * so the mic is asked for again here. If the browser has forgotten the grant it
 * prompts once more, and a refusal turns the preference off.
 */
async function resumeOptIn(): Promise<void> {
  if (!enabled.value || supported.value === false) return
  if (mic.value !== 'live') {
    if (!await openMic()) {
      enabled.value = false
      return
    }
    // The prompt can sit there for a while, and the switch stays live under it.
    if (!enabled.value) return closeMic()
    startMeters()
    applyTalking()
  }
  net?.sendVoice(true)
}

/**
 * Set while a mute is what closed the mic, so the half utterance under it is
 * dropped instead of posted to chat as a sentence cut in two.
 */
let discardClip = false

/**
 * Open or shut the mic, and start or stop the encoder with it.
 *
 * The track's `enabled` flag and the encoder are both moved: the flag stops the
 * meter reading a live room, and stopping the encoder is what makes an idle
 * player actually free. Push to talk also records the utterance for chat, and the
 * release is where that upload starts.
 */
function applyTalking(): void {
  const discard = discardClip
  discardClip = false
  const open = enabled.value && mic.value === 'live' && !micMuted.value && (mode.value === 'open' || pressed)
  const was = talkingNow
  talkingNow = open
  micOpen.value = open
  if (open && !was) {
    openedAt = Date.now()
    utterancePeak = 0
  }
  if (!open) micSilent.value = false
  capture?.setTalking(open)
  if (!open) {
    talking.value = false
    spokeAt = 0
  }
  // Transcription is push to talk only. The edges of a held key are the clip.
  if (mode.value !== 'ptt' || !speechToChat.value) return
  if (open && !was) recorder?.start()
  else if (!open && was) {
    if (discard) void recorder?.stop().catch(() => {})
    else void uploadClip()
  }
}

/** Whether the mic was open on the previous `applyTalking`, so the edges of an
 *  utterance can be told from the middle of one. */
let talkingNow = false

/**
 * Mute or unmute the microphone.
 *
 * The one write path for `micMuted`, because a mute has to reach the encoder in
 * the same breath: leaving the ref to a watcher would let a frame out between
 * the flip and the gate.
 */
function setMicMuted(on: boolean): void {
  if (on === micMuted.value) return
  // Muting mid-utterance throws the clip away rather than posting to chat the
  // half of it that was already spoken.
  discardClip = on
  micMuted.value = on
  // The mute is an answer to the talk key, so whatever hint that key left on
  // screen is stale the moment this lands.
  clearTimeout(hintTimer)
  hint.value = null
  applyTalking()
}

/**
 * Send the utterance for transcription.
 *
 * Fire and forget from the player's point of view: there is no confirmation step
 * and nothing to approve. A refusal shows as a quiet state and the line simply
 * does not appear, which is the same thing that happens when a model hears
 * nothing.
 */
async function uploadClip(): Promise<void> {
  const peak = utterancePeak
  const blob = await recorder?.stop().catch(() => null)
  if (!blob) return
  // Nothing was picked up, so nothing is sent: a model call on silence costs
  // money and comes back as an invented sentence in somebody else's language.
  if (peak < QUIET_PEAK) {
    say.value = 'quiet'
    clearTimeout(quietTimer)
    quietTimer = setTimeout(() => {
      if (say.value === 'quiet') say.value = 'idle'
    }, 4000)
    return
  }
  await sendClip(blob)
}

/* -------------------------------------------------------------------------- */
/* Clips                                                                      */
/* -------------------------------------------------------------------------- */

/** Clips waiting on their `said` frame, by the sequence stamped on the way out.
 *  A socket that drops takes the answer with it, so each one is also timed out
 *  rather than left holding the HUD in `sending` forever. */
const awaitingClip = new Map<number, (answer: { ok: boolean, text: string }) => void>()
let clipSeq = 0

/** Long enough for a model call on a ten second clip, short enough that a lost
 *  socket does not read as a hung one. */
const CLIP_TIMEOUT = 20_000

/**
 * Put one recorded utterance on the socket and wait for what the server made of
 * it.
 *
 * The clip used to be a `POST /api/voice/say`. It could not stay one: the
 * process that has to handle it is the one holding this socket, and a request
 * lands on whichever instance serves it, so the post answered "not in the
 * world" to a player standing in it. On the socket there is nothing to look up.
 */
async function sendClip(blob: Blob): Promise<void> {
  const type = blob.type.split(';')[0] || 'audio/webm'
  // Measured before the blob is read, so an oversized recording is refused
  // without pulling a quarter of a megabyte into an array first.
  if (blob.size > MAX_CLIP_BYTES) {
    lastTranscript = null
    say.value = 'failed'
    return
  }
  const body = new Uint8Array(await blob.arrayBuffer())
  const seq = clipSeq = (clipSeq + 1) % 0x10000
  const frame = encodeClipUp(seq, type, spokenLanguage(), body)
  if (!net || !frame) {
    lastTranscript = null
    say.value = 'failed'
    return
  }

  say.value = 'sending'
  const started = Date.now()
  net.sendClip(frame)

  const answer = await new Promise<{ ok: boolean, text: string } | null>((resolve) => {
    const timer = setTimeout(() => {
      awaitingClip.delete(seq)
      resolve(null)
    }, CLIP_TIMEOUT)
    awaitingClip.set(seq, (result) => {
      clearTimeout(timer)
      awaitingClip.delete(seq)
      resolve(result)
    })
  })

  lastTranscriptMs = Date.now() - started
  // Two clips can be in flight if somebody taps the key twice, and the model
  // does not answer in order. Only the newest one owns the readout, or a slow
  // first answer lands on top of a fresh second one.
  if (seq !== clipSeq) return
  // Refused, rate limited, the model is down, or the socket went. All the same
  // to a player.
  lastTranscript = answer?.ok ? answer.text : null
  say.value = answer?.ok ? 'idle' : 'failed'
}

/** Nothing is coming back for anything still in flight. */
function dropAwaitingClips(): void {
  for (const [seq, resolve] of awaitingClip) {
    awaitingClip.delete(seq)
    resolve({ ok: false, text: '' })
  }
}

/* -------------------------------------------------------------------------- */
/* Peers                                                                      */
/* -------------------------------------------------------------------------- */

/** Per peer: the decoder plus the panner its output hangs off. */
interface PeerAudio {
  playback: VoicePlayback
  sink: VoiceSink
}
const audio = new Map<string, PeerAudio>()
/** Talker id to player id, for routing an inbound frame. Rebuilt from every
 *  `voice-peers`, so a stale talker id resolves to nobody. */
const byTalker = new Map<number, string>()

/**
 * Converge on the peer set the server just sent.
 *
 * The frame is the whole set rather than a delta, so this is a diff and not a
 * patch: a client that missed a frame still ends up in the right shape.
 */
function setPeers(list: VoicePeerInfo[]): void {
  const wanted = new Map(list.map(info => [info.id, info.talker]))
  for (const peer of peers.value) {
    if (wanted.get(peer.id) === peer.talker) continue
    // Gone, or the same player came back under a new talker id after a reconnect.
    dropPeer(peer.id)
  }
  const kept = new Map(peers.value.filter(p => wanted.get(p.id) === p.talker).map(p => [p.id, p]))
  byTalker.clear()
  peers.value = list.map((info) => {
    byTalker.set(info.talker, info.id)
    const existing = kept.get(info.id)
    if (existing) return existing
    openPeer(info.id)
    return { id: info.id, talker: info.talker, level: 0, speaking: false, framesIn: 0, lost: 0, late: 0, bufferMs: 0 }
  })
}

function openPeer(id: string): void {
  const bus = voiceBus()
  if (!bus) return
  const playback = createVoicePlayback(bus.ctx)
  if (!playback) return
  const sink = createVoiceSink(playback.output)
  if (!sink) {
    playback.dispose()
    return
  }
  audio.set(id, { playback, sink })
}

function dropPeer(id: string): void {
  const held = audio.get(id)
  held?.playback.dispose()
  held?.sink.dispose()
  audio.delete(id)
}

/** Drop everything: a new socket session gets a new pairing from scratch. */
function reset(): void {
  for (const id of [...audio.keys()]) dropPeer(id)
  peers.value = []
  byTalker.clear()
}

/* -------------------------------------------------------------------------- */
/* Metering                                                                   */
/* -------------------------------------------------------------------------- */

let meterTimer: ReturnType<typeof setInterval> | undefined

function readMeters(): void {
  const now = Date.now()
  // The track is always live now, so the meter is what stays shut between
  // utterances: an idle player's room is never measured, only an open mic.
  const own = talkingNow ? meter?.level() ?? 0 : 0
  level.value = own
  if (own > utterancePeak) utterancePeak = own
  const open = talkingNow
  if (open && own > TALK_THRESHOLD) spokeAt = now
  talking.value = open && mic.value === 'live' && now - spokeAt < TALK_HOLD
  // A working mic is never exactly silent, even in a quiet room.
  if (own > SILENT_LEVEL) heardAt = now
  micSilent.value = open && now - Math.max(openedAt, heardAt) > SILENT_AFTER

  for (const peer of peers.value) {
    const held = audio.get(peer.id)
    if (!held) {
      if (peer.level) peer.level = 0
      if (peer.speaking) peer.speaking = false
      continue
    }
    peer.level = held.sink.level()
    const stats = held.playback.stats()
    peer.framesIn = stats.framesIn
    peer.lost = stats.lost
    peer.late = stats.late
    peer.bufferMs = stats.bufferMs
    if (peer.level > TALK_THRESHOLD) peer.spokeAt = now
    peer.speaking = now - (peer.spokeAt ?? 0) < TALK_HOLD
  }
}

function startMeters(): void {
  if (meterTimer) return
  meterTimer = setInterval(readMeters, METER_INTERVAL)
}

function stopMeters(): void {
  if (!meterTimer) return
  clearInterval(meterTimer)
  meterTimer = undefined
  level.value = 0
  talking.value = false
}

/* -------------------------------------------------------------------------- */
/* The socket                                                                 */
/* -------------------------------------------------------------------------- */

/** What `useGame` hands over so this can speak on the wire without owning it. */
export interface VoiceNet {
  sendVoice: (on: boolean) => void
  sendVoiceFrame: (frame: Uint8Array<ArrayBuffer>) => void
  /** A finished push-to-talk clip, on the same binary channel. It goes up the
   *  socket rather than over HTTP because only the instance holding this
   *  session can turn it into a chat line. */
  sendClip: (frame: Uint8Array<ArrayBuffer>) => void
}

let net: VoiceNet | null = null

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface UseVoice {
  /** Whether the player asked for voice. Persisted; never opens the mic on its
   *  own before they are in the arena. */
  enabled: Ref<boolean>
  mode: Ref<VoiceMode>
  /** The voice bus level, 0 to 1, independent of the world mixer. */
  volume: Ref<number>
  /** Post push-to-talk lines to chat. */
  speechToChat: Ref<boolean>
  noticeSeen: Ref<boolean>
  mic: Ref<MicState>
  /** Whether this browser can encode Opus. Null until detection has run, false
   *  means voice cannot work here and the switch stays off. */
  supported: Ref<boolean | null>
  /** Speech is being picked up right now. */
  talking: Ref<boolean>
  /** The mic is muted: read only, written through `setMicMuted`. */
  micMuted: Ref<boolean>
  /** The mic is open and frames are going out. */
  micOpen: Ref<boolean>
  /** The open mic has carried nothing for a while. */
  micSilent: Ref<boolean>
  /** Local mic RMS, for the self indicator. */
  level: Ref<number>
  /** What became of the last spoken line. */
  say: Ref<SayState>
  peers: Ref<VoicePeer[]>
  /** Set briefly when the talk key is pressed and cannot do anything. */
  hint: Ref<VoiceHint | null>
  /** Turn voice on or off. Opening the mic is async and may be refused. */
  setEnabled: (on: boolean) => Promise<void>
  /** Push to talk. Also the dev hook's way in, since a synthetic key hold is
   *  unreliable. */
  setTalking: (on: boolean) => void
  /** Mute or unmute the microphone. */
  setMicMuted: (on: boolean) => void
  /** What the key is bound to. */
  toggleMicMute: () => void
  /** Hand the scene's rendered rig position for one peer, once a frame. */
  positionPeer: (id: string, point: AudioPoint) => void
  /** Wire up the socket. Called by `useGame` when it opens one. */
  attach: (connection: VoiceNet) => void
  /** The socket went away: tear every peer down. `voice-peers` rebuilds. */
  detach: () => void
  /** Every voice frame off the wire. */
  handle: (msg: ServerMessage) => void
  /** One inbound audio frame, already parsed off the binary socket. */
  handleFrame: (frame: VoiceFrameDown) => void
  debug: () => VoiceDebug
  /** Dev only: post a clip we were handed instead of one the recorder made, so a
   *  headless pass can exercise transcription without a real voice. */
  sayClip: (blob: Blob) => Promise<void>
}

export function useVoice(): UseVoice {
  load()
  return {
    enabled,
    mode,
    volume,
    speechToChat,
    noticeSeen,
    mic,
    supported,
    talking,
    micMuted,
    micOpen,
    micSilent,
    level,
    say,
    peers,
    hint,

    async setEnabled(on) {
      if (on === enabled.value && (!on || mic.value === 'live')) return
      if (on && supported.value === false) return
      enabled.value = on
      if (!on) {
        net?.sendVoice(false)
        reset()
        stopMeters()
        closeMic()
        return
      }
      // The mic first: opting in on the wire before the player has granted it
      // would put us in other people's peer lists with nothing to send.
      if (!await openMic()) {
        enabled.value = false
        return
      }
      // Switched off again while the permission prompt was up: the grant arrives
      // for a preference that no longer exists, so the mic must not stay open.
      if (!enabled.value) return closeMic()
      startMeters()
      applyTalking()
      net?.sendVoice(true)
    },

    setTalking(on) {
      pressed = on
      if (on && !(enabled.value && mic.value === 'live' && !micMuted.value)) {
        hint.value = supported.value === false
          ? 'unsupported'
          : !enabled.value ? 'off' : mic.value === 'blocked' ? 'blocked' : micMuted.value ? 'muted' : 'asking'
        clearTimeout(hintTimer)
        hintTimer = setTimeout(() => {
          hint.value = null
        }, 3200)
      }
      applyTalking()
    },

    setMicMuted,

    toggleMicMute() {
      setMicMuted(!micMuted.value)
    },

    positionPeer(id, point) {
      audio.get(id)?.sink.setPosition(point)
    },

    attach(connection) {
      net = connection
      // Opting in again is `welcome`'s job, not this one's: the server has not
      // registered the session yet when the socket opens, so a `voice` frame sent
      // here would be dropped on the floor.
      if (enabled.value && mic.value === 'live') startMeters()
    },

    detach() {
      reset()
      net = null
      // Leaving the world closes the mic. The preference stays, and the next
      // `welcome` reopens it: a track left running after a kick or a trip back
      // to the title page would keep recording with nothing to send it to, and
      // its level meter dies with the audio context the scene closes.
      stopMeters()
      closeMic()
      applyTalking()
    },

    handle(msg) {
      switch (msg.t) {
        case 'voice-peers':
          setPeers(Array.isArray(msg.peers) ? msg.peers : [])
          break
        case 'leave':
          if (peers.value.some(p => p.id === msg.id)) {
            dropPeer(msg.id)
            peers.value = peers.value.filter(p => p.id !== msg.id)
          }
          break
        case 'said':
          // The answer to a clip this client sent, matched by the sequence it
          // stamped on the frame.
          awaitingClip.get(msg.seq)?.({ ok: msg.ok, text: msg.text })
          break
        case 'welcome':
          // A fresh session: whatever was paired belonged to the old one, and the
          // talker ids it used mean nothing now.
          reset()
          dropAwaitingClips()
          void resumeOptIn()
          break
      }
    },

    handleFrame(frame) {
      const id = byTalker.get(frame.talker)
      if (!id) return
      audio.get(id)?.playback.push(frame.seq, frame.payload)
    },

    debug() {
      return {
        enabled: enabled.value,
        supported: supported.value ?? voiceSupportedSync(),
        mode: mode.value,
        mic: mic.value,
        talking: talking.value,
        sttEnabled: speechToChat.value,
        peers: peers.value.map(p => ({
          id: p.id,
          talker: p.talker,
          framesIn: p.framesIn,
          lost: p.lost,
          late: p.late,
          bufferMs: p.bufferMs,
          level: p.level,
        })),
        sent: { ...sent },
        lastTranscript,
        lastTranscriptMs,
      }
    },

    async sayClip(blob) {
      if (!import.meta.dev) return
      await sendClip(blob)
    },
  }
}

if (import.meta.client) {
  watch(volume, (value) => {
    setVoiceVolume(value)
    save()
  })
  watch([enabled, mode, micMuted, speechToChat, noticeSeen], () => {
    save()
    applyTalking()
  })
}
