/**
 * Wire protocol shared between the browser client and the WebSocket server.
 *
 * Every frame is JSON with a `t` (type) discriminator. Positions are in arena
 * tile units (floats) and heading angles in radians. The server simulates
 * positions authoritatively; the heading is client-owned (mouse-look must
 * feel instant, and a heading can't be exploited — movement is still
 * integrated server-side).
 */

import type { WorldPlacement } from '../utils/props'

/**
 * A surface raster value — the numeric codes in `SURFACE` (shared/utils/world.ts):
 * 0 grass, 1 dirt, 2 stone, 3 sand, 4 path, 5 water.
 */
export type Surface = 0 | 1 | 2 | 3 | 4 | 5

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
  /** Sprint is held. Only changes speed while a direction is held too. */
  sprint: boolean
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
  /** Sprinting right now (drives the sprint animation remotely). */
  s?: boolean
}

/** Messages the client sends to the server. */
export type ClientMessage
  = | { t: 'move', a?: number } & MoveInput
    /** One-shot actions; the server validates grounded/cooldown state.
     *  `respawn` is the way out of a hole: back to the gate, on a cooldown. */
    | { t: 'action', kind: 'jump' | 'dash' | 'respawn' }
    | { t: 'chat', text: string }
    /** Move terrain under the brush. The server validates reach, protection,
     *  rate and the step; it never trusts the resulting height. */
    | { t: 'terraform', x: number, y: number, mode: TerraformKind, size: 1 | 2 | 3, surface?: Surface }
    /** Place a piece. The server snaps it, computes its `z` and assigns its id.
     *  `h` is the world height the client's aim ray hit: a hint that bounds
     *  which surface under the footprint may support the piece, so a wall
     *  replaced under an upper storey goes back in its slot instead of onto the
     *  roof. Optional — without it the highest surface wins, as it always did. */
    | { t: 'build', kind: string, x: number, y: number, rot: number, h?: number }
    /** Remove a piece by id — the owner's own, or an unowned generated one. */
    | { t: 'demolish', id: string }
    | { t: 'ping' }

/** What a brush did to the ground. Echoed back on `terrain` so the feed can
 *  word it without guessing from the height deltas. */
export type TerraformKind = 'raise' | 'lower' | 'flatten' | 'paint'

/** Shared weather override; auto follows the synchronized weather cycle. */
export type WeatherMode = 'auto' | 'clear' | 'overcast' | 'rain'

/** Shared daylight override; auto follows the synchronized day/night cycle. */
export type TimeOfDayMode = 'auto' | 'dawn' | 'day' | 'sunset' | 'night'

/** Everything a client needs to build its own empty `World` before the first
 *  chunk lands. Geometry itself only ever arrives as `chunk` frames. */
export interface WorldInfo {
  chunkSize: number
  bounds: { minCx: number, maxCx: number, minCy: number, maxCy: number }
  seed: number
  /** The stored world this server owns, one per deployment region (see
   *  `shared/utils/realm.ts`). */
  realm: string
  /** Whether edits outlive the server process. False means the in-memory
   *  store: the world resets on every restart, and the HUD says so. */
  persistent: boolean
  /** How many chunks the server streams around a player once they are settled.
   *  The client can't derive it — the radius is the server's — and the entry
   *  screen needs a denominator for "19 / 25 chunks". */
  streamed: number
}

/** One thing that happened in the world, worded the way the feed reads it. */
export interface WorldEvent {
  at: number
  name: string
  text: string
  /** Same actor doing the same kind of thing again replaces the row instead of
   *  stacking: a wall goes up in a dozen clicks and the feed shows one line. */
  kind: string
}

/** Messages the server sends to the client. */
export type ServerMessage
  /** `pieces` is how many pieces this identity owns in the whole world, and
   *  `deeds` how many plots they hold — only the server can count either: a
   *  client holds twenty-five chunks of it. `feed` is the server's recent rows,
   *  newest first, so the HUD feed is not blank until someone next acts. */
  = | { t: 'welcome', self: Player, players: Player[], now: number, weather: WeatherMode, timeOfDay: TimeOfDayMode, world: WorldInfo, pieces: number, deeds: number, feed: WorldEvent[] }
    | { t: 'join', player: Player }
    | { t: 'leave', id: string }
    /** Snapshot of every player that moved since the last one. */
    | { t: 'state', players: PlayerState[] }
    /** `to` rides only on the Oracle's lines: the player it is answering or
     *  greeting, so the scene can turn the NPC to face them. */
    | { t: 'chat', id: string, text: string, to?: string }
    | { t: 'weather', mode: WeatherMode }
    | { t: 'time', mode: TimeOfDayMode }
    | { t: 'system', text: string }
    /** A whole chunk, sent as the player's loaded set grows. `h` is base64 of
     *  the 33×33 `Int16Array` corner heights (little-endian, `HEIGHT_STEP`
     *  units) and `s` base64 of the 32×32 surface raster — `encodeChunk`. */
    | { t: 'chunk', cx: number, cy: number, v: number, h: string, s: string, props: WorldPlacement[] }
    /** That chunk left the player's interest radius; drop it. */
    | { t: 'unchunk', cx: number, cy: number }
    /** Terrain delta: `edits` are `[cornerIndex, quantised height]` into the
     *  chunk's 33×33 heights, `surface` `[tileIndex, value]` into its raster.
     *  `by`, `mode` and `at` name whose brush it was, what it did and where —
     *  the world feed has no other way to attribute ground work, since a height
     *  carries no owner the way a placement does, and a corner index is not a
     *  place anyone can read. Absent when the server moved the ground itself. */
    | { t: 'terrain', cx: number, cy: number, v: number, edits: [number, number][], surface?: [number, number][], by?: string, mode?: TerraformKind, at?: [number, number] }
    /** A piece was placed in a chunk the player holds. `pieces` and `deeds`
     *  ride only on the copy sent to the player who asked for the edit, and are
     *  their new totals; every other viewer gets the frame without them. */
    | { t: 'place', cx: number, cy: number, v: number, piece: WorldPlacement, pieces?: number, deeds?: number }
    /** A piece was removed from a chunk the player holds. Counters as above. */
    | { t: 'remove', cx: number, cy: number, v: number, id: string, pieces?: number, deeds?: number }
    /** An edit request the server refused, sent only to the requester. */
    | { t: 'reject', reason: string }
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
