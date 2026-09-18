import type { Ref } from 'vue'

/**
 * The world feed: what other people are doing to the world, right now.
 *
 * It is a HUD surface rather than a log, so it holds a handful of rows and no
 * history. `useGame` fills it from the frames it already receives — there is no
 * feed frame on the wire — which is why attribution is only as good as the
 * protocol: a placement carries its owner, and `terrain` carries `by` for the
 * same reason. The title screen reads the server's own copy of this from
 * `/api/status`, worded identically, since it has no socket to watch.
 *
 * State lives in `useState` rather than a module-level ref: the title screen is
 * prerendered, and a module singleton would be shared across renders there.
 */
export interface FeedEvent {
  /** Stable across a coalesced update and across a poll, so a row animates
   *  rather than replacing itself. */
  id: string
  at: number
  /** Who did it. Rendered in the accent whoever they are — the feed is one
   *  voice, unlike chat, where each player keeps their own colour. */
  name: string
  text: string
  /** Same actor doing the same kind of thing again replaces the row instead of
   *  stacking: a wall goes up in a dozen clicks and the feed shows one line. */
  kind: string
}

/** What the server reports on `/api/status` — a `FeedEvent` without the id. */
export type WorldEvent = Omit<FeedEvent, 'id'>

export interface UseFeed {
  /** Newest first. */
  events: Ref<FeedEvent[]>
  record: (name: string, kind: string, text: string) => void
  /** Adopt the server's rows — the title screen's only source. */
  adopt: (events: WorldEvent[]) => void
  reset: () => void
}

/** Three rows are shown; a few spare cover a burst of activity. */
const LIMIT = 6
const COALESCE = 6_000

export function useFeed(): UseFeed {
  const events = useState<FeedEvent[]>('feed:events', () => [])

  function record(name: string, kind: string, text: string) {
    const at = Date.now()
    const head = events.value[0]
    if (head && head.name === name && head.kind === kind && at - head.at < COALESCE) {
      events.value = [{ ...head, at, text }, ...events.value.slice(1)]
      return
    }
    events.value = [{ id: `${at}:${name}:${kind}`, at, name, kind, text }, ...events.value].slice(0, LIMIT)
  }

  function adopt(incoming: WorldEvent[]) {
    events.value = incoming.slice(0, LIMIT).map(event => ({ ...event, id: `${event.at}:${event.name}:${event.kind}` }))
  }

  function reset() {
    events.value = []
  }

  return { events, record, adopt, reset }
}
