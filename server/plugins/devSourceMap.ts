import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'

/**
 * Dev only: give the Nitro beta's error handler the `__dirname` it forgot.
 * Nitro inlines its vendored `source-map` into the ESM dev bundle, and that package's
 * `read-wasm.js` still does `path.join(__dirname, 'mappings.wasm')`.
 * ESM has no `__dirname`, so every rendered error (a 404 is enough) logs
 * "__dirname is not defined" while the handler tries to source-map the stack.
 * Point a global `__dirname` at the real `source-map/lib`: the WASM loads and stacks resolve.
 * Nothing else in the bundle reads `__dirname` — its other users shim their own.
 * Delete once the Nitro dev bundle shims CommonJS globals itself.
 */
export default defineNitroPlugin(() => {
  if (!import.meta.dev || '__dirname' in globalThis) return
  try {
    // nitro's main lives under dist/; the vendored copy sits beside it.
    const main = createRequire(import.meta.url).resolve('nitro')
    const dist = main.slice(0, main.indexOf(`${sep}dist${sep}`) + `${sep}dist`.length)
    const lib = join(dist, 'node_modules', 'source-map', 'lib')
    if (existsSync(join(lib, 'mappings.wasm'))) (globalThis as { __dirname?: string }).__dirname = lib
  }
  catch {
    // Layout changed — leave the beta's handler as it is.
  }
})
