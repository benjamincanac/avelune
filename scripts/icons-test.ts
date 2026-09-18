// Run with: pnpm test (vitest), or pnpm exec vitest run scripts/icons-test.ts
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import lucide from '@iconify-json/lucide/icons.json' with { type: 'json' }
import simple from '@iconify-json/simple-icons/icons.json' with { type: 'json' }

/**
 * Every icon the UI names has to exist in the bundled set.
 *
 * A missing one fails silently — `UIcon` renders an empty box, no warning, no
 * error — so `i-lucide-stairs` sat on the hotbar's seventh slot as a blank
 * square. Nothing else catches that: it is a string, so typecheck and lint both
 * pass, and `icon.serverBundle: 'remote'` means even the build never resolves
 * it. This walks the source for `i-lucide-*` / `i-simple-icons-*` literals and
 * checks each against the installed JSON.
 */
const SETS: Record<string, { icons: Record<string, unknown>, aliases?: Record<string, unknown> }> = {
  'lucide': lucide as never,
  'simple-icons': simple as never,
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(vue|ts)$/.test(entry)) out.push(path)
  }
  return out
}

test('every icon named in app/ exists in the bundled set', () => {
  const root = fileURLToPath(new URL('../app', import.meta.url))
  const missing: string[] = []
  let checked = 0

  for (const file of sources(root)) {
    const src = readFileSync(file, 'utf8')
    for (const match of src.matchAll(/i-(lucide|simple-icons)-((?:[a-z0-9]+-)*[a-z0-9]+)(?=['"`\s])/g)) {
      const [full, set, name] = match as unknown as [string, string, string]
      const bundle = SETS[set]!
      checked++
      if (!bundle.icons[name] && !bundle.aliases?.[name]) missing.push(`${full} (${file.slice(root.length + 1)})`)
    }
  }

  assert.ok(checked > 20, `expected to find icon literals, found ${checked}`)
  assert.deepEqual([...new Set(missing)], [], 'icons named in the UI that the bundled set does not have')
})
