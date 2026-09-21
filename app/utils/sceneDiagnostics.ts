import { Mesh, InstancedMesh } from 'three'
import type { Material, Scene, WebGLRenderer } from 'three'

/** Development-only, whole-frame counters including shadows and nested renders.
 * Exposed on the canvas so browser tools can read a sample without instrumenting
 * WebGL or keeping the scene alive. Call begin before simulation, end after post. */
export function createSceneDiagnostics(scene: Scene) {
  let renderer: WebGLRenderer | undefined
  let previousAutoReset = true
  let started = 0
  let previousFrame = 0
  let published = 0
  const frameTimes: number[] = []
  const cpuTimes: number[] = []
  const calls: number[] = []
  const triangles: number[] = []
  const fountainCaptures: number[] = []
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
      scene.userData.fountainCaptures = 0
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
      fountainCaptures.push(scene.userData.fountainCaptures ?? 0)
      if (now - published < 2000 || frameTimes.length < 10) return
      const materials = new Set<Material>()
      const meshCosts: { name: string, material: string, instances: number, triangles: number, castsShadow: boolean }[] = []
      scene.traverse((object) => {
        const value = (object as { material?: Material | Material[] }).material
        if (value) for (const material of Array.isArray(value) ? value : [value]) materials.add(material)
      })
      scene.traverseVisible((object) => {
        if (!(object instanceof Mesh)) return
        const geometry = object.geometry
        const vertices = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0
        meshCosts.push({
          name: object.name || object.parent?.name || (Array.isArray(object.material) ? object.material[0]?.name : object.material.name) || 'unnamed',
          material: (Array.isArray(object.material) ? object.material.map(material => material.name).join(', ') : object.material.name),
          instances: object instanceof InstancedMesh ? object.count : 1,
          triangles: vertices / 3 * (object instanceof InstancedMesh ? object.count : 1),
          castsShadow: object.castShadow,
        })
      })
      meshCosts.sort((a, b) => b.triangles - a.triangles)
      const elapsed = frameTimes.reduce((sum, time) => sum + time, 0)
      renderer.domElement.dataset.sceneStats = JSON.stringify({
        fps: Math.round(frameTimes.length * 10000 / elapsed) / 10,
        sampleMs: Math.round(elapsed),
        viewport: {
          width: renderer.domElement.clientWidth,
          height: renderer.domElement.clientHeight,
          bufferWidth: renderer.domElement.width,
          bufferHeight: renderer.domElement.height,
        },
        materials: materials.size,
        largestMeshes: meshCosts.slice(0, 8),
        programs: renderer.info.programs?.length ?? null,
        frames: frameTimes.length,
        frameMs: percentile(frameTimes, 0.5),
        frameP95Ms: percentile(frameTimes, 0.95),
        cpuMs: percentile(cpuTimes, 0.5),
        calls: percentile(calls, 0.5),
        triangles: percentile(triangles, 0.5),
        fountainCapturesPerFrame: Math.round(fountainCaptures.reduce((sum, count) => sum + count, 0) / fountainCaptures.length * 100) / 100,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      })
      frameTimes.length = cpuTimes.length = calls.length = triangles.length = fountainCaptures.length = 0
      published = now
    },
    dispose() {
      if (!renderer) return
      renderer.info.autoReset = previousAutoReset
      delete renderer.domElement.dataset.sceneStats
    },
  }
}
