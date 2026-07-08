import { access, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createError, defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { ALL_PROP_KINDS } from '#shared/utils/propCatalog'
import { HUB_LAYOUT } from '#shared/utils/maze'

/**
 * `POST /api/editor/hub-props` — dev-only. Overwrites `shared/data/hub-props.json`
 * with the placements from the in-game prop editor. Because that file is a
 * build-time input to both the client and server bundles (geometry never travels
 * over the wire), the write triggers a full dev reload and both sides pick up the
 * new hub. It is guarded to dev only: Vercel's production filesystem is read-only,
 * and hand-editing the live tower isn't a thing we want to expose anyway.
 */

const LO = 0.5
const HI = HUB_LAYOUT.size - 0.5
const TWO_PI = Math.PI * 2
const round3 = (n: number) => Math.round(n * 1000) / 1000

const Placement = z.object({
  kind: z.string().refine(k => ALL_PROP_KINDS.has(k), 'unknown prop kind'),
  x: z.number().min(LO).max(HI),
  y: z.number().min(LO).max(HI),
  rot: z.number().refine(Number.isFinite, 'rot must be finite'),
  scale: z.number().min(0.2).max(3),
})
const Body = z.array(Placement).max(500)

/** Find the committed JSON by walking up from cwd (dev may launch in a subdir). */
async function resolveHubPropsFile(): Promise<string> {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'shared', 'data', 'hub-props.json')
    try {
      await access(candidate)
      return candidate
    }
    catch {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw createError({ statusCode: 500, statusMessage: 'hub-props.json not found' })
}

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })

  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid placements', data: parsed.error.issues })
  }

  // Round for tidy diffs and normalize rotation into [0, 2π).
  const rows = parsed.data.map(p => ({
    kind: p.kind,
    x: round3(p.x),
    y: round3(p.y),
    rot: round3(((p.rot % TWO_PI) + TWO_PI) % TWO_PI),
    scale: round3(p.scale),
  }))

  const file = await resolveHubPropsFile()
  await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`)

  return { ok: true as const, count: rows.length }
})
