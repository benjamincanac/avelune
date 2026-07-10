import {
  AdditiveBlending, Color, DoubleSide, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PointLight, RingGeometry,
} from 'three'
import type { Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { PALETTE } from './palette'

/**
 * The great door: the monumental dungeon entrance in the colosseum's north wall,
 * replacing the old energy-rift portal. The stone frame + banded leaves are a
 * bespoke GLB (scripts/make_door.py); this drives its glow the same way the
 * portal does — model contract: an emissive material named `Rune` (pulsed) and
 * floating objects named `Shard_*` (bobbed/spun). A slime-blue ground ring +
 * fill light spill the dungeon's glow onto the sand. Same `{root, update}` shape
 * as `Portal`, so the hub render loop drives it unchanged.
 */
export interface BigDoor {
  root: Group
  update: (elapsed: number, dt: number) => void
}

let doorLoader: GLTFLoader | null = null

export function buildBigDoor(): BigDoor {
  const root = new Group()

  const shards: { obj: Object3D, baseY: number }[] = []
  const runeMats: MeshStandardMaterial[] = []
  doorLoader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  doorLoader.loadAsync('/models/colosseum_door.glb').then((gltf) => {
    gltf.scene.traverse((o) => {
      if (o.name.startsWith('Shard_')) shards.push({ obj: o, baseY: o.position.y })
      if (o instanceof Mesh) {
        o.castShadow = o.receiveShadow = true
        const mat = o.material
        if (mat instanceof MeshStandardMaterial && mat.name === 'Rune' && !runeMats.includes(mat)) runeMats.push(mat)
      }
    })
    root.add(gltf.scene)
  })

  // A slime-blue glow ring on the threshold + a fill light spilling onto the sand.
  const ringMat = new MeshBasicMaterial({ color: new Color(PALETTE.slime), transparent: true, opacity: 0.4, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const ring = new Mesh(new RingGeometry(2.1, 3, 56), ringMat)
  ring.rotation.x = -Math.PI / 2
  ring.position.set(0, 0.05, 1.6)
  root.add(ring)

  const glow = new PointLight(new Color(PALETTE.slime), 6, 13)
  glow.position.set(0, 4.5, 1.8)
  root.add(glow)

  function update(elapsed: number, dt: number) {
    const pulse = 0.5 + Math.sin(elapsed * 2) * 0.5
    const flicker = 0.85 + Math.sin(elapsed * 12.7) * 0.1 + Math.sin(elapsed * 26.3) * 0.05
    ringMat.opacity = (0.26 + pulse * 0.3) * flicker
    glow.intensity = (5 + pulse * 5) * flicker

    // Model dressing, once it lands: shards drift + spin, rune inlays breathe.
    shards.forEach((s, i) => {
      s.obj.position.y = s.baseY + Math.sin(elapsed * (0.8 + (i % 4) * 0.22) + i * 1.7) * 0.12
      s.obj.rotation.y += dt * (0.3 + (i % 3) * 0.18)
    })
    const runeGlow = 2.5 + pulse * 2.5
    for (const m of runeMats) m.emissiveIntensity = runeGlow
  }

  return { root, update }
}
