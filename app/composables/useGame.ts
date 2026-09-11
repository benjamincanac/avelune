import type { Ref } from 'vue'
import type { ClientMessage, MoveInput, Player, ServerMessage } from '#shared/types/game'
import { MAX_CHAT_LENGTH, COACH_COLOR, COACH_ID, COACH_NAME } from '#shared/types/game'

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
  /** The Coach, not a player — the chat panel styles it apart. */
  npc?: boolean
}

export type GameStatus = 'connecting' | 'connected' | 'disconnected'

export interface UseGame {
  status: Ref<GameStatus>
  selfId: Ref<string | null>
  /** Every player in the arena, self included, keyed by id. */
  players: Map<string, GamePlayer>
  count: Ref<number>
  /** Set when the server booted this socket because the same identity opened
   *  another tab. Holds the reason; reconnection is stopped. */
  kicked: Ref<string | null>
  /** Estimated server clock, driving the day/night cycle and weather. */
  serverNow: () => number
  /** Chat history for the arena. */
  chatLog: Ref<ChatMessage[]>
  /** Open the socket. Called once the identity cookie exists. */
  connect: () => void
  setInput: (input: MoveInput) => void
  setLook: (angle: number) => void
  sendAction: (kind: 'jump' | 'dash') => void
  sendChat: (text: string) => void
  /** Push a system announcement into the chat. */
  announce: (text: string) => void
}

/** Heartbeat cadence, and how long to wait for a pong before treating the socket as dead. */
const HEARTBEAT_INTERVAL = 25_000
const PONG_TIMEOUT = 10_000

const BUBBLE_DURATION = 4_000

/** How often mouse-look heading changes are flushed to the server. */
const LOOK_INTERVAL = 90

/** Beyond this distance a state update is a teleport, not movement. */
const SNAP_DISTANCE = 5

/**
 * Maintains a single resilient WebSocket connection to `/api/ws` and exposes
 * the live game state. Reconnects with exponential backoff, as recommended
 * for Vercel Functions WebSockets (connections close when the function
 * reaches its max duration) — on reconnect the server respawns the character
 * in the arena.
 *
 * The `players` map is deliberately non-reactive: the 3D scene reads it at
 * 60fps and Vue proxies would only add overhead there. UI-facing bits
 * (status, count) are mirrored into refs instead.
 */
export function useGame(): UseGame {
  const coach = useCoach()
  const status = ref<GameStatus>('connecting')
  const selfId = ref<string | null>(null)
  const players = new Map<string, GamePlayer>()
  const count = ref(0)
  const kicked = ref<string | null>(null)
  const chatLog = ref<ChatMessage[]>([])

  let clockOffset = 0
  const serverNow = () => Date.now() + clockOffset

  let socket: WebSocket | undefined
  let reconnectDelay = 1000
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  // Liveness: ping periodically and force a reconnect if the pong never arrives,
  // which catches half-open connections a silent proxy drop wouldn't surface.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let pongTimer: ReturnType<typeof setTimeout> | undefined

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

  function handle(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        players.clear()
        selfId.value = msg.self.id
        addPlayer(msg.self)
        for (const player of msg.players) addPlayer(player)
        clockOffset = msg.now - Date.now()
        // Adopt the spawn heading so the first move doesn't overwrite it,
        // then resume held keys across a reconnect.
        lookAngle = msg.self.angle
        sendMove()
        // Greet once per session — reconnects re-send `welcome`, but silently.
        if (!greeted) {
          greeted = true
          announce(`Welcome to Vercel Stadium, ${msg.self.name}. Press Esc for the menu.`)
          // Coach introduces itself as its own chat line, locally only (not broadcast).
          pushChat({ id: COACH_ID, name: COACH_NAME, color: COACH_COLOR, text: `Hey ${msg.self.name}, I'm Coach, the stadium's resident agent. Ask me anything about Vercel: deployments, Fluid compute, AI Gateway, v0… and the open source around it: Next.js, Nuxt, Svelte, Turborepo, the AI SDK. I read the docs live, so every answer comes with a link. I can also tell you who's in the stadium right now.`, at: Date.now(), npc: true })
        }
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
        // The Coach speaks as a reserved id, not a roster player: render it
        // with its own name/accent and float a bubble over the 3D NPC.
        if (msg.id === COACH_ID) {
          coach.speech.value = { text: msg.text, until: Date.now() + BUBBLE_DURATION }
          pushChat({ id: COACH_ID, name: COACH_NAME, color: COACH_COLOR, text: msg.text, at: Date.now(), npc: true })
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
        clearPong()
        break
      case 'coach':
        coach.thinking.value = msg.thinking
        break
    }
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      send({ t: 'ping' })
      // Expect a pong before the next beat; if none arrives, the socket is dead.
      pongTimer ??= setTimeout(() => socket?.close(), PONG_TIMEOUT)
    }, HEARTBEAT_INTERVAL)
    // Mouse-look changes are flushed on a small fixed cadence, not per-event.
    lookTimer ??= setInterval(() => {
      if (Math.abs(lookAngle - sentLook) > 0.02) sendMove()
    }, LOOK_INTERVAL)
  }

  function clearPong() {
    if (pongTimer) {
      clearTimeout(pongTimer)
      pongTimer = undefined
    }
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
    clearPong()
  }

  function open() {
    if (closed) return
    status.value = 'connecting'

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${protocol}://${location.host}/api/ws`)

    socket.addEventListener('open', () => {
      reconnectDelay = 1000
      status.value = 'connected'
      startHeartbeat()
    })

    socket.addEventListener('message', (event) => {
      try {
        handle(JSON.parse(event.data) as ServerMessage)
      }
      catch {
        // Ignore malformed frames.
      }
    })

    socket.addEventListener('close', () => {
      status.value = 'disconnected'
      selfId.value = null
      players.clear()
      count.value = 0
      stopHeartbeat()
      if (closed) return
      reconnectTimer = setTimeout(open, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    })

    socket.addEventListener('error', () => socket?.close())
  }

  function connect() {
    open()
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

  function sendAction(kind: 'jump' | 'dash') {
    send({ t: 'action', kind })
  }

  function sendChat(text: string) {
    const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH)
    if (!trimmed) return
    send({ t: 'chat', text: trimmed })
    // Show our own bubble and log entry immediately (the server doesn't echo).
    const self = selfId.value ? players.get(selfId.value) : undefined
    if (self) {
      self.bubble = { text: trimmed, until: Date.now() + BUBBLE_DURATION }
      pushChat({ id: self.id, name: self.name, color: self.color, text: trimmed, at: Date.now() })
    }
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
    kicked,
    serverNow,
    chatLog,
    connect,
    setInput,
    setLook,
    sendAction,
    sendChat,
    announce,
  }
}
