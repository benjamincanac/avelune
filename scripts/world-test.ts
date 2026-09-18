// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/world-test.ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  DASH_MULTIPLIER,
  JUMP_VELOCITY,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
  PLAYER_RADIUS,
  isWalkable,
  slideBody,
  getFountainWaterContact,
  stepBody,
  surfaceHeight,
} from '../shared/utils/maze'
import type { KinematicBody } from '../shared/utils/maze'
import type { PropSpec } from '../shared/utils/props'
import { applyPlace, createWorld, encodeChunk, worldProps, WORLD_TILE_MAX, WORLD_TILE_MIN } from '../shared/utils/world'
import type { World } from '../shared/utils/world'
import oraclePosition from '../shared/data/courtyard-oracle.json'
import { COURTYARD, COURTYARD_ASSETS, FOUNTAIN, FORTIFICATIONS, TOWN_DISTRICTS, TOWN_STREETS } from '../shared/utils/courtyard'

const plan = createWorld()
/** Every piece the town seeded, the way the old flat `plan.props` read. */
const townProps = [...worldProps(plan)]
/** A world holding a single piece, for footprint tests that need no neighbours.
 *  Town coordinates keep the terrain under it level, exactly as before. */
function soloWorld(prop: PropSpec): World {
  const world = createWorld({ town: false })
  applyPlace(world, {
    id: 'solo',
    kind: prop.kind,
    x: prop.x,
    y: prop.y,
    rot: prop.rot,
    scale: prop.scale,
    ...(prop.z != null ? { z: prop.z } : {}),
    ...(prop.s3 ? { s3: prop.s3 } : {}),
  })
  return world
}
const dt = 1 / 20
const bodyAt = (x: number, y: number): KinematicBody => ({ x, y, z: 0, vz: 0, grounded: true })

function walk(body: KinematicBody, x: number, y: number, steps = 100, speed = PLAYER_SPEED, world: World = plan) {
  for (let i = 0; i < steps; i++) stepBody(world, body, x * speed * dt, y * speed * dt, dt)
  return body
}

test('spawn has ground and clearance in all eight directions', () => {
  assert.equal(surfaceHeight(plan, plan.start.x, plan.start.y), 0)
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 4 * i
    const body = walk(bodyAt(plan.start.x, plan.start.y), Math.cos(a), Math.sin(a), 10)
    assert.ok(Math.hypot(body.x - plan.start.x, body.y - plan.start.y) > 1.5)
    assert.equal(body.z, 0)
  }
})

// The old fortification exterior is no longer the edge of the world: the meadow
// outside the walls is real terrain now. The hard wall is the world bound.
test('all four world edges contain walking and dashing players', () => {
  const near = 6
  const approaches = [[72, WORLD_TILE_MAX - near, 0, 1], [72, WORLD_TILE_MIN + near, 0, -1], [WORLD_TILE_MIN + near, 72, -1, 0], [WORLD_TILE_MAX - near, 72, 1, 0]] as const
  for (const speed of [PLAYER_SPEED, PLAYER_SPEED * SPRINT_MULTIPLIER, PLAYER_SPEED * DASH_MULTIPLIER]) {
    for (const [x, y, dx, dy] of approaches) {
      const body = walk(bodyAt(x, y), dx, dy, 100, speed)
      assert.ok(body.x >= WORLD_TILE_MIN + PLAYER_RADIUS && body.x <= WORLD_TILE_MAX - PLAYER_RADIUS && body.y >= WORLD_TILE_MIN + PLAYER_RADIUS && body.y <= WORLD_TILE_MAX - PLAYER_RADIUS)
    }
  }
})

test('placed buildings block their front approach, including rotated facades', () => {
  for (const prop of townProps.filter(p => /Courtyard_(Inn|Shop|Tower)/.test(p.kind))) {
    const dx = Math.sin(prop.rot)
    const dy = Math.cos(prop.rot)
    const body = bodyAt(prop.x + dx * (prop.by! + 1), prop.y + dy * (prop.by! + 1))
    walk(body, -dx, -dy, 80)
    assert.equal(body.z, 0)
    assert.ok(Math.hypot(body.x - prop.x, body.y - prop.y) >= prop.by! - 0.01)
  }
})

