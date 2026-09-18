import type { Ref } from 'vue'
import type { ClientMessage, MoveInput, Player, ServerMessage, Surface, TimeOfDayMode, WeatherMode } from '#shared/types/game'
import { MAX_CHAT_LENGTH, ORACLE_COLOR, ORACLE_ID, ORACLE_NAME } from '#shared/types/game'
import { DEED_KIND, kitLabel } from '#shared/utils/kit'
import { TERRAFORM_VERBS } from '#shared/utils/world'

export interface GamePlayer extends Player {
  /** Render position/heading, smoothly interpolated toward the server state. */
  rx: number
  ry: number
  rz: number
  ra: number
  /** Mid-dash (drives the roll animation). */
  dashing?: boolean
  /** Active chat bubble, if any. */
  bubble?: { text: string, until: number }
}

export interface ChatMessage {
  id: string
  name: string
  color: string
  text: string
  at: number
  /** System announcement — rendered without a sender. */
  system?: boolean
  /** The Oracle NPC, not a player — the chat panel styles it apart. */
  npc?: boolean
}

export type GameStatus = 'connecting' | 'connected' | 'disconnected'

export interface UseGame {
  status: Ref<GameStatus>
  selfId: Ref<string | null>
  /** Every player in the arena, self included, keyed by id. */
  players: Map<string, GamePlayer>
  count: Ref<number>
  /** Last measured round trip to the server, in ms; null until the first pong.
   *  The heartbeat is the measurement — there is no separate latency frame. */
  rtt: Ref<number | null>
  /** Set when the server booted this socket because the same identity opened
   *  another tab. Holds the reason; reconnection is stopped. */
  kicked: Ref<string | null>
  /** Estimated server clock, driving the day/night cycle and weather. */
  serverNow: () => number
  weather: Ref<WeatherMode>
  timeOfDay: Ref<TimeOfDayMode>
  /** Chat history for the arena. */
  chatLog: Ref<ChatMessage[]>
  /** Open the socket. Called once the identity cookie exists. */
  connect: () => void
  /** Close the socket and prevent reconnects while the page is at the gate. */
  disconnect: () => void
  setInput: (input: MoveInput) => void
  setLook: (angle: number) => void
  sendAction: (kind: 'jump' | 'dash' | 'respawn') => void
  sendChat: (text: string) => void
  /** Push a system announcement into the chat. */
  announce: (text: string) => void
  /** Move ground under the brush. The server validates and answers with a
   *  `terrain` delta, or a `reject`. */
  sendTerraform: (x: number, y: number, mode: 'raise' | 'lower' | 'flatten' | 'paint', size: 1 | 2 | 3, surface?: Surface) => void
  /** Place a kit piece. The server snaps the pose and assigns the id. */
  sendBuild: (kind: string, x: number, y: number, rot: number, h?: number) => void
  /** Take a piece away, if it is yours or unowned. */
  sendDemolish: (id: string) => void
}

/**
 * Heartbeat cadence, and how many beats may go unanswered before the socket is
 * treated as dead.
 *
 * The beat doubles as the latency probe the HUD reads, so it runs often enough
 * for the number to mean something. Liveness is counted in beats rather than
 * measured with a timeout, because the main thread stalls for seconds at a time
 * while a neighbourhood's models decode: a `setTimeout` and the `message` event
 * that answers it both come due during the stall and can then run in either
 * order, so a timeout hangs up on a socket that was never dead. Browsers do not
 * replay a missed interval, so a stall costs one beat however long it lasts.
 */
const HEARTBEAT_INTERVAL = 5_000
const MISSED_BEATS = 3

const BUBBLE_DURATION = 4_000

/** How often mouse-look heading changes are flushed to the server. */
const LOOK_INTERVAL = 90

/** Beyond this distance a state update is a teleport, not movement. */
const SNAP_DISTANCE = 5

