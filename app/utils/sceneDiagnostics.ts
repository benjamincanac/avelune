import type { WebGLRenderer } from 'three'

/** Development-only, whole-frame counters including shadows and nested renders.
 * Exposed on the canvas so browser tools can read a sample without instrumenting
 * WebGL or keeping the scene alive. Call begin before simulation, end after post. */
export function createSceneDiagnostics() {
  let renderer: WebGLRenderer | undefined
  let previousAutoReset = true
  let started = 0
  let previousFrame = 0
  let published = 0
  const frameTimes: number[] = []
  const cpuTimes: number[] = []
  const calls: number[] = []
  const triangles: number[] = []
  function percentile(values: number[], fraction: number) {
    const sorted = [...values].sort((a, b) => a - b)
    return Math.round((sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0) * 100) / 100
  }
  return {
    begin(gl: WebGLRenderer) {
      if (!renderer) {
        renderer = gl
        previousAutoReset = gl.info.autoReset
        gl.info.autoReset = false
      }
      gl.info.reset()
      started = performance.now()
      if (previousFrame) frameTimes.push(started - previousFrame)
      previousFrame = started
    },
    end() {
      if (!renderer || !started) return
      const now = performance.now()
      cpuTimes.push(now - started)
      calls.push(renderer.info.render.calls)
      triangles.push(renderer.info.render.triangles)
      if (now - published < 2000 || frameTimes.length < 10) return
      renderer.domElement.dataset.sceneStats = JSON.stringify({
        frames: frameTimes.length,
        frameMs: percentile(frameTimes, 0.5),
        frameP95Ms: percentile(frameTimes, 0.95),
        cpuMs: percentile(cpuTimes, 0.5),
        calls: percentile(calls, 0.5),
        triangles: percentile(triangles, 0.5),
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      })
      frameTimes.length = cpuTimes.length = calls.length = triangles.length = 0
      published = now
    },
    dispose() {
      if (!renderer) return
      renderer.info.autoReset = previousAutoReset
      delete renderer.domElement.dataset.sceneStats
    },
  }
}