test('diagonal building collision follows the visible Three.js Y rotation', () => {
  const inn = townProps.find(p => p.kind === 'Courtyard_Inn')!
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    const prop = { ...inn, x: 52, y: 52, rot }
    const world = soloWorld(prop)
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const point = (x: number, y: number) => ({ x: prop.x + x * c + y * s, y: prop.y - x * s + y * c })
    const inside = point(3.8, 2.3)
    const outside = point(2.3, 3.8)
    assert.equal(surfaceHeight(world, inside.x, inside.y), prop.top)
    assert.equal(surfaceHeight(world, outside.x, outside.y), 0)
    // Approach an off-center part of the facade that the mirrored box misses.
    const start = point(3.5, 2.7)
    const body = walk(bodyAt(start.x, start.y), -s, -c, 8, PLAYER_SPEED, world)
    const localY = (body.x - prop.x) * s + (body.y - prop.y) * c
    assert.ok(localY > prop.by!)
    assert.equal(body.z, 0)
  }
})

test('a body keeps its whole width out of every town building', () => {
  for (const prop of townProps.filter(p => /Courtyard_(Inn|Shop|Tower)/.test(p.kind))) {
    const c = Math.cos(prop.rot)
    const s = Math.sin(prop.rot)
    for (const speed of [PLAYER_SPEED, PLAYER_SPEED * SPRINT_MULTIPLIER, PLAYER_SPEED * DASH_MULTIPLIER]) {
      for (let i = 0; i < 16; i++) {
        const a = Math.PI / 8 * i + 0.13
        const body = bodyAt(prop.x + Math.cos(a) * (prop.r + 1.5), prop.y + Math.sin(a) * (prop.r + 1.5))
        if (surfaceHeight(plan, body.x, body.y) !== 0) continue
        // Far enough to reach the facade, not far enough to slide off to the ramparts.
        walk(body, -Math.cos(a), -Math.sin(a), Math.ceil(3 / (speed * dt)), speed)
        const lx = Math.abs((body.x - prop.x) * c - (body.y - prop.y) * s) - prop.bx!
        const ly = Math.abs((body.x - prop.x) * s + (body.y - prop.y) * c) - prop.by!
        assert.ok(Math.hypot(Math.max(lx, 0), Math.max(ly, 0)) >= PLAYER_RADIUS - 1e-6, `${prop.kind} at ${prop.x},${prop.y} let a body in from ${a.toFixed(2)}`)
        assert.ok(body.z < 1, `${prop.kind} at ${prop.x},${prop.y} lifted a body to ${body.z}`)
      }
    }
  }
})

// The client eases its predicted body toward the server's. Around a corner that
// straight line crosses the footprint, and a body inside one lands on the roof.
test('a reconcile nudge across a building corner stays outside it', () => {
  const inn = townProps.find(p => p.kind === 'Courtyard_Inn')!
  const world = soloWorld({ ...inn, x: 52, y: 52, rot: 0 })
  const body = bodyAt(52 + inn.bx! + 0.4, 52 + inn.by! - 0.2)
  const target = { x: 52 + inn.bx! - 0.2, y: 52 + inn.by! + 0.4 }
  for (let i = 0; i < 40; i++) {
    slideBody(world, body, (target.x - body.x) * 0.3, (target.y - body.y) * 0.3)
    stepBody(world, body, 0, 0, dt)
    assert.equal(body.z, 0)
  }
})

test('tree trunks stop centered walking and dashing players', () => {
  for (const prop of townProps.filter(p => p.kind === 'Courtyard_Tree')) {
    for (const speed of [PLAYER_SPEED, PLAYER_SPEED * SPRINT_MULTIPLIER, PLAYER_SPEED * DASH_MULTIPLIER]) {
      const body = walk(bodyAt(prop.x - prop.r - 1, prop.y), 1, 0, 100, speed)
      assert.ok(body.x <= prop.x - prop.r)
      assert.equal(body.z, 0)
    }
  }
})