/**
 * Maintains a single resilient WebSocket connection to `/api/ws` and exposes
 * the live game state. Reconnects with exponential backoff, as recommended
 * for Vercel Functions WebSockets (connections close when the function
 * reaches its max duration) — on reconnect the server puts the character back
 * where it stood.
 *
 * The `players` map is deliberately non-reactive: the 3D scene reads it at
 * 60fps and Vue proxies would only add overhead there. UI-facing bits
 * (status, count) are mirrored into refs instead.
 */
export function useGame(): UseGame {
  const oracle = useOracle()
  // The streamed world. Every world frame is handed straight to it; nothing
  // here interprets chunks, and the scene subscribes to it rather than to us.
  const stream = useWorld()
  // The world feed. It lives here rather than in `useWorld` because wording a
  // row needs the roster: the frames carry player ids, not names.
  const feed = useFeed()
  const status = ref<GameStatus>('connecting')
  const selfId = ref<string | null>(null)
  const players = new Map<string, GamePlayer>()
  const count = ref(0)
  const weather = ref<WeatherMode>('auto')
  const timeOfDay = ref<TimeOfDayMode>('auto')
  const kicked = ref<string | null>(null)
  const chatLog = ref<ChatMessage[]>([])
  const rtt = ref<number | null>(null)

  let clockOffset = 0
  const serverNow = () => Date.now() + clockOffset

  let socket: WebSocket | undefined
  let reconnectDelay = 1000
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  // Liveness: ping periodically and force a reconnect if the pongs stop, which
  // catches half-open connections a silent proxy drop wouldn't surface.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  /** Beats sent since the last pong. */
  let unanswered = 0
  /** When the outstanding ping left, so its pong measures the round trip. */
  let pingAt = 0

  let lastInput: MoveInput = { forward: false, back: false, left: false, right: false }
  let lookAngle = 0
  let sentLook = 0
  let lookTimer: ReturnType<typeof setInterval> | undefined

  function send(msg: ClientMessage) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg))
    }
  }

  function sendMove() {
    sentLook = lookAngle
    send({ t: 'move', ...lastInput, a: lookAngle })
  }

  function addPlayer(player: Player) {
    players.set(player.id, { ...player, rx: player.x, ry: player.y, rz: player.z, ra: player.angle })
    count.value = players.size
  }

  function pushChat(message: ChatMessage) {
    chatLog.value = [...chatLog.value.slice(-59), message]
  }

  // System announcements land in the chat like any other message, but render
  // without a sender.
  let systemSeq = 0
  let greeted = false
  function announce(text: string) {
    pushChat({ id: `system-${systemSeq++}`, name: 'System', color: 'inherit', text, at: Date.now(), system: true })
  }

  /**
   * Turn a world frame into a feed row, if it is attributable. There is no feed
   * frame on the wire: a `place` carries its piece's owner, a `terrain` carries
   * `by`, and a `remove` names only an id — so the piece is looked up before
   * `useWorld` takes it out of the chunk.
   */
  function recordFeed(msg: ServerMessage) {
    switch (msg.t) {
      case 'join':
        feed.record(msg.player.name, 'join', 'entered the town')
        break
      case 'terrain': {
        const name = msg.by ? players.get(msg.by)?.name : undefined
        if (!name || !msg.mode || !msg.at) break
        // A brush on a chunk seam sends one frame per chunk; the coalescing
        // window in `useFeed` folds them back into the single row they were.
        feed.record(name, `terrain:${msg.mode}`, `${TERRAFORM_VERBS[msg.mode]} at ${msg.at[0]}, ${msg.at[1]}`)
        break
      }
      case 'place': {
        const name = msg.piece.owner ? players.get(msg.piece.owner)?.name : undefined
        if (!name) break
        feed.record(
          name,
          `build:${msg.piece.kind}`,
          msg.piece.kind === DEED_KIND ? 'claimed a plot' : `placed a ${kitLabel(msg.piece.kind).toLowerCase()}`,
        )
        break
      }
      case 'remove': {
        const piece = stream.world.getChunk(msg.cx, msg.cy)?.placements.find(p => p.id === msg.id)
        const name = piece?.owner ? players.get(piece.owner)?.name : undefined
        if (!name || !piece) break
        feed.record(
          name,
          `clear:${piece.kind}`,
          piece.kind === DEED_KIND ? 'released a plot' : `cleared a ${kitLabel(piece.kind).toLowerCase()}`,
        )
        break
      }
    }
  }

  function handle(msg: ServerMessage) {
    // The feed reads a `remove` against the chunk it is about to leave, so it
    // has to run before the stream applies the frame.
    recordFeed(msg)
    // Chunks, terrain, placements and rejects belong to `useWorld`. `welcome`
    // is read by both (it carries the world info as well as the roster), so
    // this runs before the switch rather than instead of it.
    stream.handle(msg)
    switch (msg.t) {
      case 'welcome':
        players.clear()
        selfId.value = msg.self.id
        addPlayer(msg.self)
        for (const player of msg.players) addPlayer(player)
        clockOffset = msg.now - Date.now()
        weather.value = msg.weather
        timeOfDay.value = msg.timeOfDay
        // Start from the server's recent rows, the live frames take over from
        // here. Without this the feed stays hidden until someone next acts.
        feed.adopt(msg.feed)
        // Adopt the spawn heading so the first move doesn't overwrite it,
        // then resume held keys across a reconnect.
        lookAngle = msg.self.angle
        sendMove()
        // Greet once per session — reconnects re-send `welcome`, but silently.
        if (!greeted) {
          greeted = true
          announce(`Welcome to Avelune, ${msg.self.name}. Meet the Oracle just inside the gate or head outside to dig and build.`)
        }
        break
      case 'time':
        timeOfDay.value = msg.mode
        break
      case 'weather':
        weather.value = msg.mode
        break
      case 'system':
        announce(msg.text)
        break
      case 'join':
        addPlayer(msg.player)
        break
      case 'leave':
        players.delete(msg.id)
        count.value = players.size
        break
      case 'state':
        for (const state of msg.players) {
          const player = players.get(state.id)
          if (!player) continue
          player.x = state.x
          player.y = state.y
          player.z = state.z
          player.angle = state.a
          player.dashing = state.d === true
          // A lag spike that lands far away is a teleport, not a walk.
          if (Math.hypot(player.x - player.rx, player.y - player.ry) > SNAP_DISTANCE) {
            player.rx = player.x
            player.ry = player.y
            player.rz = player.z
            player.ra = player.angle
          }
        }
        break
      case 'chat': {
        // The Oracle speaks as a reserved id, not a roster player: render it
        // with its own name/accent and float a bubble over the 3D NPC.
        if (msg.id === ORACLE_ID) {
          oracle.speech.value = { text: msg.text, until: Date.now() + BUBBLE_DURATION, to: msg.to }
          pushChat({ id: ORACLE_ID, name: ORACLE_NAME, color: ORACLE_COLOR, text: msg.text, at: Date.now(), npc: true })
          break
        }
        const player = players.get(msg.id)
        if (player) {
          player.bubble = { text: msg.text, until: Date.now() + BUBBLE_DURATION }
          pushChat({ id: msg.id, name: player.name, color: player.color, text: msg.text, at: Date.now() })
        }
        break
      }
      case 'kicked':
        // Another tab under the same identity took over. Stop for good — a
        // reconnect would boot that new tab straight back (ping-pong). The
        // page surfaces `kicked` and offers a manual "play here" reload.
        kicked.value = msg.reason
        closed = true
        stopHeartbeat()
        socket?.close()
        break
      case 'pong':
        // The heartbeat is the only round trip we control end to end, so it is
        // also the only honest latency reading available — but only the pong
        // that answers the outstanding ping measures anything. After a stall
        // several beats are in flight and `pingAt` holds the newest of them, so
        // an older pong would report a millisecond round trip.
        if (unanswered === 1 && pingAt) rtt.value = Math.max(0, Date.now() - pingAt)
        unanswered = 0
        break
    }
  }

  function beat() {
    if (unanswered >= MISSED_BEATS) {
      socket?.close()
      return
    }
    unanswered++
    pingAt = Date.now()
    send({ t: 'ping' })
  }

  function startHeartbeat() {
    stopHeartbeat()
    // Beat once straight away: the HUD shows a latency the moment it opens
    // rather than a dash for the first interval.
    beat()
    heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL)
    // Mouse-look changes are flushed on a small fixed cadence, not per-event.
    lookTimer ??= setInterval(() => {
      if (Math.abs(lookAngle - sentLook) > 0.02) sendMove()
    }, LOOK_INTERVAL)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    if (lookTimer) {
      clearInterval(lookTimer)
      lookTimer = undefined
    }
    unanswered = 0
    pingAt = 0
  }

  function open() {
    if (closed) return
    status.value = 'connecting'

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const connection = new WebSocket(`${protocol}://${location.host}/api/ws`)
    socket = connection

    connection.addEventListener('open', () => {
      if (socket !== connection) return
      reconnectDelay = 1000
      status.value = 'connected'
      startHeartbeat()
    })

    connection.addEventListener('message', (event) => {
      if (socket !== connection) return
      try {
        handle(JSON.parse(event.data) as ServerMessage)
      }
      catch {
        // Ignore malformed frames.
      }
    })

    connection.addEventListener('close', () => {
      // A creator save/cancel can reconnect before the previous close arrives.
      if (socket !== connection) return
      status.value = 'disconnected'
      selfId.value = null
      players.clear()
      count.value = 0
      rtt.value = null
      // The loaded set belonged to that session; a reconnect re-sends it all.
      stream.reset()
      stopHeartbeat()
      if (closed) return
      reconnectTimer = setTimeout(open, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    })

    connection.addEventListener('error', () => connection.close())
  }

  function connect() {
    closed = false
    kicked.value = null
    open()
  }

  function disconnect() {
    closed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    stopHeartbeat()
    socket?.close()
    socket = undefined
    selfId.value = null
    players.clear()
    count.value = 0
    rtt.value = null
    feed.reset()
    status.value = 'disconnected'
  }

  /** Report which movement keys are held. Only sends when the set changes. */
  function setInput(input: MoveInput) {
    if (
      input.forward === lastInput.forward && input.back === lastInput.back
      && input.left === lastInput.left && input.right === lastInput.right
    ) return
    lastInput = { ...input }
    sendMove()
  }

  /** Update the mouse-look heading; flushed to the server on a fixed cadence. */
  function setLook(angle: number) {
    lookAngle = angle
  }

  function sendAction(kind: 'jump' | 'dash' | 'respawn') {
    send({ t: 'action', kind })
  }

  function sendChat(text: string) {
    const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH)
    if (!trimmed) return
    send({ t: 'chat', text: trimmed })
    // The sky commands are dev-only; elsewhere the server treats them as chat.
    if (import.meta.dev && /^\/(?:weather|time)(?:\s|$)/i.test(trimmed)) return
    // Show our own bubble and log entry immediately (the server doesn't echo).
    const self = selfId.value ? players.get(selfId.value) : undefined
    if (self) {
      self.bubble = { text: trimmed, until: Date.now() + BUBBLE_DURATION }
      pushChat({ id: self.id, name: self.name, color: self.color, text: trimmed, at: Date.now() })
    }
  }

  function sendTerraform(x: number, y: number, mode: 'raise' | 'lower' | 'flatten' | 'paint', size: 1 | 2 | 3, surface?: Surface) {
    send({ t: 'terraform', x, y, mode, size, surface })
  }

  function sendBuild(kind: string, x: number, y: number, rot: number, h?: number) {
    send({ t: 'build', kind, x, y, rot, h })
  }

  function sendDemolish(id: string) {
    send({ t: 'demolish', id })
  }

  // The socket is opened by the page once the identity cookie exists (see
  // index.vue) — not automatically on mount.
  onBeforeUnmount(() => {
    closed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopHeartbeat()
    socket?.close()
  })

  return {
    status,
    selfId,
    players,
    count,
    rtt,
    kicked,
    serverNow,
    weather,
    timeOfDay,
    chatLog,
    connect,
    disconnect,
    setInput,
    setLook,
    sendAction,
    sendChat,
    announce,
    sendTerraform,
    sendBuild,
    sendDemolish,
  }
}
