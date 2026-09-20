import assert from 'node:assert/strict'
import { test } from 'vitest'
import { CHUNK_SIZE } from '../shared/utils/world'
import { GRAPHICS_DETAIL } from '../app/utils/graphics'
import { GRASS_FADE_END } from '../app/utils/courtyardLandscape'

/**
 * The meadow has to be gone before the ground it stands on stops being drawn in
 * detail. `MazeScene` mounts grass within `detailRadius` chunks of the player's
 * own chunk, so the nearest ground that carries none is one chunk out; the
 * shader's fade, scaled by `grassRange`, has to have finished by then or the
 * meadow ends in a hard circle that follows the player.
 *
 * Nothing else catches this: both halves look right on their own, and the seam
 * only shows in motion, on the settings a machine that cannot render it well
 * is the one running.
 */
test('every detail level fades its grass out before the detail ring ends', () => {
  for (const [level, detail] of Object.entries(GRAPHICS_DETAIL)) {
    const ring = detail.detailRadius * CHUNK_SIZE
    const fade = GRASS_FADE_END * detail.grassRange
    assert.ok(fade <= ring, `${level}: grass fades out at ${fade} but its detail ring ends at ${ring}`)
  }
})

/** The ring a chunk drops its detail at has to be outside the ring it gains it
 *  at, or a chunk on the boundary rebuilds its props and grass every time the
 *  player steps across a chunk border. */
test('detail is dropped further out than it is granted', () => {
  for (const [level, detail] of Object.entries(GRAPHICS_DETAIL)) {
    assert.ok(detail.detailDrop > detail.detailRadius, `${level}: drops detail at ${detail.detailDrop}, grants it at ${detail.detailRadius}`)
  }
})
