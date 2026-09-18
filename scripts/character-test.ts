import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import {
  BEARD_MESH, CHARACTER_NAMES, DEFAULT_CHARACTER, GENDERS,
  HAIRSTYLES, OUTFITS, OUTFIT_COLORS, canBeard, characterName, genderOf, isBearded, isCharacter,
  outfitColorTexture, randomAppearance,
} from '../shared/utils/characters'

test('downloaded roster is restored and every creator combination resolves to a real entry', () => {
  assert.equal(DEFAULT_CHARACTER, 'Peasant_Male_SimpleParted')
  assert.equal(CHARACTER_NAMES.length, 18)
  assert.equal(new Set(CHARACTER_NAMES).size, CHARACTER_NAMES.length)
  for (const outfit of OUTFITS) {
    for (const gender of GENDERS) {
      for (const hair of HAIRSTYLES[gender]) {
        const name = characterName(outfit.id, gender, hair.id)
        assert.ok(isCharacter(name))
      }
    }
  }
})

/**
 * The roster names files the pipeline has to have produced. A missing GLB or
 * colorway PNG fails at runtime as a blank character or an untextured outfit,
 * with nothing in typecheck or lint to catch it, so adding an outfit to the
 * roster without converting it is caught here instead.
 */
test('every roster entry and colorway has a file under public/models/characters', () => {
  const dir = fileURLToPath(new URL('../public/models/characters/', import.meta.url))
  const missing: string[] = []

  for (const name of CHARACTER_NAMES) {
    if (!existsSync(`${dir}${name}.glb`)) missing.push(`${name}.glb`)
  }
  for (const outfit of OUTFITS) {
    const colorways = OUTFIT_COLORS[outfit.id]
    assert.ok(colorways?.length, `no colorways registered for ${outfit.id}`)
    colorways.forEach((_, i) => {
      const url = outfitColorTexture(outfit.id, i)
      if (url && !existsSync(`${dir}${url.split('/characters/')[1]}`)) missing.push(url)
    })
  }

  assert.deepEqual(missing, [])
})

/**
 * The beard is offered to males whose outfit leaves the face open. Females have
 * no beard mesh at all, and the Knight's closed armet ships without hair or
 * beard, so both must normalise to false however a client asks.
 */
test('only a male on a non-hairless outfit can wear a beard', () => {
  for (const outfit of OUTFITS) {
    assert.equal(canBeard(outfit.id, 'Male'), !outfit.hairless, outfit.id)
    assert.equal(canBeard(outfit.id, 'Female'), false, outfit.id)
  }

  assert.equal(isBearded('Peasant_Male_SimpleParted', true), true)
  assert.equal(isBearded('Peasant_Male_Buzzed', true), true)
  assert.equal(isBearded('Peasant_Female_Long', true), false)
  assert.equal(isBearded('Knight_Male', true), false)
  // A missing field reads as clean shaven, and nothing but `true` turns it on.
  assert.equal(isBearded('Peasant_Male_Buzzed', undefined), false)
  assert.equal(isBearded('Peasant_Male_Buzzed', 'yes'), false)
  assert.equal(isBearded('Peasant_Male_Buzzed', 1), false)

  for (const name of CHARACTER_NAMES) {
    assert.equal(genderOf(name), name.split('_')[1], name)
  }

  for (let i = 0; i < 200; i++) {
    const a = randomAppearance()
    assert.equal(typeof a.beard, 'boolean')
    if (a.beard) assert.ok(canBeard(a.outfit, a.gender), `${a.outfit} ${a.gender}`)
  }
})

/** Read a GLB's JSON chunk without a glTF parser: a 12-byte header, then the
 *  first chunk, which the spec requires to be the JSON one. */
function glbNodeNames(file: string): string[] {
  const buf = readFileSync(file)
  const length = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + length).toString('utf8')) as { nodes?: { name?: string }[] }
  return (json.nodes ?? []).map(node => node.name ?? '')
}

/**
 * The beard only works as a runtime toggle if the pipeline actually shipped it
 * as its own node under a stable name. Nothing in typecheck or lint notices a
 * rebuild that joined it into the hair or dropped it from a `Buzzed` build, so
 * the shipped files are read here instead.
 */
test('every male GLB that can wear a beard carries the beard node, and no other does', () => {
  const dir = fileURLToPath(new URL('../public/models/characters/', import.meta.url))
  const withBeard: string[] = []
  const without: string[] = []

  for (const name of CHARACTER_NAMES) {
    const file = `${dir}${name}.glb`
    if (!existsSync(file)) continue
    const has = glbNodeNames(file).some(node => node.startsWith(BEARD_MESH))
    ;(has ? withBeard : without).push(name)
  }

  const expected = CHARACTER_NAMES.filter(name => canBeard(name.split('_')[0]!, genderOf(name)))
  assert.deepEqual(withBeard.sort(), [...expected].sort())
  assert.ok(without.every(name => genderOf(name) === 'Female' || name.startsWith('Knight')), without.join(', '))
})
