import { occupancyGrid } from '#shared/utils/maze'
import { CHUNK_SIZE, SURFACE, WORLD_TILE_MAX, WORLD_TILE_MIN, chunkKey, isProtectedTile, worldProps } from '#shared/utils/world'
import type { Chunk, World } from '#shared/utils/world'
import { COURTYARD, COURTYARD_ASSETS, FORTIFICATIONS, isInMoat, isOnGateBridge, TOWN_GARDENS, TOWN_STREETS } from '#shared/utils/courtyard'
import { MOAT_STAIRS } from '#shared/utils/moat'
import oracle from '#shared/data/courtyard-oracle.json'
import { SURFACE_COLORS } from './surfaceColors'

/**
 * The one painter behind both maps: the round minimap and the full-screen world
 * map draw the same streamed world with the same colours, at different scales
 * and window sizes. Anything drawn here is drawn identically in both, which is
 * the point of the module — two canvases that drift apart read as two games.
 *
 * Everything comes off `useWorld`'s streamed chunks. A chunk the client does
 * not hold is simply not painted; nothing is generated to fill it in.
 */

export const MAP_COLORS = {
  backdrop: 'rgba(6, 9, 14, 0.85)',
  wall: '#666751',
  water: '#369b98',
  bridge: '#d6c5a3',
  street: '#d6c5a3',
  garden: '#779661',
  arena: '#d4bb87',
  arenaRim: '#eee0bb',
  tread: '#82847e',
  flight: '#ded5be',
  tree: '#65815a',
  fountain: '#73c5c5',
  oracle: '#b9eaff',
} as const

/** Where the painted rectangle sits: `scale` pixels per world tile, centred on
 *  `centerX`/`centerY`, filling a `width`×`height` canvas. */
export interface WorldPaint {
  world: World
  scale: number
  centerX: number
  centerY: number
  width: number
  height: number
}

export interface MapProjection {
  (wx: number, wy: number): { x: number, y: number }
}

/** North-up, no rotation: world +x is screen right, world +y is screen down. */
export function mapProjection(p: WorldPaint): MapProjection {
  return (wx, wy) => ({
    x: p.width / 2 + (wx - p.centerX) * p.scale,
    y: p.height / 2 + (wy - p.centerY) * p.scale,
  })
}

/** Display wall raster per chunk, kept against the chunk's version so an edit
 *  or a resync rebuilds it. Shared by both maps — they ask for the same grids. */
const occupancy = new Map<string, { v: number, grid: Uint8Array }>()

function wallGrid(chunk: Chunk): Uint8Array {
  const key = chunkKey(chunk.cx, chunk.cy)
  let cached = occupancy.get(key)
  if (!cached || cached.v !== chunk.version) {
    cached = { v: chunk.version, grid: occupancyGrid(chunk) }
    occupancy.set(key, cached)
  }
  return cached.grid
}

/** The tile rectangle covered by the canvas, clamped to the world edge. */
function viewRect(p: WorldPaint) {
  const halfX = p.width / (2 * p.scale)
  const halfY = p.height / (2 * p.scale)
  return {
    minX: Math.max(WORLD_TILE_MIN, Math.floor(p.centerX - halfX)),
    maxX: Math.min(WORLD_TILE_MAX - 1, Math.ceil(p.centerX + halfX)),
    minY: Math.max(WORLD_TILE_MIN, Math.floor(p.centerY - halfY)),
    maxY: Math.min(WORLD_TILE_MAX - 1, Math.ceil(p.centerY + halfY)),
  }
}

/** Walk every loaded chunk's tiles inside the view, chunk by chunk — the map
 *  can only show ground the server has actually given us. */
function eachTile(p: WorldPaint, fn: (chunk: Chunk, tx: number, ty: number, index: number) => void) {
  const rect = viewRect(p)
  for (const chunk of p.world.chunks.values()) {
    const baseX = chunk.cx * CHUNK_SIZE
    const baseY = chunk.cy * CHUNK_SIZE
    const fromX = Math.max(rect.minX, baseX)
    const toX = Math.min(rect.maxX, baseX + CHUNK_SIZE - 1)
    const fromY = Math.max(rect.minY, baseY)
    const toY = Math.min(rect.maxY, baseY + CHUNK_SIZE - 1)
    for (let ty = fromY; ty <= toY; ty++) {
      for (let tx = fromX; tx <= toX; tx++) {
        fn(chunk, tx, ty, (ty - baseY) * CHUNK_SIZE + (tx - baseX))
      }
    }
  }
}

