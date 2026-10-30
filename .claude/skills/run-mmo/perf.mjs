// Frame cost for the driver's MMO_STATS / MMO_DUMP knobs.
//
// fps alone says little here: a headed run is capped at the display's refresh
// rate, and a frame is the scene drawn several times over (three shadow
// cascades, GTAO's normal pass, the fountain's captures, the main pass). So the
// WebGL2 draw calls are counted where they are issued and attributed to the
// framebuffer bound at the time, which reads as one row per pass.
//
// Measure on the real GPU (MMO_HEADED=1): SwiftShader's numbers mean nothing.
// And measure at the resolution people play at (MMO_DPR=2 on a retina Mac) —
// a whole session of draw-call cuts showed nothing there until MSAA went,
// because at that pixel count the frame was bound by pixels, not by calls.

/** Must run before the page loads: it wraps the context's prototype. */
export async function installGpuCounters(page) {
  await page.addInitScript(() => {
    const G = window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype
    if (!G) return
    const gpu = window.__gpu = { calls: 0, tris: 0, frames: [], passes: [], lastPasses: [], targets: 0 }
    let pass = null
    const open = (label) => {
      if (pass && pass.calls) gpu.passes.push(pass)
      pass = { label, size: null, calls: 0, tris: 0 }
    }
    open('screen')
    const bindFramebuffer = G.bindFramebuffer
    G.bindFramebuffer = function (target, fb) {
      if (target === this.FRAMEBUFFER) open(fb ? `fb:${fb.__id ??= ++gpu.targets}` : 'screen')
      return bindFramebuffer.apply(this, arguments)
    }
    const viewport = G.viewport
    G.viewport = function (x, y, w, h) {
      if (pass) pass.size = `${w}x${h}`
      return viewport.apply(this, arguments)
    }
    const count = (vertices, instances) => {
      const tris = vertices / 3 * (instances || 1)
      gpu.calls++
      gpu.tris += tris
      pass.calls++
      pass.tris += tris
    }
    // (mode, count, type, offset, instances) and (mode, first, count, instances).
    for (const name of ['drawElements', 'drawElementsInstanced']) {
      const draw = G[name]
      G[name] = function (...args) { count(args[1], args[4]); return draw.apply(this, args) }
    }
    for (const name of ['drawArrays', 'drawArraysInstanced']) {
      const draw = G[name]
      G[name] = function (...args) { count(args[2], args[3]); return draw.apply(this, args) }
    }
    const frame = () => {
      open('screen')
      // Only kept while `measure` is reading, so a long session stays flat.
      if (gpu.recording) gpu.frames.push([gpu.calls, Math.round(gpu.tris)])
      gpu.lastPasses = gpu.passes
      gpu.passes = []
      gpu.calls = 0
      gpu.tris = 0
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}

/** fps, and draw calls and triangles per frame averaged over the window. The
 *  passes are the last frame's, so a rate-limited one (the fountain's captures)
 *  can be missing from the rows and still be in the averages. */
export async function measure(page, ms = 4000) {
  return page.evaluate(ms => new Promise((resolve) => {
    const start = performance.now()
    if (window.__gpu) {
      window.__gpu.frames = []
      window.__gpu.recording = true
    }
    let frames = 0
    const tick = () => {
      frames++
      if (performance.now() - start < ms) return requestAnimationFrame(tick)
      const seen = window.__gpu?.frames ?? []
      if (window.__gpu) window.__gpu.recording = false
      const mean = i => seen.length ? Math.round(seen.reduce((sum, f) => sum + f[i], 0) / seen.length) : null
      const canvas = document.querySelector('canvas')
      resolve({
        fps: Math.round(frames / ((performance.now() - start) / 1000)),
        calls: mean(0),
        tris: mean(1),
        dpr: window.devicePixelRatio,
        canvas: canvas ? [canvas.width, canvas.height] : null,
        passes: (window.__gpu?.lastPasses ?? []).filter(p => p.calls > 2).map(p => ({ ...p, tris: Math.round(p.tris) })),
      })
    }
    requestAnimationFrame(tick)
  }), ms)
}

/** What the scene is made of: triangles by named group, what casts, and the
 *  heaviest single meshes. This is what found 5163 paving slabs at 300 triangles
 *  each casting into every cascade. Needs the dev hook (`window.__maze.scene`),
 *  so a dev server, not a prod build. */
export async function dumpTriangles(page) {
  return page.evaluate(() => {
    const scene = window.__maze?.scene?.value
    if (!scene) return { error: 'window.__maze.scene is missing: dev server only' }
    const rows = []
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return
      for (let p = o.parent; p; p = p.parent) if (!p.visible) return
      const g = o.geometry
      const per = (g?.index?.count ?? g?.attributes?.position?.count ?? 0) / 3
      const n = o.isInstancedMesh ? o.count : 1
      const chain = []
      for (let p = o; p && chain.length < 4; p = p.parent) if (p.name) chain.push(p.name.replace(/[-\d,. ]+$/, ''))
      rows.push({ name: (chain.reverse().join(' > ') || o.type).slice(0, 70), tris: Math.round(per * n), per: Math.round(per), n, cast: !!o.castShadow })
    })
    const groups = new Map()
    for (const r of rows) {
      const g = groups.get(r.name) ?? { name: r.name, tris: 0, meshes: 0, casting: 0 }
      g.tris += r.tris
      g.meshes++
      if (r.cast) g.casting += r.tris
      groups.set(r.name, g)
    }
    return {
      total: rows.reduce((sum, r) => sum + r.tris, 0),
      casting: rows.filter(r => r.cast).reduce((sum, r) => sum + r.tris, 0),
      meshes: rows.length,
      groups: [...groups.values()].sort((a, b) => b.tris - a.tris).slice(0, 16),
      top: rows.sort((a, b) => b.tris - a.tris).slice(0, 12),
    }
  })
}

export function printStats(stats) {
  console.log(`STATS  ${stats.fps} fps · ${stats.calls} calls · ${stats.tris} tris per frame · dpr ${stats.dpr} · canvas ${stats.canvas?.join('x')}`)
  for (const p of stats.passes) console.log(`  PASS ${p.label.padEnd(7)} ${(p.size ?? '?').padEnd(10)} ${String(p.calls).padStart(5)} calls ${String(p.tris).padStart(9)} tris`)
}

export function printDump(dump) {
  if (dump.error) return console.log('DUMP  ', dump.error)
  console.log(`DUMP   ${dump.total} tris in ${dump.meshes} meshes, ${dump.casting} of them casting`)
  for (const g of dump.groups) console.log(`  GROUP ${String(g.tris).padStart(9)} tris ${String(g.meshes).padStart(4)} meshes ${String(g.casting).padStart(9)} casting  ${g.name}`)
  for (const r of dump.top) console.log(`  MESH  ${String(r.tris).padStart(9)} = ${String(r.per).padStart(6)} x ${String(r.n).padEnd(5)} ${r.cast ? 'casts' : '     '}  ${r.name}`)
}