test('fountain has a large stepped basin and a solid central pedestal', () => {
  const prop = townProps.find(p => p.kind === 'Courtyard_Fountain')!
  assert.deepEqual(COURTYARD.fountain, { x: prop.x, y: prop.y })
  assert.equal(prop.scale, 1.4)
  assert.equal(prop.r, COURTYARD_ASSETS.Courtyard_Fountain.radius * 1.4)
  for (const [radius, height] of [[3.9, 0], [3.65, 0.18], [3.4, 0.36], [3.15, 0.54], [2.95, 0.30], [2, 0.12], [0.4, 2.7]]) {
    assert.equal(surfaceHeight(plan, prop.x + radius! * prop.scale, prop.y), height! * prop.scale)
  }
  const world = soloWorld(prop)
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 4 * i
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    for (const speed of [PLAYER_SPEED, PLAYER_SPEED * SPRINT_MULTIPLIER, PLAYER_SPEED * DASH_MULTIPLIER]) {
      const body = bodyAt(prop.x + dx * (prop.r + 0.5), prop.y + dy * (prop.r + 0.5))
      walk(body, -dx, -dy, 100, speed, world)
      const radius = Math.hypot(body.x - prop.x, body.y - prop.y)
      assert.ok(radius > FOUNTAIN.pedestalRadius * prop.scale)
      assert.ok(radius < 2, `entered basin at angle ${a}: ${radius}`)
      assert.equal(body.z, FOUNTAIN.floorHeight * prop.scale)
      walk(body, dx, dy, Math.ceil(12 / (speed * dt)), speed, world)
      walk(body, 0, 0, 20, speed, world)
      assert.ok(Math.hypot(body.x - prop.x, body.y - prop.y) > prop.r)
      assert.equal(body.z, 0)
    }
  }
})

test('the pedestal blocks a grounded jump from inside the basin', () => {
  const prop = townProps.find(p => p.kind === 'Courtyard_Fountain')!
  const world = soloWorld(prop)
  const body = { ...bodyAt(prop.x + 1.4, prop.y), z: FOUNTAIN.floorHeight * prop.scale, vz: JUMP_VELOCITY, grounded: false }
  walk(body, -1, 0, 50, PLAYER_SPEED, world)
  assert.ok(body.x > prop.x + FOUNTAIN.pedestalRadius * prop.scale)
  assert.equal(body.z, FOUNTAIN.floorHeight * prop.scale)
})

test('water slows wading, releases jumping feet, and leaves dry movement unchanged', () => {
  const prop = townProps.find(p => p.kind === 'Courtyard_Fountain')!
  const world = soloWorld(prop)
  const body = { ...bodyAt(prop.x + 2, prop.y), z: FOUNTAIN.floorHeight * prop.scale }
  const contact = getFountainWaterContact(prop, body)!
  assert.ok(contact.depth > 0.5)
  const startX = body.x
  stepBody(world, body, 0.1, 0, dt)
  assert.ok(body.x - startX < 0.07)
  body.vz = JUMP_VELOCITY
  walk(body, 0, 0, 3, PLAYER_SPEED, world)
  assert.equal(getFountainWaterContact(prop, body), null)
  walk(body, 0, 0, 30, PLAYER_SPEED, world)
  assert.ok(getFountainWaterContact(prop, body))
  const dry = bodyAt(prop.x + prop.r + 1, prop.y)
  const dryX = dry.x
  stepBody(world, dry, 0.1, 0, dt)
  assert.equal(dry.x, dryX + 0.1)
  assert.equal(dry.z, 0)
  assert.equal(getFountainWaterContact(prop, dry), null)
})

test('fountain footprints and water contact follow rotated per-axis scale', () => {
  const source = townProps.find(p => p.kind === 'Courtyard_Fountain')!
  const prop = { ...source, s3: [1.8, 1.4, 0.8] as [number, number, number], rot: Math.PI / 3, r: FOUNTAIN.outerRadius * 1.8, z: 20 }
  const world = soloWorld(prop)
  const point = (x: number, y: number) => ({
    x: prop.x + x * 1.8 * Math.cos(prop.rot) + y * 0.8 * Math.sin(prop.rot),
    y: prop.y - x * 1.8 * Math.sin(prop.rot) + y * 0.8 * Math.cos(prop.rot),
  })
  for (const [x, y] of [[2, 0], [0, 2], [-2, 0], [0, -2]]) {
    const p = point(x!, y!)
    assert.equal(surfaceHeight(world, p.x, p.y), FOUNTAIN.floorHeight * 1.4)
    const contact = getFountainWaterContact(prop, { ...p, z: FOUNTAIN.floorHeight * 1.4 })!
    assert.ok(Math.abs(contact.x - x!) < 1e-12)
    assert.ok(Math.abs(contact.y - y!) < 1e-12)
    assert.equal(contact.surfaceHeight, FOUNTAIN.waterHeight * 1.4)
  }
  const start = point(4, 0)
  const mirror = soloWorld(prop)
  const a = bodyAt(start.x, start.y)
  const b = { ...a }
  for (let i = 0; i < 80; i++) {
    const dx = -Math.cos(prop.rot) * PLAYER_SPEED * dt
    const dy = Math.sin(prop.rot) * PLAYER_SPEED * dt
    stepBody(world, a, dx, dy, dt)
    stepBody(mirror, b, dx, dy, dt)
    assert.deepEqual(a, b)
  }
  assert.ok(getFountainWaterContact(prop, a))
})

