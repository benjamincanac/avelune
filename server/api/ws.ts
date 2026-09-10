import { defineWebSocketHandler } from 'nitro'
import type { Connection } from '../utils/game'
import { registerConnection } from '../utils/game'
import { verifyCookieHeader } from '../utils/session'

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
    // Identity rides the signed cookie on the same-origin WS upgrade. No valid
    // cookie means the client skipped onboarding — close the socket.
    const identity = verifyCookieHeader(peer.request?.headers?.get('cookie'))
    if (!identity) {
      peer.close()
      return
    }
    conns.set(peer.id, registerConnection(identity, data => peer.send(data), () => peer.close()))
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
