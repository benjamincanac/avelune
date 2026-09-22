import { waitUntil } from '@vercel/functions'

/**
 * Keep this socket's invocation alive until its teardown has been written.
 *
 * On Vercel a WebSocket lives inside the invocation that accepted its upgrade,
 * and the platform may freeze the process the moment that invocation looks
 * finished, which for a socket is the moment it closes. Everything a leave does
 * after that (the last player's chunk edits, their position, their piece
 * deltas, the presence row going away) is asynchronous, so it was being frozen
 * mid-flight: seen on a preview as a feed row that only landed when another
 * request happened to wake the instance, and as dead sessions an instance was
 * still holding when a request thawed it, flushing them back into presence.
 *
 * So `open` takes a hold while it is still inside the upgrade's invocation, and
 * the hold is released only after `disconnect` has finished writing. Taken
 * there rather than in `close` on purpose: by `close` the request context this
 * reads may already be gone, and the point is to keep it from going.
 *
 * Outside Vercel there is no request context, `waitUntil` does nothing, and the
 * release is just a resolved promise nobody is waiting on.
 */
export function holdInvocation(): () => void {
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  waitUntil(done)
  return release
}
