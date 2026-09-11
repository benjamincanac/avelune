import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHARACTER_NAMES, DEFAULT_CHARACTER, GENDERS,
  HAIRSTYLES, OUTFITS, characterName, isCharacter,
} from '../shared/utils/characters'

test('downloaded roster is restored and every creator combination resolves to a real entry', () => {
  assert.equal(DEFAULT_CHARACTER, 'Peasant_Male_SimpleParted')
  assert.equal(CHARACTER_NAMES.length, 8)
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
