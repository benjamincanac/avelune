import { access, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createError, defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { ALL_PROP_KINDS } from '#shared/utils/propCatalog'
import { HUB_LAYOUT } from '#shared/utils/maze'

/**
 * `POST /api/editor/hub-structure` — dev-only. Overwrites
 * `shared/data/hub-structure.json` with the "exploded" village pieces from the
 * in-game editor (walls, roofs, statues, …). Same dev-only, committed-file
 * design as the sibling `hub-props` route (Vercel prod FS is read-only), but the
 * schema allows `z` (elevation) and `s3` (per-axis scale) for building pieces.
 */

const TWO_PI = Math.PI * 2
const round3 = (n: number) => Math.round(n * 1000) / 1000
const finite = z.number().refine(Number.isFinite, 'must be finite')

const Piece = z.object({
  kind: z.string().refine(k => ALL_PROP_KINDS.has(k), 'unknown prop kind'),
  // Building pieces can sit near the border (fences, gate) — generous bounds.
  x: finite.min(-2).max(HUB_LAYOUT.size + 2),
  y: finite.min(-2).max(HUB_LAYOUT.size + 2),
  rot: finite,
  scale: finite.min(0.05).max(5),
  z: finite.min(0).max(60).optional(),
  s3: z.tuple([finite.min(0.05).max(5), finite.min(0.05).max(5), finite.min(0.05).max(5)]).optional(),
})
const Body = z.array(Piece).max(2000)

async function resolveFile(): Promise<string> {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'shared', 'data', 'hub-structure.json')
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
  throw createError({ statusCode: 500, statusMessage: 'hub-structure.json not found' })
}

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })

  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid pieces', data: parsed.error.issues })
  }

  const rows = parsed.data.map(p => ({
    kind: p.kind,
    x: round3(p.x),
    y: round3(p.y),
    rot: round3(((p.rot % TWO_PI) + TWO_PI) % TWO_PI),
    scale: round3(p.scale),
    ...(p.z != null ? { z: round3(p.z) } : {}),
    ...(p.s3 ? { s3: p.s3.map(round3) as [number, number, number] } : {}),
  }))

  const file = await resolveFile()
  await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`)

  return { ok: true as const, count: rows.length }
})
