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
import { resolveBuild } from '../shared/utils/building'
import { KIT_ASSETS } from '../shared/utils/kit'
import { CHUNK_SIZE, applyPlace, createWorld } from '../shared/utils/world'
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
  const camera = new PerspectiveCamera(62, 1.6, 0.05, 260)
  camera.position.copy(eye)
  camera.lookAt(look)
  camera.updateMatrixWorld()
  // The tools only read and write `.value`, so plain boxes stand in for refs.
  const ref = <T>(value: T) => ({ value })
  const build = {
    active: ref({ id: 'Kit_Wall', kind: 'Kit_Wall', label: 'Wall', icon: '' }),
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
  return resolveBuild(world, { kind: 'Kit_Wall', x: target.rawX, y: target.rawY, rot: target.rot ?? 0, h: target.h }, actor, { owner: 'builder', id: 'aimed', pieces: 0 })
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
