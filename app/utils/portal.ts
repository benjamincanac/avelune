import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CircleGeometry, Color, ConeGeometry,
  DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, PointLight,
  Points, PointsMaterial, RingGeometry, SphereGeometry, TorusGeometry,
} from 'three'
import type { Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { makePortalTexture, makeRuneCircleTexture } from './textures'

/**
 * The hub's teleport gate, built once and shared by the in-world hub
 * (MazeScene) and the main-menu hero (MenuPortal) so the two never drift.
 *
 * A ruined stone rune-gate (modeled by scripts/make_portal.py) frames a
 * Solo-Leveling-style energy rift with genuine depth: a receding cone whose
 * inner wall carries the swirl (the tunnel), swirl discs stacked at different Z
 * so they parallax, a bright pulsing core deep inside, a glowing rim at the
 * mouth, two counter-spinning rune circles over the dais, and motes drawn up
 * into it. The caller positions `root`; `update(elapsed, dt)` drives every
 * moving part from whatever render loop owns it.
 */

/** Gate centre height and rift radius (world units), matched to the hub scale. */
const CENTER_Y = 1.75
const RADIUS = 1.7
const DEEP = '#2f6bff'
const BRIGHT = '#7fd0ff'
const RIM = '#d6f0ff'
const HOT = '#eaf6ff'

export interface Portal {
  /** Position/parent this; everything (gate, runes, motes, light) hangs off it. */
  root: Group
  /** Advance the swirl, rune spin, core pulse and motes. Call every frame. */
  update: (elapsed: number, dt: number) => void
}

let gateLoader: GLTFLoader | null = null

export function buildPortal({ light = true }: { light?: boolean } = {}): Portal {
  const root = new Group()

  // The stone structure: a broken rune ring on a stepped dais with twin
  // obelisks, loaded async so the energy effect carries the first frames alone.
  // Model contract (scripts/make_portal.py): objects named "Shard_*" float
  // freely (bobbed/spun below) and material "Rune" is emissive (pulsed below).
  const shards: { obj: Object3D, baseY: number }[] = []
  const runeMats: MeshStandardMaterial[] = []
  gateLoader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  gateLoader.loadAsync('/models/portal_gate.glb').then((gltf) => {
    gltf.scene.traverse((o) => {
      if (o.name.startsWith('Shard_')) shards.push({ obj: o, baseY: o.position.y })
      if (o instanceof Mesh) {
        // The floor builder's shadow pass has already run by the time the gate
        // lands, so tag its opaque meshes here.
        o.castShadow = o.receiveShadow = true
        const mat = o.material
        if (mat instanceof MeshStandardMaterial && mat.name === 'Rune' && !runeMats.includes(mat)) runeMats.push(mat)
      }
    })
    root.add(gltf.scene)
  })

  // The vertical rift; +Z is toward the viewer, depth recedes into -Z.
  const gate = new Group()
  gate.position.y = CENTER_Y
  root.add(gate)

  // Soft halo bloom set well back — atmosphere bleeding out around the rift.
  const haloMat = new MeshBasicMaterial({ color: new Color(DEEP), transparent: true, opacity: 0.4, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const halo = new Mesh(new RingGeometry(RADIUS, RADIUS + 0.7, 96), haloMat)
  halo.position.z = -1.05
  gate.add(halo)

  // Dark rift wall deep in the tunnel — contrast for the hot core in front of it.
  const core = new Mesh(
    new CircleGeometry(RADIUS * 0.98, 64),
    new MeshBasicMaterial({ color: '#040f26', transparent: true, opacity: 0.85, depthWrite: false }),
  )
  core.position.z = -1.85
  gate.add(core)

  const swirlTex = makePortalTexture(4242)

  // The depth cue: a cone open at the mouth (camera side) narrowing to an apex
  // deep in -Z, its inner wall carrying the swirl. Its UVs run mouth→apex, so
  // the texture reads as streaks converging into the distance; spinning it about
  // its axis makes the tunnel walls swirl. DoubleSide so it holds up from any
  // in-world angle, not just head-on.
  const tunnelGeo = new ConeGeometry(RADIUS * 1.04, 2.1, 64, 1, true)
  tunnelGeo.rotateX(-Math.PI / 2) // cone axis Y → Z; apex to -Z, mouth to +Z
  const tunnelMat = new MeshBasicMaterial({ map: swirlTex, color: new Color(DEEP), transparent: true, opacity: 0.6, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const tunnel = new Mesh(tunnelGeo, tunnelMat)
  tunnel.position.z = -0.9
  gate.add(tunnel)

  // Swirl discs at receding depths → a spiral funnel with real parallax.
  const swirlBackMat = new MeshBasicMaterial({ map: swirlTex, color: new Color(DEEP), transparent: true, opacity: 0.6, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const swirlBack = new Mesh(new CircleGeometry(RADIUS * 0.68, 64), swirlBackMat)
  swirlBack.position.z = -1.15
  gate.add(swirlBack)
  const swirlMidMat = new MeshBasicMaterial({ map: swirlTex, color: new Color(BRIGHT), transparent: true, opacity: 0.7, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const swirlMid = new Mesh(new CircleGeometry(RADIUS * 0.86, 64), swirlMidMat)
  swirlMid.position.z = -0.55
  gate.add(swirlMid)
  const swirlFrontMat = new MeshBasicMaterial({ map: swirlTex, color: new Color(BRIGHT), transparent: true, opacity: 0.5, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const swirlFront = new Mesh(new CircleGeometry(RADIUS, 64), swirlFrontMat)
  swirlFront.position.z = 0
  gate.add(swirlFront)

  // Bright hot core deep inside: an additive bloom disc + a small solid highlight.
  const coreGlowMat = new MeshBasicMaterial({ color: new Color(HOT), transparent: true, opacity: 0.9, blending: AdditiveBlending, side: DoubleSide, depthWrite: false })
  const coreGlow = new Mesh(new CircleGeometry(RADIUS * 0.52, 48), coreGlowMat)
  coreGlow.position.z = -1.3
  gate.add(coreGlow)
  const hot = new Mesh(
    new SphereGeometry(RADIUS * 0.16, 24, 24),
    new MeshBasicMaterial({ color: new Color('#ffffff'), transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false }),
  )
  hot.position.z = -1.42
  gate.add(hot)

  // Bright glowing rim at the mouth.
  const rimMat = new MeshBasicMaterial({ color: new Color(RIM), transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false })
  const rim = new Mesh(new TorusGeometry(RADIUS, 0.06, 16, 96), rimMat)
  rim.position.z = 0.06
  gate.add(rim)

  // Two rune circles spinning flat over the dais at the gate's foot (the
  // dais top sits at 0.18, so they hover just above the stone).
  const runeTex = makeRuneCircleTexture(77)
  const runeOuter = new Group()
  runeOuter.position.y = 0.21
  const runeOuterMesh = new Mesh(
    new PlaneGeometry(5.6, 5.6),
    new MeshBasicMaterial({ map: runeTex, color: new Color(BRIGHT), transparent: true, opacity: 0.5, blending: AdditiveBlending, side: DoubleSide, depthWrite: false }),
  )
  runeOuterMesh.rotation.x = -Math.PI / 2
  runeOuter.add(runeOuterMesh)
  root.add(runeOuter)

  const runeInner = new Group()
  runeInner.position.y = 0.24
  const runeInnerMesh = new Mesh(
    new PlaneGeometry(3.4, 3.4),
    new MeshBasicMaterial({ map: runeTex, color: new Color(RIM), transparent: true, opacity: 0.6, blending: AdditiveBlending, side: DoubleSide, depthWrite: false }),
  )
  runeInnerMesh.rotation.x = -Math.PI / 2
  runeInner.add(runeInnerMesh)
  root.add(runeInner)

  // Motes: embers circling the gate, drifting inward and rising into it. Local
  // to `root`, so they recycle to the origin ring wherever the portal sits.
  const MOTES = 90
  const TOP = CENTER_Y * 2
  const moteGeo = new BufferGeometry()
  const motePos = new Float32Array(MOTES * 3)
  for (let i = 0; i < MOTES; i++) {
    const a = Math.random() * Math.PI * 2
    const r = 0.5 + Math.random() * 2
    motePos[i * 3] = Math.cos(a) * r
    motePos[i * 3 + 1] = Math.random() * TOP
    motePos[i * 3 + 2] = Math.sin(a) * r * 0.35
  }
  moteGeo.setAttribute('position', new BufferAttribute(motePos, 3))
  const motes = new Points(moteGeo, new PointsMaterial({ color: new Color(BRIGHT), size: 0.09, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false }))
  root.add(motes)

  // A point light so the rift throws colour onto the surrounding scene (in-world
  // only — the menu's unlit stage doesn't need it).
  let glow: PointLight | null = null
  if (light) {
    glow = new PointLight(new Color(BRIGHT), 8, 13)
    glow.position.set(0, CENTER_Y, 0.5)
    root.add(glow)
  }

  function update(elapsed: number, dt: number) {
    const pulse = 0.5 + Math.sin(elapsed * 2) * 0.5
    const flicker = 0.85 + Math.sin(elapsed * 13.3) * 0.1 + Math.sin(elapsed * 27.1) * 0.05

    // Tunnel + swirl discs spin at their own rates/directions for a churning funnel.
    tunnel.rotation.z = elapsed * 0.16
    swirlBack.rotation.z = -elapsed * 0.18
    swirlMid.rotation.z = elapsed * 0.26
    swirlFront.rotation.z = elapsed * 0.35
    tunnelMat.opacity = (0.45 + pulse * 0.25) * flicker
    swirlFrontMat.opacity = (0.45 + pulse * 0.25) * flicker
    swirlMidMat.opacity = 0.5 + pulse * 0.25
    swirlBackMat.opacity = 0.45 + pulse * 0.2

    // Hot core breathes; rim/halo pulse; light tracks the pulse.
    coreGlowMat.opacity = (0.65 + pulse * 0.35) * flicker
    hot.scale.setScalar(1 + pulse * 0.14)
    rimMat.opacity = (0.7 + pulse * 0.3) * flicker
    haloMat.opacity = 0.22 + pulse * 0.28
    if (glow) glow.intensity = (7 + pulse * 6) * flicker

    runeOuter.rotation.y = elapsed * 0.22
    runeInner.rotation.y = -elapsed * 0.34

    // Gate dressing (once the model lands): shards drift, rune inlays pulse.
    shards.forEach((s, i) => {
      s.obj.position.y = s.baseY + Math.sin(elapsed * (0.8 + (i % 4) * 0.22) + i * 1.7) * 0.09
      s.obj.rotation.y += dt * (0.3 + (i % 3) * 0.18)
    })
    const runeGlow = 2.4 + pulse * 2.4
    for (const m of runeMats) m.emissiveIntensity = runeGlow

    // Motes rise and are drawn inward (toward root's origin), then recycle down.
    const mp = moteGeo.attributes.position as BufferAttribute
    for (let i = 0; i < mp.count; i++) {
      let y = mp.getY(i) + (0.55 + (i % 5) * 0.14) * dt
      let x = mp.getX(i)
      let z = mp.getZ(i)
      x += -x * dt * 0.5
      z += -z * dt * 0.5
      if (y > TOP) {
        const a = i * 2.399963 // golden-angle spread, deterministic per mote
        const r = 0.6 + (i % 7) * 0.26
        y = 0.05
        x = Math.cos(a) * r
        z = Math.sin(a) * r * 0.35
      }
      mp.setXYZ(i, x, y, z)
    }
    mp.needsUpdate = true
  }

  return { root, update }
}
