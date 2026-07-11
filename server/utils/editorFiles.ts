import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Locate the repo's `shared/data` directory by walking up from the process cwd
 * (the dev server can run from a subdir). Used by the dev-only editor save route
 * to write the committed JSON layouts. Returns the absolute dir path.
 */
export async function resolveDataDir(): Promise<string> {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'shared', 'data')
    try {
      await access(candidate)
      return candidate
    }
    catch {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error('shared/data not found (walked up from cwd)')
}
