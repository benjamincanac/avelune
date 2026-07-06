import { defineWebSocketHandler } from 'nitro'
import type { Connection } from '../utils/game'
import { registerConnection } from '../utils/game'

/**
 * The `/api/ws` endpoint.
 *
 * Nitro v3 ships native WebSocket support that works the same in local dev and
 * when deployed to Vercel, so a single crossws handler powers every
 * environment — no Vercel-specific upgrade bridge required. Enable it with
 * `nitro.experimental.websocket` in `nuxt.config.ts`.
 *
 * The game world in `~/server/utils/game` owns all simulation; this handler
 * just bridges crossws peer lifecycle events into it.
 */

const conns = new Map<string, Connection>()

export default defineWebSocketHandler({
  open(peer) {
    conns.set(peer.id, registerConnection(data => peer.send(data), () => peer.close()))
  },
  message(peer, message) {
    conns.get(peer.id)?.handleMessage(message.text())
  },
  close(peer) {
    const conn = conns.get(peer.id)
    conns.delete(peer.id)
    conn?.disconnect()
  },
  error(peer, error) {
    console.error('[game] ws error', peer.id, error)
    const conn = conns.get(peer.id)
    conns.delete(peer.id)
    conn?.disconnect()
  },
})
