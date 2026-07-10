import {
  AdditiveBlending, CircleGeometry, Color, ConeGeometry, DoubleSide, Group, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PointLight, RingGeometry, SphereGeometry,
  TorusGeometry,
} from 'three'
import type { Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { PALETTE } from './palette'
import { makePortalTexture } from './textures'

/**
 * The great door: the monumental dungeon entrance in the colosseum's north wall.
 * A bespoke rune-inscribed stone arch (scripts/make_door.py) framing a swirling
 * blue portal — the way down. The stone (GLB) contributes the frame + `Rune`
 * glow + floating `Shard_*` glyphs; this adds the swirling rift filling the
 * opening, a slime-blue threshold glow, and two blue braziers flanking it. Same
 * `{root, update}` shape as `Portal`, so the hub render loop drives it unchanged.
 */
export interface BigDoor {
  root: Group
  update: (elapsed: number, dt: number) => void
}

let doorLoader: GLTFLoader | null = null

/** Opening centre (local): X 0, Y up the arch, Z out toward the arena (+Z front). */
const OPEN_Y = 4.6
const OPEN_Z = 0.5
const RIFT_R = 2.35

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

  // --- The swirling portal filling the archway (front face, toward the arena). ---
  const rift = new Group()
  rift.position.set(0, OPEN_Y, OPEN_Z)
  root.add(rift)

  const swirlTex = makePortalTexture(4242)
  // Dark well behind the swirl for contrast.
  const well = new Mesh(
    new CircleGeometry(RIFT_R * 0.98, 48),
    new MeshBasicMaterial({ color: new Color('#050a1a'), transparent: true, opacity: 0.9, depthWrite: false }),
  )
  well.position.z = -0.12
  rift.add(well)
  // Two counter-spun swirl discs (parallax) + a receding tunnel cone.
  const tunnelMat = new MeshBasicMaterial({ map: swirlTex, color: new Color(PALETTE.deep), transparent: true, opacity: 0.55, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const tunnelGeo = new ConeGeometry(RIFT_R * 1.02, 2.4, 48, 1, true)
  tunnelGeo.rotateX(-Math.PI / 2)
  const tunnel = new Mesh(tunnelGeo, tunnelMat)
  tunnel.position.z = -1.2
  rift.add(tunnel)
  const swirlBackMat = new MeshBasicMaterial({ map: swirlTex, color: new Color(PALETTE.deep), transparent: true, opacity: 0.6, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const swirlBack = new Mesh(new CircleGeometry(RIFT_R * 0.8, 48), swirlBackMat)
  swirlBack.position.z = -0.3
  rift.add(swirlBack)
  const swirlFrontMat = new MeshBasicMaterial({ map: swirlTex, color: new Color(PALETTE.slime), transparent: true, opacity: 0.6, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const swirlFront = new Mesh(new CircleGeometry(RIFT_R, 48), swirlFrontMat)
  rift.add(swirlFront)
  // Hot core + bright rim.
  const coreMat = new MeshBasicMaterial({ color: new Color(PALETTE.light), transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })
  const core = new Mesh(new SphereGeometry(RIFT_R * 0.2, 20, 20), coreMat)
  core.position.z = -0.4
  rift.add(core)
  const rimMat = new MeshBasicMaterial({ color: new Color(PALETTE.light), transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })
  const rim = new Mesh(new TorusGeometry(RIFT_R, 0.08, 14, 64), rimMat)
  rim.position.z = 0.05
  rift.add(rim)

  // --- Threshold glow ring on the sand + a fill light. ---
  const ringMat = new MeshBasicMaterial({ color: new Color(PALETTE.slime), transparent: true, opacity: 0.4, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const ring = new Mesh(new RingGeometry(2.1, 3, 56), ringMat)
  ring.rotation.x = -Math.PI / 2
  ring.position.set(0, 0.05, 1.8)
  root.add(ring)

  const glow = new PointLight(new Color(PALETTE.slime), 7, 16)
  glow.position.set(0, OPEN_Y, 1.6)
  root.add(glow)

  // --- Two blue braziers flanking the door. ---
  const braziers: { flameMat: MeshBasicMaterial, light: PointLight, flame: Mesh }[] = []
  for (const sx of [-4.2, 4.2]) {
    const stand = new Mesh(
      new ConeGeometry(0.32, 1.4, 8),
      new MeshStandardMaterial({ color: new Color('#2b3038'), roughness: 1 }),
    )
    stand.position.set(sx, 0.7, 1.4)
    root.add(stand)
    const flameMat = new MeshBasicMaterial({ color: new Color(PALETTE.slime), transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })
    const flame = new Mesh(new ConeGeometry(0.34, 1.1, 10), flameMat)
    flame.position.set(sx, 1.75, 1.4)
    root.add(flame)
    const light = new PointLight(new Color(PALETTE.slime), 4, 8)
    light.position.set(sx, 2, 1.4)
    root.add(light)
    braziers.push({ flameMat, light, flame })
  }

  function update(elapsed: number, dt: number) {
    const pulse = 0.5 + Math.sin(elapsed * 2) * 0.5
    const flicker = 0.85 + Math.sin(elapsed * 12.7) * 0.1 + Math.sin(elapsed * 26.3) * 0.05

    // Swirl churns; core breathes; rim pulses.
    tunnel.rotation.z = elapsed * 0.18
    swirlBack.rotation.z = -elapsed * 0.22
    swirlFront.rotation.z = elapsed * 0.32
    swirlFrontMat.opacity = (0.45 + pulse * 0.3) * flicker
    coreMat.opacity = (0.7 + pulse * 0.3) * flicker
    core.scale.setScalar(1 + pulse * 0.18)
    rimMat.opacity = (0.7 + pulse * 0.3) * flicker
    ringMat.opacity = (0.26 + pulse * 0.3) * flicker
    glow.intensity = (5 + pulse * 6) * flicker

    // Braziers flicker independently.
    braziers.forEach((b, i) => {
      const f = 0.75 + Math.sin(elapsed * (9 + i * 3.3) + i) * 0.18 + Math.sin(elapsed * 19.7) * 0.07
      b.flameMat.opacity = 0.7 * f
      b.flame.scale.set(1, 0.9 + f * 0.3, 1)
      b.light.intensity = 4 * f
    })

    // Stone dressing (once the model lands): shards drift + spin, runes breathe.
    shards.forEach((s, i) => {
      s.obj.position.y = s.baseY + Math.sin(elapsed * (0.8 + (i % 4) * 0.22) + i * 1.7) * 0.12
      s.obj.rotation.y += dt * (0.3 + (i % 3) * 0.18)
    })
    const runeGlow = 2.5 + pulse * 2.5
    for (const m of runeMats) m.emissiveIntensity = runeGlow
  }

  return { root, update }
}