test('bench blocks walking, supports jump landings, and allows walking off', () => {
  const prop = townProps.find(p => p.kind === 'Courtyard_Bench')!
  // From the open side: the bench backs onto an inn, and a body has no room
  // to stand between the two.
  const body = bodyAt(prop.x, prop.y + prop.by! + 0.6)
  walk(body, 0, -1, 10)
  assert.ok(body.y >= prop.y + prop.by! + PLAYER_RADIUS)
  body.vz = JUMP_VELOCITY
  body.grounded = false
  walk(body, 0, -1, 5)
  walk(body, 0, 0, 30)
  assert.ok(body.y > prop.y - prop.by! && body.y < prop.y + prop.by!)
  assert.equal(body.z, prop.top)
  assert.equal(body.grounded, true)
  walk(body, 1, 0, 20)
  walk(body, 0, 0, 20)
  assert.equal(body.z, 0)
})

test('independently generated worlds produce identical movement', () => {
  const firstPlan = createWorld()
  const secondPlan = createWorld()
  assert.deepEqual([...secondPlan.chunks.keys()].sort(), [...firstPlan.chunks.keys()].sort())
  for (const key of firstPlan.chunks.keys()) assert.deepEqual(encodeChunk(secondPlan.chunks.get(key)!), encodeChunk(firstPlan.chunks.get(key)!))
  const a = bodyAt(plan.start.x, plan.start.y)
  const b = { ...a }
  for (let i = 0; i < 2000; i++) {
    const x = Math.cos(i * 0.043) * PLAYER_SPEED * dt
    const y = Math.sin(i * 0.037) * PLAYER_SPEED * dt
    if (i % 37 === 0 && a.grounded) {
      a.vz = JUMP_VELOCITY
      b.vz = JUMP_VELOCITY
    }
    stepBody(firstPlan, a, x, y, dt)
    stepBody(secondPlan, b, x, y, dt)
    assert.deepEqual(a, b)
  }
})

test('town buildings have separate footprints inside the playable boundary', () => {
  const buildings = townProps.filter(p => /Courtyard_(Inn|Shop|Tower)/.test(p.kind))
  assert.equal(COURTYARD.max - COURTYARD.min, 80)
  assert.ok(buildings.length >= 30)
  const axes = (rot: number) => [[Math.cos(rot), -Math.sin(rot)], [Math.sin(rot), Math.cos(rot)]] as const
  const projection = (prop: typeof buildings[number], x: number, y: number) => {
    const [right, front] = axes(prop.rot)
    return Math.abs(x * right[0] + y * right[1]) * prop.bx! + Math.abs(x * front[0] + y * front[1]) * prop.by!
  }
  for (const [index, prop] of buildings.entries()) {
    const width = projection(prop, 1, 0)
    const depth = projection(prop, 0, 1)
    assert.ok(prop.x - width > COURTYARD.min && prop.x + width < COURTYARD.max)
    assert.ok(prop.y - depth > COURTYARD.min && prop.y + depth < COURTYARD.max)
    for (const other of buildings.slice(index + 1)) {
      const separate = [...axes(prop.rot), ...axes(other.rot)].some(([x, y]) =>
        Math.abs((other.x - prop.x) * x + (other.y - prop.y) * y) >= projection(prop, x, y) + projection(other, x, y) + 0.2,
      )
      assert.ok(separate, `overlapping buildings at ${prop.x},${prop.y} and ${other.x},${other.y}`)
    }
  }
})

test('building footprints leave the fountain stone border and walking space clear', () => {
  for (const prop of townProps.filter(p => /Courtyard_(Inn|Shop|Tower)$/.test(p.kind))) {
    const dx = COURTYARD.arena.x - prop.x
    const dy = COURTYARD.arena.y - prop.y
    const c = Math.cos(prop.rot)
    const s = Math.sin(prop.rot)
    const localX = dx * c - dy * s
    const localY = dx * s + dy * c
    const distance = Math.hypot(Math.max(0, Math.abs(localX) - prop.bx!), Math.max(0, Math.abs(localY) - prop.by!))
    assert.ok(distance >= COURTYARD.arena.radius + 1.25, `building crowds plaza at ${prop.x},${prop.y}`)
  }
})

