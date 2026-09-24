/**
 * The crosshair against real pieces: `createBuildTools` driven by a posed
 * camera, with no renderer, and its target resolved by the same shared rules
 * the server runs. What `building-test.ts` cannot see is what the ray meets
 * and which height it reports, and that is where a wall over a door was lost.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { PerspectiveCamera, Scene, Vector3 } from 'three'
import type { Group } from 'three'
import { ROOF_MISMATCH, resolveBuild } from '../shared/utils/building'
import { KIT_ASSETS } from '../shared/utils/kit'
import { CHUNK_SIZE, applyPlace, applyRemove, createWorld } from '../shared/utils/world'
import type { World } from '../shared/utils/world'
import { createBuildTools } from '../app/utils/buildTools'
import type { UseBuild } from '../app/composables/useBuild'

function levelChunk(world: World, cx: number, cy: number) {
  const chunk = world.getChunk(cx, cy)!
  chunk.heights.fill(0)
  chunk.version++
  return { x: cx * CHUNK_SIZE + 16, y: cy * CHUNK_SIZE + 16 }
}

function put(world: World, id: string, kind: string, x: number, y: number, rot: number, z: number) {
  applyPlace(world, { id, kind, x, y, rot, scale: 1, z, owner: 'builder' })
}

/** Aim a wall from `eye` at `look` and resolve the target the way the server
 *  would receive it. */
function aimWall(world: World, eye: Vector3, look: Vector3, actor: { x: number, y: number }) {
  return aim(world, 'Kit_Wall', eye, look, actor)
}

function aim(world: World, kind: string, eye: Vector3, look: Vector3, actor: { x: number, y: number }) {
  const camera = new PerspectiveCamera(62, 1.6, 0.05, 260)
  camera.position.copy(eye)
  camera.lookAt(look)
  camera.updateMatrixWorld()
  // The tools only read and write `.value`, so plain boxes stand in for refs.
  const ref = <T>(value: T) => ({ value })
  const build = {
    active: ref({ id: kind, kind, label: kind, icon: '' }),
    rot: ref(0),
    pieces: ref(0),
    deeds: ref(0),
    targetOk: ref(false),
    targetHint: ref(''),
    size: ref(2),
    surface: ref(0),
  } as unknown as UseBuild
  const tools = createBuildTools({ scene: new Scene(), world, templates: new Map<string, Group>(), getCamera: () => camera, build })
  const target = tools.update(actor, 'builder')
  tools.dispose()
  assert.ok(target, 'no target under the crosshair')
  return resolveBuild(world, { kind, x: target.rawX, y: target.rawY, rot: target.rot ?? 0, h: target.h }, actor, { owner: 'builder', id: 'aimed', pieces: 0 })
}

for (const kind of ['Kit_WallDoor', 'Kit_WallWindow']) {
  test(`a wall aimed at a ${kind === 'Kit_WallDoor' ? 'door' : 'window'} stacks on it`, () => {
    const world = createWorld()
    const { x: gx, y: gy } = levelChunk(world, 16, 10)
    const height = KIT_ASSETS[kind as keyof typeof KIT_ASSETS].height
    put(world, 'panel', kind, gx, gy - 1, 0, 0)
    const actor = { x: gx, y: gy + 1 }

    // From above, onto the top of the panel.
    const top = aimWall(world, new Vector3(gx, height + 1.6, gy + 1.5), new Vector3(gx, height - 0.02, gy - 1), actor)
    assert.ok(top.ok, `aimed at the top: ${top.ok === false && top.reason}`)
    assert.equal(top.placement.z, height)
    assert.equal(top.placement.y, gy - 1)

    // Level with it, onto the upper part of its face.
    const face = aimWall(world, new Vector3(gx + 0.2, 2.1, gy + 3), new Vector3(gx + 0.2, 2.1, gy - 1), actor)
    assert.ok(face.ok, `aimed at the face: ${face.ok === false && face.reason}`)
    assert.equal(face.placement.z, height)
    assert.equal(face.placement.y, gy - 1)
  })
}