function groundColor(chunk: Chunk, tx: number, ty: number, index: number): string {
  // Inside the protected footprint the raster is a uniform `path` placeholder —
  // the town's ground is authored, not painted — so the paved square reads as
  // paving and everything around it as the meadow it actually is. Outside the
  // footprint, the outer tiles of a town chunk included, the raster is real and
  // carries whatever players have painted.
  if (isProtectedTile(tx, ty)) {
    const paved = tx >= COURTYARD.min && tx < COURTYARD.max && ty >= COURTYARD.min && ty < COURTYARD.max
    return SURFACE_COLORS[paved ? SURFACE.path : SURFACE.grass]!
  }
  return SURFACE_COLORS[chunk.surface[index] ?? SURFACE.grass] ?? SURFACE_COLORS[SURFACE.grass]!
}

/**
 * Paint one rectangle of the world: ground, walls, the moat and its bridge, the
 * town's streets, gardens and arena, every stair flight, the landmark props and
 * the Oracle. Players are drawn on top by the caller, which knows which one is
 * you.
 */
export function paintWorld(ctx: CanvasRenderingContext2D, p: WorldPaint): void {
  const project = mapProjection(p)
  const scale = p.scale
  const cell = scale + 0.5

  // Everything is clipped to the chunks we actually hold. The town's streets
  // and landmarks are authored constants we could draw anywhere, and drawing
  // them over ground that has not streamed in yet would be the map inventing
  // world the client cannot walk on.
  ctx.save()
  ctx.beginPath()
  for (const chunk of p.world.chunks.values()) {
    const origin = project(chunk.cx * CHUNK_SIZE, chunk.cy * CHUNK_SIZE)
    ctx.rect(origin.x, origin.y, CHUNK_SIZE * scale + 0.5, CHUNK_SIZE * scale + 0.5)
  }
  ctx.clip()

  eachTile(p, (chunk, tx, ty, index) => {
    const wall = wallGrid(chunk)[index] === 1
    const bridge = isOnGateBridge(tx + 0.5, ty + 0.5)
    const moat = isInMoat(tx + 0.5, ty + 0.5)
    ctx.fillStyle = bridge ? MAP_COLORS.bridge : moat ? MAP_COLORS.water : wall ? MAP_COLORS.wall : groundColor(chunk, tx, ty, index)
    const { x, y } = project(tx, ty)
    ctx.fillRect(x, y, cell, cell)
  })

  for (const street of TOWN_STREETS) {
    const start = project(street.x1, street.z1)
    const end = project(street.x2, street.z2)
    ctx.strokeStyle = MAP_COLORS.street
    ctx.lineWidth = street.width * scale
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()
  }
  for (const garden of TOWN_GARDENS) {
    const point = project(garden.x, garden.z)
    ctx.fillStyle = MAP_COLORS.garden
    ctx.beginPath()
    ctx.ellipse(point.x, point.y, garden.rx * scale, garden.rz * scale, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  // Preserve solid footprints where a road passes beside a building.
  ctx.fillStyle = MAP_COLORS.wall
  eachTile(p, (chunk, tx, ty, index) => {
    if (wallGrid(chunk)[index] !== 1 || isInMoat(tx + 0.5, ty + 0.5)) return
    const point = project(tx, ty)
    ctx.fillRect(point.x, point.y, cell, cell)
  })

  const rect = viewRect(p)
  const margin = 8
  const visibleProps = [...worldProps(p.world)].filter(prop =>
    prop.x >= rect.minX - margin && prop.x <= rect.maxX + margin
    && prop.y >= rect.minY - margin && prop.y <= rect.maxY + margin)

  /** Treads drawn in the flight's own frame, so an authored rotation carries. */
  function drawStairs(cx: number, cy: number, width: number, run: number, rot: number) {
    const point = project(cx, cy)
    ctx.save()
    ctx.translate(point.x, point.y)
    ctx.rotate(-rot)
    const length = run * scale
    ctx.fillStyle = MAP_COLORS.flight
    ctx.fillRect(-width * scale / 2, -length / 2, width * scale, length)
    ctx.fillStyle = MAP_COLORS.tread
    for (let i = 1; i < 9; i++) ctx.fillRect(-width * scale / 2, -length / 2 + length * i / 9, width * scale, 1)
    ctx.restore()
  }
  drawStairs(MOAT_STAIRS.x, (MOAT_STAIRS.zStart + MOAT_STAIRS.zEnd) / 2, MOAT_STAIRS.width, MOAT_STAIRS.zEnd - MOAT_STAIRS.zStart, 0)
  const flight = COURTYARD_ASSETS.Courtyard_Stairs
  for (const prop of visibleProps) {
    if (prop.kind !== 'Courtyard_Stairs') continue
    drawStairs(prop.x, prop.y, flight.width * (prop.s3?.[0] ?? prop.scale), flight.depth * (prop.s3?.[2] ?? prop.scale), prop.rot)
  }

  const arena = project(COURTYARD.arena.x, COURTYARD.arena.y)
  ctx.fillStyle = MAP_COLORS.arena
  ctx.strokeStyle = MAP_COLORS.arenaRim
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(arena.x, arena.y, COURTYARD.arena.radius * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  for (const prop of visibleProps) {
    if (!['Courtyard_Tree', 'Courtyard_Fountain'].includes(prop.kind)) continue
    const point = project(prop.x, prop.y)
    ctx.fillStyle = prop.kind === 'Courtyard_Tree' ? MAP_COLORS.tree : MAP_COLORS.fountain
    ctx.beginPath()
    ctx.arc(point.x, point.y, (prop.kind === 'Courtyard_Tree' ? 1.8 * prop.scale : prop.r) * scale, 0, Math.PI * 2)
    ctx.fill()
  }
  const npc = project(oracle[0]!, oracle[1]!)
  ctx.fillStyle = MAP_COLORS.oracle
  ctx.beginPath()
  ctx.moveTo(npc.x, npc.y - 3.5)
  ctx.lineTo(npc.x + 3, npc.y)
  ctx.lineTo(npc.x, npc.y + 3.5)
  ctx.lineTo(npc.x - 3, npc.y)
  ctx.closePath()
  ctx.fill()

  ctx.restore()
}

/** Another player: a dot in their own colour. */
export function drawPlayerDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, radius = 3): void {
  ctx.fillStyle = color
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

/** You: an arrow pointing where you are looking. */
export function drawSelfArrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size = 6): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle + Math.PI / 2)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(0, -size)
  ctx.lineTo(size * 0.75, size * 0.833)
  ctx.lineTo(-size * 0.75, size * 0.833)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** The chunk lattice and the world edge, for the full-screen map: it says how
 *  much of the world you are holding and how much of it there is. */
export function paintChunkGrid(ctx: CanvasRenderingContext2D, p: WorldPaint): void {
  const project = mapProjection(p)
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let tx = WORLD_TILE_MIN; tx <= WORLD_TILE_MAX; tx += CHUNK_SIZE) {
    const top = project(tx, WORLD_TILE_MIN)
    const bottom = project(tx, WORLD_TILE_MAX)
    ctx.moveTo(top.x, top.y)
    ctx.lineTo(bottom.x, bottom.y)
  }
  for (let ty = WORLD_TILE_MIN; ty <= WORLD_TILE_MAX; ty += CHUNK_SIZE) {
    const left = project(WORLD_TILE_MIN, ty)
    const right = project(WORLD_TILE_MAX, ty)
    ctx.moveTo(left.x, left.y)
    ctx.lineTo(right.x, right.y)
  }
  ctx.stroke()
  const edge = project(WORLD_TILE_MIN, WORLD_TILE_MIN)
  const span = (WORLD_TILE_MAX - WORLD_TILE_MIN) * p.scale
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  ctx.strokeRect(edge.x, edge.y, span, span)
  ctx.restore()
}

/** The town's fortified footprint, so the map reads as "town, then world". */
export function paintTownOutline(ctx: CanvasRenderingContext2D, p: WorldPaint): void {
  const project = mapProjection(p)
  const min = project(FORTIFICATIONS.exteriorMin, FORTIFICATIONS.exteriorMin)
  const span = (FORTIFICATIONS.exteriorMax - FORTIFICATIONS.exteriorMin) * p.scale
  ctx.save()
  ctx.strokeStyle = 'rgba(238, 224, 187, 0.55)'
  ctx.setLineDash([6, 4])
  ctx.lineWidth = 1.5
  ctx.strokeRect(min.x, min.y, span, span)
  ctx.restore()
}