test('town streets and every building frontage remain connected to spawn', () => {
  // Sample player-sized dry ground, then traverse each edge through the same
  // kinematics used by prediction and the server. A clear minimap tile alone
  // does not guarantee that a street fits a player between authored props.
  const spacing = 0.5
  const nodes = new Map<string, { x: number, y: number }>()
  const key = (x: number, y: number) => `${x},${y}`
  for (let x = FORTIFICATIONS.exteriorMin + spacing; x < FORTIFICATIONS.exteriorMax; x += spacing) {
    for (let y = FORTIFICATIONS.exteriorMin + spacing; y < FORTIFICATIONS.exteriorMax; y += spacing) {
      let clear = surfaceHeight(plan, x, y) === 0
      for (let i = 0; clear && i < 8; i++) {
        const angle = i * Math.PI / 4
        const px = x + Math.cos(angle) * (PLAYER_RADIUS + 0.05)
        const py = y + Math.sin(angle) * (PLAYER_RADIUS + 0.05)
        clear = isWalkable(plan, Math.floor(px), Math.floor(py)) && surfaceHeight(plan, px, py) === 0
      }
      if (clear) nodes.set(key(x, y), { x, y })
    }
  }
  const queue = [{ x: plan.start.x, y: plan.start.y }]
  const reached = new Set([key(plan.start.x, plan.start.y)])
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index]!
    for (const [dx, dy] of [[spacing, 0], [-spacing, 0], [0, spacing], [0, -spacing]]) {
      const destination = key(source.x + dx!, source.y + dy!)
      if (!nodes.has(destination) || reached.has(destination)) continue
      const body = bodyAt(source.x, source.y)
      for (let substep = 0; substep < 4; substep++) stepBody(plan, body, dx! / 4, dy! / 4, dt)
      if (Math.hypot(body.x - source.x - dx!, body.y - source.y - dy!) > 0.001 || body.z !== 0) continue
      reached.add(destination)
      queue.push(nodes.get(destination)!)
    }
  }
  // The Oracle is authored in the editor at arbitrary coordinates; test the
  // nearest flood node instead.
  const oracleNode = [Math.round(oraclePosition[0]! * 2) / 2, Math.round(oraclePosition[1]! * 2) / 2]
  for (const [x, y] of [[72, 84], [64, 72], [80, 72], [72, 62], [46, 72], [89, 72], [72, 56], [72, 100], [72, 109], [12, 12], [132, 12], [12, 132], [132, 132], ...TOWN_DISTRICTS.filter(d => d.name !== 'Fountain Square').map(d => [d.x, d.z]), oracleNode]) {
    assert.ok(reached.has(key(x!, y!)), `street at ${x},${y} is disconnected from spawn`)
  }
  for (const prop of townProps.filter(p => /Courtyard_(Inn|Shop|Tower)/.test(p.kind))) {
    const doorOffset = prop.kind === 'Courtyard_Shop' ? -1.61 * (prop.s3?.[0] ?? prop.scale) : 0
    const x = prop.x + Math.sin(prop.rot) * (prop.by! + 1) + Math.cos(prop.rot) * doorOffset
    const y = prop.y + Math.cos(prop.rot) * (prop.by! + 1) - Math.sin(prop.rot) * doorOffset
    assert.ok(queue.some(node => Math.hypot(node.x - x, node.y - y) < 0.6), `frontage of ${prop.kind} at ${prop.x},${prop.y} is inaccessible`)
  }
  // The narrow defensive berm between the moat and ramparts is not a street.
  // Nor is a lone sample wedged between two facades: the ring above probes
  // eight points, and a body is a full disc that does not fit the gap leading in.
  const stranded = (x: number, y: number) => nodes.has(key(x, y)) && !reached.has(key(x, y))
  const disconnected = [...nodes].filter(([position, node]) =>
    !reached.has(position) && node.x > COURTYARD.min + 1 && node.x < COURTYARD.max - 1
    && node.y > COURTYARD.min + 1 && node.y < COURTYARD.max - 1
    && (stranded(node.x + spacing, node.y) || stranded(node.x - spacing, node.y) || stranded(node.x, node.y + spacing) || stranded(node.x, node.y - spacing)),
  )
  assert.equal(disconnected.length, 0, `isolated dry ground: ${disconnected.slice(0, 6).map(([position]) => position).join('; ')}`)
})

