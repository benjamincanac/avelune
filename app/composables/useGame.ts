import type { ComputedRef, Ref } from 'vue'
import type { ClientMessage, FloorRecord, MoveInput, Player, ServerMessage } from '#shared/types/game'
import { MAX_CHAT_LENGTH, ORACLE_COLOR, ORACLE_ID, ORACLE_NAME } from '#shared/types/game'
import { HUB_FLOOR, TOWER_SEED, generateFloor } from '#shared/utils/maze'

export interface GamePlayer extends Player {
  /** Render position/heading, smoothly interpolated toward the server state. */
  rx: number
  ry: number
  rz: number
  ra: number
  /** Mid-dash (drives the roll animation). */
  dashing?: boolean
  /** Lying dead before the hub respawn (drives the death animation). */
  dying?: boolean
  /** Active chat bubble, if any. */
  bubble?: { text: string, until: number }
}

export interface ChatMessage {
  id: string
  name: string
  color: string
  text: string
  floor: number
  at: number
  /** System announcement (login, deaths, clears) — rendered without a sender. */
  system?: boolean
  /** The hub Oracle NPC, not a runner — the chat panel styles it apart. */
  npc?: boolean
}

export interface DeathEvent {
  id: string
  floor: number
  cause: string
  at: number
}

export interface ClearEvent {
  id: string
  name: string
  floor: number
  /** Destination floor: the next one down, or your deepest (resuming from the hub). */
  to: number
  ms: number
  best: number
  record: boolean
  at: number
}

export type GameStatus = 'connecting' | 'connected' | 'disconnected'

export interface UseGame {
  status: Ref<GameStatus>
  selfId: Ref<string | null>
  /** Every player in the world, self included, keyed by id. */
  players: Map<string, GamePlayer>
  /** Day seed of the current tower; changes on the midnight UTC rollover. */
  seed: Ref<number | null>
  /** The floor you are currently on (0 = hub). */
  selfFloor: Ref<number>
  /** Your deepest floor today. */
  selfBest: Ref<number>
  count: Ref<number>
  leaderboard: ComputedRef<GamePlayer[]>
  records: Ref<FloorRecord[]>
  lastDeath: Ref<DeathEvent | null>
  lastClear: Ref<ClearEvent | null>
  /** Set when the server booted this socket because the same identity opened
   *  another tab. Holds the reason; reconnection is stopped. */
  kicked: Ref<string | null>
  /** When you entered your current floor (client clock). */
  floorEnteredAt: Ref<number | null>
  /** Estimated server clock, for trap phases and the day/night cycle. */
  serverNow: () => number
  /** Chat history (all floors; panels filter by the sender's floor). */
  chatLog: Ref<ChatMessage[]>
  /** Fog of war: explored-tile bitmaps per floor, and a version to watch. */
  exploredFor: (floor: number) => Uint8Array | null
  exploredVersion: Ref<number>
  /**
   * Open the socket. Called once onboarding has set the identity cookie, or
   * with `spectate` to connect as a read-only watcher (no character, no cookie).
   */
  connect: (spectate?: boolean) => void
  setInput: (input: MoveInput) => void
  setLook: (angle: number) => void
  sendAction: (kind: 'jump' | 'dash') => void
  sendChat: (text: string) => void
  /** Push a system announcement into the chat on your current floor. */
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
 * reaches its max duration) — on reconnect the server assigns a fresh
 * character in the hub.
 *
 * The `players` map is deliberately non-reactive: the 3D scene reads it at
 * 60fps and Vue proxies would only add overhead there. UI-facing bits
 * (status, count, leaderboard, floor) are mirrored into refs instead.
 */
