import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createError, defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { ALL_PROP_KINDS } from '#shared/utils/propCatalog'
import { resolveDataDir } from '../../utils/editorFiles'

/**
 * `POST /api/editor/save` — dev-only. The single save endpoint for the world
 * editor: overwrites `hub-props.json`, `hub-structure.json`, and `floors.json`
 * in one call from the editor's working docs. Dev-only + committed files (Vercel
 * prod FS is read-only, and the world ships bundled). Coordinates are rounded
 * and rotations normalized so diffs stay small; floors must be contiguous from 1.
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

const TrapSchema = z.object({
  x: finite.min(0).max(200),
  y: finite.min(0).max(200),
  period: finite.min(0.1).max(60),
  duration: finite.min(0.05).max(60),
  phase: finite.min(0).max(60),
})

const Floor = z.object({
  version: z.literal(1),
  floor: z.number().int().min(1).max(999),
  size: z.number().int().min(16).max(96),
  biome: z.number().int().min(0).max(3),
  start: z.object({ x: finite, y: finite }),
  exit: z.object({ x: finite, y: finite }),
  traps: z.array(TrapSchema).max(200),
  placements: z.array(Piece).max(2000),
})

const Body = z.object({
  hubProps: z.array(Piece).max(2000),
  hubStructure: z.array(Piece).max(4000),
  floors: z.array(Floor).max(64),
  /** The hub Oracle NPC position `[x, y]` (a top-level array — a top-level-object
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
  const { hubProps, hubStructure, floors } = parsed.data

  // Floors must be contiguous from 1 (the dungeon is a sequential descent).
  const sorted = [...floors].sort((a, b) => a.floor - b.floor)
  sorted.forEach((f, i) => {
    if (f.floor !== i + 1) {
      throw createError({ statusCode: 400, statusMessage: `Floors must be contiguous from 1 (got ${f.floor} at position ${i + 1})` })
    }
    const lo = 1
    const hi = f.size - 1
    for (const m of [f.start, f.exit]) {
      if (m.x < lo || m.x > hi || m.y < lo || m.y > hi) {
        throw createError({ statusCode: 400, statusMessage: `Floor ${f.floor} start/exit out of bounds` })
      }
    }
  })

  const dir = await resolveDataDir()
  const write = (name: string, data: unknown) => writeFile(join(dir, name), `${JSON.stringify(data, null, 2)}\n`)

  await write('hub-props.json', hubProps.map(normPiece))
  await write('hub-structure.json', hubStructure.map(normPiece))
  await write('floors.json', sorted.map(f => ({
    version: 1 as const,
    floor: f.floor,
    size: f.size,
    biome: f.biome,
    start: { x: round3(f.start.x), y: round3(f.start.y) },
    exit: { x: round3(f.exit.x), y: round3(f.exit.y) },
    traps: f.traps.map(t => ({
      x: round3(t.x),
      y: round3(t.y),
      period: round3(t.period),
      duration: round3(t.duration),
      phase: round3(t.phase),
    })),
    placements: f.placements.map(normPiece),
  })))
  if (parsed.data.oracle) {
    const [ox, oy] = parsed.data.oracle
    await write('hub-oracle.json', [round3(ox), round3(oy)])
  }

  return { ok: true as const, hubProps: hubProps.length, hubStructure: hubStructure.length, floors: sorted.length }
})
