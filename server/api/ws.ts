import { defineWebSocketHandler } from 'nitro'
import { CLIP_FRAME_KIND, VOICE_FRAME_KIND } from '#shared/utils/voice'
import type { Connection } from '../utils/game'
import { registerConnection } from '../utils/game'
import { loadPosition } from '../utils/positions'
import { sameOriginUpgrade, verifyCookieHeader } from '../utils/session'

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
/** Peers whose saved position is still being read. A close that lands during
 *  the read removes the peer, so the read comes back to nobody and registers
 *  nothing. */
const opening = new Set<string>()

export default defineWebSocketHandler({
  async open(peer) {
    // A cross-site handshake is refused before the cookie is even read.
    if (!sameOriginUpgrade(peer.request?.headers)) {
      peer.close()
      return
    }
    // Identity rides the signed cookie on the same-origin WS upgrade. No valid
    // cookie means the client skipped onboarding — close the socket.
    const identity = verifyCookieHeader(peer.request?.headers?.get('cookie'))
    if (!identity) {
      peer.close()
      return
    }
    opening.add(peer.id)
    const saved = await loadPosition(identity.id)
    if (!opening.delete(peer.id)) return
    conns.set(peer.id, registerConnection(
      identity,
      saved,
      data => peer.send(data),
      () => peer.close(),
      // A `Uint8Array` goes out as a binary frame, which is what keeps voice
      // audio off the JSON path entirely.
      bytes => peer.send(bytes),
    ))
  },
  message(peer, message) {
    const conn = conns.get(peer.id)
    if (!conn) return
    // crossws does not say whether a frame was text or binary, and the Node
    // adapter hands text over as bytes too. One byte decides: every JSON frame
    // starts with `{`, and a voice frame starts with `VOICE_FRAME_KIND`. Reading
    // `rawData` first keeps the common path from paying for a conversion.
    if (typeof message.rawData === 'string') {
      conn.handleMessage(message.rawData)
      return
    }
    const bytes = message.uint8Array()
    // Two binary kinds ride this channel: live audio frames and finished
    // push-to-talk clips. `handleBytes` tells them apart on the same byte.
    if (bytes[0] === VOICE_FRAME_KIND || bytes[0] === CLIP_FRAME_KIND) {
      conn.handleBytes(bytes)
      return
    }
    conn.handleMessage(message.text())
  },
  close(peer) {
    opening.delete(peer.id)
    const conn = conns.get(peer.id)
    conns.delete(peer.id)
    conn?.disconnect()
  },
  error(peer, error) {
    console.error('[game] ws error', peer.id, error)
    opening.delete(peer.id)
    const conn = conns.get(peer.id)
    conns.delete(peer.id)
    conn?.disconnect()
  },
})
