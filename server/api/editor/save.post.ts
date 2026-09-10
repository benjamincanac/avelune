import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createError, defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { ALL_PROP_KINDS } from '#shared/utils/propCatalog'
import { resolveDataDir } from '../../utils/editorFiles'

/**
 * `POST /api/editor/save` — dev-only. The single save endpoint for the world
 * editor: overwrites `courtyard-props.json`, `courtyard-structure.json` and `courtyard-oracle.json`
 * in one call from the editor's working doc. Dev-only + committed files (Vercel
 * prod FS is read-only, and the world ships bundled). Coordinates are rounded
 * and rotations normalized so diffs stay small.
 */

const TWO_PI = Math.PI * 2
const round3 = (n: number) => Math.round(n * 1000) / 1000
const finite = z.number().refine(Number.isFinite, 'must be finite')

const Piece = z.object({
  kind: z.string().refine(k => ALL_PROP_KINDS.has(k), 'unknown prop kind'),
  x: finite.min(-4).max(200),
  y: finite.min(-4).max(200),
  rot: finite,
  scale: finite.min(0.05).max(5),
  z: finite.min(0).max(60).optional(),
  s3: z.tuple([finite.min(0.05).max(5), finite.min(0.05).max(5), finite.min(0.05).max(5)]).optional(),
})

const Body = z.object({
  hubProps: z.array(Piece).max(2000),
  hubStructure: z.array(Piece).max(4000),
  /** The Oracle NPC position `[x, y]` (a top-level array — a top-level-object
   *  JSON would crash the Nitro-beta dev worker). Optional. */
  oracle: z.tuple([finite, finite]).optional(),
})

const normPiece = (p: z.infer<typeof Piece>) => ({
  kind: p.kind,
  x: round3(p.x),
  y: round3(p.y),
  rot: round3(((p.rot % TWO_PI) + TWO_PI) % TWO_PI),
  scale: round3(p.scale),
  ...(p.z != null ? { z: round3(p.z) } : {}),
  ...(p.s3 ? { s3: p.s3.map(round3) as [number, number, number] } : {}),
})

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })

  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid layout', data: parsed.error.issues })
  }
  const { hubProps, hubStructure, oracle } = parsed.data

  const dir = await resolveDataDir()
  const write = (name: string, data: unknown) => writeFile(join(dir, name), `${JSON.stringify(data, null, 2)}\n`)

  await write('courtyard-props.json', hubProps.map(normPiece))
  await write('courtyard-structure.json', hubStructure.map(normPiece))
  if (oracle) await write('courtyard-oracle.json', [round3(oracle[0]), round3(oracle[1])])

  return { ok: true as const, hubProps: hubProps.length, hubStructure: hubStructure.length }
})
