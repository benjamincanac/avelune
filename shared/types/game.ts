/**
 * Wire protocol shared between the browser client and the WebSocket server.
 *
 * Every frame is JSON with a `t` (type) discriminator. Positions are in maze
 * tile units (floats) and heading angles in radians. The server simulates
 * positions authoritatively; the heading is client-owned (mouse-look must
 * feel instant, and a heading can't be exploited — movement is still
 * integrated server-side).
 */

/** A connected character. Identity and position are owned by the server. */
export interface Player {
  id: string
  name: string
  /** A CSS color (hsl) used for the body, label, and leaderboard. */
  color: string
  x: number
  y: number
  /** Height above the floor plane (jumping, standing on props). */
  z: number
  /** Heading in radians; forward is (cos angle, sin angle) in tile space. */
  angle: number
  /** Current floor (0 = hub). */
  floor: number
  /** Deepest floor reached today. */
  best: number
  deaths: number
}

/** Which movement controls are held: forward/back and strafe left/right. */
export interface MoveInput {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
}

/** Positional delta for one player inside a state snapshot. */
export interface PlayerState {
  id: string
  x: number
  y: number
  /** Height above the floor plane. */
  z: number
  /** Heading in radians. */
  a: number
  /** Floor index. */
  f: number
  /** Mid-dash right now (drives the roll animation remotely). */
  d?: boolean
}

/** Best clear time for one floor today. */
export interface FloorRecord {
  floor: number
  name: string
  ms: number
}

/** Messages the client sends to the server. */
export type ClientMessage
  = | { t: 'move', a?: number } & MoveInput
    /** One-shot actions; the server validates grounded/cooldown state. */
    | { t: 'action', kind: 'jump' | 'dash' }
    | { t: 'chat', text: string }
    | { t: 'ping' }

/** Messages the server sends to the client. */
export type ServerMessage
  = | { t: 'welcome', self: Player, players: Player[], seed: number, now: number, records: FloorRecord[] }
    | { t: 'join', player: Player }
    | { t: 'leave', id: string }
    /** Snapshot of every player that moved since the last one. */
    | { t: 'state', players: PlayerState[] }
    /** `f` is the sender's floor, so chat panels can filter to nearby runners. */
    | { t: 'chat', id: string, text: string, f: number }
    /** A hazard killed someone; they're back in the hub. */
    | { t: 'death', id: string, floor: number, cause: string }
    /** Someone cleared a floor and dropped to the next one. */
    | { t: 'clear', id: string, name: string, floor: number, ms: number, best: number, record: boolean }
    /** Midnight UTC rollover: a new tower, everyone back to the hub. */
    | { t: 'maze', seed: number, players: Player[] }
    | { t: 'pong' }

export const MAX_CHAT_LENGTH = 120
