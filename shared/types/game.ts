/**
 * Wire protocol shared between the browser client and the WebSocket server.
 *
 * Every frame is JSON with a `t` (type) discriminator. Positions are in arena
 * tile units (floats) and heading angles in radians. The server simulates
 * positions authoritatively; the heading is client-owned (mouse-look must
 * feel instant, and a heading can't be exploited — movement is still
 * integrated server-side).
 */

/** A connected character. Identity and position are owned by the server. */
export interface Player {
  id: string
  name: string
  /** A CSS color (hsl) used for the body accent and label. */
  color: string
  /** Chosen character model basename (see shared/utils/characters). */
  character: string
  /** Chosen outfit colorway index (resolved against the character's outfit). */
  outfitColor: number
  x: number
  y: number
  /** Height above the floor plane (jumping, standing on props). */
  z: number
  /** Heading in radians; forward is (cos angle, sin angle) in tile space. */
  angle: number
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
  /** Mid-dash right now (drives the roll animation remotely). */
  d?: boolean
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
  = | { t: 'welcome', self: Player, players: Player[], now: number }
    | { t: 'join', player: Player }
    | { t: 'leave', id: string }
    /** Snapshot of every player that moved since the last one. */
    | { t: 'state', players: PlayerState[] }
    | { t: 'chat', id: string, text: string }
    /** This identity connected from another tab/window and that newer socket
     *  took over — only one live session per player is allowed. The client
     *  shows the reason and stops reconnecting (a reconnect would kick the new
     *  tab straight back, ping-ponging forever). */
    | { t: 'kicked', reason: string }
    | { t: 'pong' }

export const MAX_CHAT_LENGTH = 120

/**
 * The Oracle speaks in the shared chat like any player, but as a reserved
 * sender id (never a real player). The client renders this id with the Oracle's
 * name/accent instead of looking it up in the roster.
 */
export const ORACLE_ID = 'oracle'
export const ORACLE_NAME = 'The Oracle'
export const ORACLE_COLOR = '#7fd0ff'
