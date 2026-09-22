/**
 * One write-behind flush at a time, without ever answering "done" early.
 *
 * Every flush here drains a snapshot of what is pending and writes it. They
 * used to guard against overlap by returning 0 the moment one was already in
 * flight, and that is wrong for a caller that needs its own write to have
 * landed: a leave notes the player's last position, then holds the socket's
 * invocation open on the flush (see `invocation.ts`). If a flush was in flight,
 * that flush had taken its snapshot before the position was noted, the guard
 * resolved at once, the hold was released, and the platform could freeze the
 * position unwritten.
 *
 * So a call that lands mid-flush waits for it and then runs one more pass,
 * which carries whatever the first one missed. One more, not a loop: a store
 * that is down puts everything back as pending, and looping on that would hold
 * an invocation open for as long as the outage lasted. The next timer retries.
 */
export function flushGate<Args extends unknown[]>(
  run: (...args: Args) => Promise<number>,
  pending: () => boolean,
): (...args: Args) => Promise<number> {
  let active: Promise<number> | undefined

  function start(...args: Args): Promise<number> {
    if (!pending()) return Promise.resolve(0)
    active = run(...args).finally(() => {
      active = undefined
    })
    return active
  }

  // By the time a waiter runs, the flush it waited on has cleared `active`, so
  // either it starts the next pass or it joins one another waiter just started,
  // which took its snapshot after this caller's write too.
  return (...args) => (active ? active.then(() => active ?? start(...args)) : start(...args))
}