test('spawn is outside and Oracle is inside, with a ground-level route through the gate in both directions', () => {
  assert.ok(plan.start.y > FORTIFICATIONS.moatOuterMax)
  // courtyard-oracle.json is [x, y, rot], authored in the world editor.
  assert.ok(oraclePosition[0]! > COURTYARD.min && oraclePosition[0]! < COURTYARD.max)
  assert.ok(oraclePosition[1]! > COURTYARD.min && oraclePosition[1]! < COURTYARD.max)
  assert.equal(surfaceHeight(plan, oraclePosition[0]!, oraclePosition[1]!), 0)
  const body = bodyAt(plan.start.x, plan.start.y)
  walk(body, 0, -1, 300)
  assert.ok(body.y < 90, `gate blocked at ${body.y}`)
  assert.equal(body.z, 0)
  walk(body, 0, 1, 300)
  assert.ok(body.y > 123)
  assert.equal(body.z, 0)
})

test('ground-level ramparts block shortcuts even while jumping and dashing', () => {
  for (const jumping of [false, true]) {
    for (const [x, y, dx, dy] of [[72, 36, 0, -1], [36, 72, -1, 0], [108, 72, 1, 0], [58, 108, 0, 1]]) {
      const body = bodyAt(x!, y!)
      if (jumping) {
        body.vz = JUMP_VELOCITY
        body.grounded = false
      }
      walk(body, dx!, dy!, 40, PLAYER_SPEED * DASH_MULTIPLIER)
      assert.ok(Math.hypot(body.x - x!, body.y - y!) < 4, `shortcut from ${x},${y} to ${body.x},${body.y}`)
    }
  }
})

test('bridge parapets contain walking and dashing players', () => {
  for (const direction of [-1, 1]) {
    for (const speed of [PLAYER_SPEED, PLAYER_SPEED * SPRINT_MULTIPLIER, PLAYER_SPEED * DASH_MULTIPLIER]) {
      const body = walk(bodyAt(FORTIFICATIONS.gateX, 114), direction, 0, 80, speed)
      assert.ok(body.x > 68.35 && body.x < 75.65)
      assert.equal(body.z, 0)
    }
  }
})

test('house doors face connected streets and leave the defensive perimeter clear', () => {
  const houses = townProps.filter(p => /Courtyard_(Inn|Shop)$/.test(p.kind))
  for (const prop of houses) {
    const frontX = Math.sin(prop.rot)
    const frontY = Math.cos(prop.rot)
    const doorOffset = prop.kind === 'Courtyard_Shop' ? -1.61 * (prop.s3?.[0] ?? prop.scale) : 0
    const doorX = prop.x + Math.cos(prop.rot) * doorOffset
    const doorY = prop.y + frontY * (prop.by! + 0.75)
    const street = TOWN_STREETS.find(s => s.z1 === s.z2
      && doorX > s.x1 && doorX < s.x2
      && (s.z1 - doorY) * frontY > 0 && Math.abs(s.z1 - doorY) < 6)
    assert.ok(street, `house at ${prop.x},${prop.y} faces no street`)
    const approach = bodyAt(doorX, street.z1)
    const distance = Math.abs(street.z1 - doorY)
    for (let i = 0; i < Math.ceil(distance / 0.1); i++) {
      stepBody(plan, approach, -frontX * 0.1, -frontY * 0.1, dt)
    }
    assert.ok(Math.abs(approach.y - doorY) < 0.12, `blocked doorway approach at ${doorX},${doorY}`)
    assert.ok(prop.x - prop.bx! >= 42 && prop.x + prop.bx! <= 102)
    assert.ok(prop.y - prop.by! >= 40 && prop.y + prop.by! <= 105)
  }
  // Stair access stays clear even when surrounding buildings or furniture move.
  for (const x of [40, 104]) {
    for (let z = 90; z <= 105; z += 0.5) {
      for (const prop of townProps.filter(p => /Courtyard_(Inn|Shop|Tree|Bench|Planter|Stall|Lantern)$/.test(p.kind))) {
        const dx = Math.abs(prop.x - x)
        const dz = Math.abs(prop.y - z)
        assert.ok(dx > (prop.bx ?? prop.r) + 1.5 || dz > (prop.by ?? prop.r) + 0.25,
          `${prop.kind} blocks stairs at ${x},${z}`)
      }
    }
  }
})