/** A run of roof slabs at `level` with the cell at (x, y) missing from it, and a
 *  deck under the hole: the house in the screenshot that could not be closed. */
function roofWithHole(world: World, x: number, y: number, level: number) {
  put(world, 'roof-w', 'Kit_Roof', x - 2, y, 0, level)
  put(world, 'roof-e', 'Kit_Roof', x + 2, y, 0, level)
  put(world, 'deck', 'Kit_Floor', x, y, 0, 2.5)
}

test('looking down into a hole in a roof aims at the hole, not the deck under it', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 16, 10)
  roofWithHole(world, gx, gy, 5)
  const actor = { x: gx + 2, y: gy + 2 }
  const into = aim(world, 'Kit_Roof', new Vector3(gx + 1.2, 8, gy + 1.2), new Vector3(gx + 0.2, 2.7, gy + 0.2), actor)
  assert.ok(into.ok, `roof into the hole refused: ${into.ok === false && into.reason}`)
  assert.deepEqual([into.placement.x, into.placement.y, into.placement.z], [gx, gy, 5])
})

test('looking up through a hole in a roof aims at the hole', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 16, 10)
  roofWithHole(world, gx, gy, 5)
  applyRemove(world, 'deck')
  const actor = { x: gx + 1, y: gy + 1 }
  const up = aim(world, 'Kit_Roof', new Vector3(gx + 1, 1.8, gy + 1), new Vector3(gx, 7, gy), actor)
  assert.ok(up.ok, `roof into the hole refused: ${up.ok === false && up.reason}`)
  assert.deepEqual([up.placement.x, up.placement.y, up.placement.z], [gx, gy, 5])
})

test('a ground floor beside a raised deck is not taken for a gap', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 16, 10)
  put(world, 'deck', 'Kit_Floor', gx, gy, 0, 2.5)
  const actor = { x: gx + 2, y: gy + 1 }
  const low = aim(world, 'Kit_Floor', new Vector3(gx + 2, 3.1, gy + 2.5), new Vector3(gx + 2, 0, gy - 0.5), actor)
  assert.ok(low.ok, `ground floor refused: ${low.ok === false && low.reason}`)
  assert.deepEqual([low.placement.x, low.placement.y, low.placement.z], [gx + 2, gy, 0])
})

test('a roof turned the wrong way for the gap stays in it, refused', () => {
  const world = createWorld()
  const { x: gx, y: gy } = levelChunk(world, 16, 10)
  roofWithHole(world, gx, gy, 5)
  // A wall under the gap holds a roof at the run's level whichever way it faces.
  put(world, 'wall-n', 'Kit_Wall', gx, gy - 1, 0, 2.5)
  const actor = { x: gx + 2, y: gy + 2 }
  const camera = new PerspectiveCamera(62, 1.6, 0.05, 260)
  camera.position.set(gx + 1.2, 8, gy + 1.2)
  camera.lookAt(new Vector3(gx + 0.2, 2.7, gy + 0.2))
  camera.updateMatrixWorld()
  const ref = <T>(value: T) => ({ value })
  const build = {
    active: ref({ id: 'Kit_Roof', kind: 'Kit_Roof', label: 'Roof', icon: '' }),
    rot: ref(Math.PI / 2),
    pieces: ref(0),
    deeds: ref(0),
    targetOk: ref(true),
    targetHint: ref(''),
    size: ref(2),
    surface: ref(0),
  } as unknown as UseBuild
  const tools = createBuildTools({ scene: new Scene(), world, templates: new Map<string, Group>(), getCamera: () => camera, build })
  const target = tools.update(actor, 'builder')
  tools.dispose()
  assert.ok(target)
  assert.deepEqual([target.x, target.y, target.ok], [gx, gy, false])
  assert.equal(target.hint, ROOF_MISMATCH)
})