export function useGame(): UseGame {
  const oracle = useOracle()
  const status = ref<GameStatus>('connecting')
  const selfId = ref<string | null>(null)
  const players = new Map<string, GamePlayer>()
  const seed = ref<number | null>(null)
  const selfFloor = ref(0)
  const selfBest = ref(0)
  const count = ref(0)
  const records = ref<FloorRecord[]>([])
  const lastDeath = ref<DeathEvent | null>(null)
  const lastClear = ref<ClearEvent | null>(null)
  const kicked = ref<string | null>(null)
  const floorEnteredAt = ref<number | null>(null)
  const chatLog = ref<ChatMessage[]>([])
  // Bumped whenever a score or the roster changes, so the leaderboard recomputes.
  const rosterVersion = ref(0)

  const leaderboard = computed(() => {
    void rosterVersion.value
    return [...players.values()]
      .sort((a, b) => b.best - a.best || a.deaths - b.deaths)
      .slice(0, 5)
  })

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
    rosterVersion.value++
  }

  function pushChat(message: ChatMessage) {
    chatLog.value = [...chatLog.value.slice(-59), message]
  }

  // System announcements (login, deaths, clears) land in the chat like any
  // other message, but render without a sender. Scoped to your current floor.
  let systemSeq = 0
  let greeted = false
  function announce(text: string) {
    pushChat({ id: `system-${systemSeq++}`, name: 'System', color: 'inherit', text, floor: selfFloor.value, at: Date.now(), system: true })
  }

  /* ------------------------------------------------------------------------ */
  /* Fog of war: remember which tiles you've been near, per floor.            */
  /* ------------------------------------------------------------------------ */

  const explored = new Map<string, Uint8Array>()
  const planDims = new Map<string, number>()
  const exploredVersion = ref(0)
  const EXPLORE_RADIUS = 5

  function exploredFor(floor: number): Uint8Array | null {
    return explored.get(`${seed.value}:${floor}`) ?? null
  }

  let exploreTimer: ReturnType<typeof setInterval> | undefined
  function markExplored() {
    const self = selfId.value ? players.get(selfId.value) : undefined
    if (!self || seed.value == null) return
    const key = `${seed.value}:${self.floor}`
    let width = planDims.get(key)
    if (width == null) {
      width = generateFloor(self.floor, seed.value ?? TOWER_SEED).width
      planDims.set(key, width)
    }
    const plan = { width, height: width }
    let bitmap = explored.get(key)
    if (!bitmap) {
      bitmap = new Uint8Array(plan.width * plan.height)
      explored.set(key, bitmap)
    }
    let changed = false
    const cx = Math.floor(self.x)
    const cy = Math.floor(self.y)
    for (let y = Math.max(0, cy - EXPLORE_RADIUS); y <= Math.min(plan.height - 1, cy + EXPLORE_RADIUS); y++) {
      for (let x = Math.max(0, cx - EXPLORE_RADIUS); x <= Math.min(plan.width - 1, cx + EXPLORE_RADIUS); x++) {
        if (Math.hypot(x - self.x, y - self.y) > EXPLORE_RADIUS) continue
        const index = y * plan.width + x
        if (!bitmap[index]) {
          bitmap[index] = 1
          changed = true
        }
      }
    }
    if (changed) exploredVersion.value++
  }

  function trackSelf(player: Player) {
    if (player.id !== selfId.value) return
    selfBest.value = player.best
    if (player.floor !== selfFloor.value) {
      selfFloor.value = player.floor
      floorEnteredAt.value = Date.now()
    }
  }

  function handle(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        players.clear()
        selfId.value = msg.self?.id ?? null
        if (msg.self) addPlayer(msg.self)
        for (const player of msg.players) addPlayer(player)
        seed.value = msg.seed
        clockOffset = msg.now - Date.now()
        records.value = msg.records
        // A spectator has no self — just adopt the world state and watch.
        if (msg.self) {
          selfFloor.value = msg.self.floor
          selfBest.value = msg.self.best
          floorEnteredAt.value = Date.now()
          // Adopt the spawn heading so the first move doesn't overwrite it,
          // then resume held keys across a reconnect.
          lookAngle = msg.self.angle
          sendMove()
          // Greet once per session — reconnects re-send `welcome`, but silently.
          if (!greeted) {
            greeted = true
            announce(`Welcome to Tempest, ${msg.self.name}. Step through the great door to begin your descent. Talk to the Oracle to learn the rules. Press Esc for the menu.`)
          }
        }
        break
      case 'join':
        addPlayer(msg.player)
        break
      case 'leave':
        players.delete(msg.id)
        count.value = players.size
        rosterVersion.value++
        break
      case 'state':
        for (const state of msg.players) {
          const player = players.get(state.id)
          if (!player) continue
          const floorChanged = state.f !== player.floor
          player.x = state.x
          player.y = state.y
          player.z = state.z
          player.angle = state.a
          player.floor = state.f
          player.dashing = state.d === true
          player.dying = state.dead === true
          // Teleports (floor changes, respawns) should not glide.
          if (floorChanged || Math.hypot(player.x - player.rx, player.y - player.ry) > SNAP_DISTANCE) {
            player.rx = player.x
            player.ry = player.y
            player.rz = player.z
            player.ra = player.angle
          }
          trackSelf(player)
        }
        break
      case 'chat': {
        // The Oracle speaks as a reserved id, not a roster player: render it
        // with its own name/accent and float a bubble over the 3D NPC.
        if (msg.id === ORACLE_ID) {
          oracle.speech.value = { text: msg.text, until: Date.now() + BUBBLE_DURATION }
          pushChat({ id: ORACLE_ID, name: ORACLE_NAME, color: ORACLE_COLOR, text: msg.text, floor: msg.f, at: Date.now(), npc: true })
          break
        }
        const player = players.get(msg.id)
        if (player) {
          player.bubble = { text: msg.text, until: Date.now() + BUBBLE_DURATION }
          pushChat({ id: msg.id, name: player.name, color: player.color, text: msg.text, floor: msg.f, at: Date.now() })
        }
        break
      }
      case 'death': {
        const player = players.get(msg.id)
        if (player) {
          player.deaths++
          // Start the death animation at once, but don't teleport: the player
          // lies dead on the death floor until the respawn snapshot (with the
          // hub floor and no `dead` flag) arrives after DEATH_DELAY.
          player.dying = true
          trackSelf(player)
        }
        lastDeath.value = { id: msg.id, floor: msg.floor, cause: msg.cause, at: Date.now() }
        rosterVersion.value++
        break
      }
      case 'clear': {
        const player = players.get(msg.id)
        if (player) {
          player.best = msg.best
          player.floor = msg.to
          trackSelf(player)
        }
        if (msg.record) {
          records.value = [
            ...records.value.filter((r: FloorRecord) => r.floor !== msg.floor),
            { floor: msg.floor, name: msg.name, ms: msg.ms },
          ].sort((a: FloorRecord, b: FloorRecord) => a.floor - b.floor)
        }
        // Clearing a floor whose exit sends you back to the hub means you reached
        // the bottom of the authored dungeon (server clamps depth).
        if (msg.id === selfId.value && msg.to === HUB_FLOOR && msg.floor > HUB_FLOOR) {
          announce('You have conquered the deepest floor. The dungeon returns you to the colosseum — for now.')
        }
        lastClear.value = { ...msg, at: Date.now() }
        rosterVersion.value++
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

  // Set once, on the first connect(): reconnects keep the same mode.
  // Set once by connect(); reconnects (via open()) preserve the chosen mode.
  let spectating = false

  function open() {
    if (closed) return
    status.value = 'connecting'

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const query = spectating ? '?spectate=1' : ''
    socket = new WebSocket(`${protocol}://${location.host}/api/ws${query}`)

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
      rosterVersion.value++
      stopHeartbeat()
      if (closed) return
      reconnectTimer = setTimeout(open, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    })

    socket.addEventListener('error', () => socket?.close())
  }

  function connect(spectate = false) {
    spectating = spectate
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
      pushChat({ id: self.id, name: self.name, color: self.color, text: trimmed, floor: self.floor, at: Date.now() })
    }
  }

  onMounted(() => {
    // The socket is opened by the page once onboarding sets the identity cookie
    // (see index.vue) — not automatically on mount.
    exploreTimer = setInterval(markExplored, 250)
  })

  onBeforeUnmount(() => {
    closed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    clearInterval(exploreTimer)
    stopHeartbeat()
    socket?.close()
  })

  return {
    status,
    selfId,
    players,
    seed,
    selfFloor,
    selfBest,
    count,
    leaderboard,
    records,
    lastDeath,
    lastClear,
    kicked,
    floorEnteredAt,
    serverNow,
    chatLog,
    exploredFor,
    exploredVersion,
    connect,
    setInput,
    setLook,
    sendAction,
    sendChat,
    announce,
  }
}
