import {
  Box3,
  Box3Helper,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Ray,
  Vector3,
} from 'three'
import type { Object3D, Scene,
  PerspectiveCamera } from 'three'
import { brushExtent, checkDemolish, checkTerraform, plotBounds, refusalText, resolveBuild, snapPlacement } from '#shared/utils/building'
import type { PlotBounds } from '#shared/utils/building'
import { DEED_KIND } from '#shared/utils/kit'
import { propHalfExtents } from '#shared/utils/props'
import type { PropSpec, WorldPlacement } from '#shared/utils/props'
import { propsNear, terrainHeight } from '#shared/utils/maze'
import type { SurfaceType, World } from '#shared/utils/world'
import type { UseBuild } from '~/composables/useBuild'

/**
 * Crosshair targeting and the build ghost.
 *
 * Minecraft's input model, not the dev editor's: there is no cursor, so the
 * "pointer" is a ray from the camera straight down its own forward axis, which
 * is exactly where the crosshair sits. The ray is marched against the shared
 * heightfield in tile space rather than raycast against the terrain meshes —
 * the meshes are a rendering of the heights, and aiming at the thing physics
 * reads means the highlight can never disagree with what the server will do.
 *
 * Pieces are picked by world bounding box for the same reason `hubEditor` does:
 * fences, torches and trees have sparse geometry a triangle ray slips between.
 *
 * Verdicts come from `shared/utils/building.ts`, the same predicates the server
 * decides with. They only colour the preview: a red ghost still sends its verb,
 * because the server is the authority and the client's world may be a frame
 * behind it.
 */

export interface BuildTarget {
  /** A terraform brush centre / build pose, or a piece to demolish. */
  mode: 'tile' | 'piece'
  x: number
  y: number
  /** Snapped rotation, for a kit piece. */
  rot?: number
  /** Piece id, when demolishing. */
  id?: string
  /** Whether the local rules allow it. */
  ok: boolean
  /** Why not, or what is under the crosshair. */
  hint: string
}

export interface BuildToolsOptions {
  scene: Scene
  world: World
  templates: ReadonlyMap<string, Group>
  getCamera: () => PerspectiveCamera | undefined
  build: UseBuild
  /** The roster, for naming and colouring a plot's owner. A claim the client
   *  cannot put a name to stays the generic "that plot is claimed" and draws
   *  in the neutral colour — the rules never depend on it. */
  owner?: (id: string) => { name: string, color: string } | undefined
}

/** How far down the crosshair we look. The boom sits ~3.6 behind the player, so
 *  this comfortably covers the reach and a little slack past it. */
const MAX_RAY = 26
const RAY_STEP = 0.25
/** Smallest silhouette a piece gets for picking: a torch is 0.4 wide and a
 *  bush has no collision footprint at all. */
const MIN_PICK = 0.45

const OK_COLOR = new Color('#6ee7a0')
const BAD_COLOR = new Color('#f87171')
/** A plot whose owner is not in the roster — nobody nearby, or not yet joined. */
const PLOT_COLOR = new Color('#cbd5e1')
/** How far a plot outline floats over the ground it is drawn on. */
const PLOT_LIFT = 0.07

export function createBuildTools(options: BuildToolsOptions) {
  const { scene, world, templates, getCamera, build, owner } = options
  const ownerName = (id: string) => owner?.(id)?.name

  const group = new Group()
  group.name = 'build-tools'
  scene.add(group)

  /* Highlights ------------------------------------------------------------- */

  // The terraform brush is three things so it reads on any ground: a tinted
  // quad on the surface, a bright outline drawn over everything, and a post at
  // the centre that stands up from a slope or from pale paving.
  const brushMaterial = new MeshBasicMaterial({
    color: OK_COLOR,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    fog: false,
  })
  const brushLineMaterial = new LineBasicMaterial({ color: OK_COLOR, depthTest: false, toneMapped: false, fog: false })
  const brushPostMaterial = new MeshBasicMaterial({ color: OK_COLOR, toneMapped: false, fog: false })
  let brushSize = 0
  const brushGroup = new Group()
  const brush = new Mesh(new PlaneGeometry(1, 1), brushMaterial)
  brush.rotation.x = -Math.PI / 2
  brush.renderOrder = 3
  // No surface of its own: GTAO's normal pass would read it as a solid slab.
  brush.userData.gtaoExclude = true
  const brushOutline = new LineLoop(new BufferGeometry(), brushLineMaterial)
  brushOutline.renderOrder = 4
  brushOutline.userData.gtaoExclude = true
  const brushPost = new Mesh(new CylinderGeometry(0.04, 0.04, 1.2, 6), brushPostMaterial)
  brushPost.userData.gtaoExclude = true
  brushGroup.add(brush, brushOutline, brushPost)
  brushGroup.visible = false
  group.add(brushGroup)

  const pickBox = new Box3()
  const pieceBox = new Box3()
  const pieceHelper = new Box3Helper(pieceBox, BAD_COLOR)
  const helperMaterial = pieceHelper.material as LineBasicMaterial
  pieceHelper.userData.gtaoExclude = true
  pieceHelper.visible = false
  group.add(pieceHelper)

  /** The brush quad conforms to the ground under it, so a highlight on a slope
   *  reads as part of the hill rather than a card floating through it. */
  function fitBrush(gx: number, gy: number, size: number) {
    if (size !== brushSize) {
      brush.geometry.dispose()
      brush.geometry = new PlaneGeometry(size, size, size * 4, size * 4).rotateX(Math.PI / 2)
      brushSize = size
    }
    const position = brush.geometry.attributes.position!
    for (let i = 0; i < position.count; i++) {
      const x = gx + position.getX(i)
      const y = gy + position.getZ(i)
      const h = terrainHeight(world, x, y)
      position.setY(i, (Number.isFinite(h) ? h : 0) + 0.05)
    }
    position.needsUpdate = true
    brush.geometry.computeBoundingSphere()
    brush.position.set(gx, 0, gy)

    // Outline: walk the perimeter at quarter-tile steps so it hugs the slope.
    const half = size / 2
    const steps = size * 4
    const ring: number[] = []
    const edge = (fx: number, fy: number) => {
      const h = terrainHeight(world, gx + fx, gy + fy)
      ring.push(fx, (Number.isFinite(h) ? h : 0) + 0.08, fy)
    }
    for (let i = 0; i < steps; i++) edge(-half + (i / steps) * size, -half)
    for (let i = 0; i < steps; i++) edge(half, -half + (i / steps) * size)
    for (let i = 0; i < steps; i++) edge(half - (i / steps) * size, half)
    for (let i = 0; i < steps; i++) edge(-half, half - (i / steps) * size)
    brushOutline.geometry.dispose()
    brushOutline.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(ring, 3))
    brushOutline.position.set(gx, 0, gy)

    const centre = terrainHeight(world, gx, gy)
    brushPost.position.set(gx, (Number.isFinite(centre) ? centre : 0) + 0.6, gy)
  }

  /* Plots ------------------------------------------------------------------ */

  /**
   * A deed's claim drawn on the ground it claims.
   *
   * Every plot in the loaded chunks gets a faint loop in its owner's colour, so
   * you can see whose doorstep you are standing on before the server tells you.
   * The armed deed gets a bright one at the pose the ghost is previewing, which
   * is the only way to judge a sixteen-tile square from inside it.
   *
   * Like the brush, the loop is conformed to the heightfield rather than drawn
   * flat: a square hovering through a hill reads as a bug.
   */
  const CONFORM_STEP = 1

  function conformedRing(box: PlotBounds): number[] {
    const ring: number[] = []
    const at = (x: number, y: number) => {
      const h = terrainHeight(world, x, y)
      ring.push(x, (Number.isFinite(h) ? h : 0) + PLOT_LIFT, y)
    }
    for (let x = box.minX; x < box.maxX; x += CONFORM_STEP) at(x, box.minY)
    for (let y = box.minY; y < box.maxY; y += CONFORM_STEP) at(box.maxX, y)
    for (let x = box.maxX; x > box.minX; x -= CONFORM_STEP) at(x, box.maxY)
    for (let y = box.maxY; y > box.minY; y -= CONFORM_STEP) at(box.minX, y)
    return ring
  }

  function fitLoop(loop: LineLoop, box: PlotBounds) {
    loop.geometry.dispose()
    loop.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(conformedRing(box), 3))
  }

  // Existing claims. One loop per deed, rebuilt only when the set of deeds or
  // the ground under them changes — walking past a plot must not cost a
  // geometry rebuild every frame.
  const plotGroup = new Group()
  group.add(plotGroup)
  const plotLoops: LineLoop[] = []
  let plotSignature = ''

  function syncPlots() {
    let signature = ''
    const claims: { box: PlotBounds, color: Color }[] = []
    for (const chunk of world.chunks.values()) {
      for (const deed of chunk.deeds) {
        signature += `${deed.id}@${deed.x},${deed.y}:${chunk.version};`
        const tint = deed.owner ? owner?.(deed.owner)?.color : undefined
        claims.push({ box: plotBounds(deed), color: tint ? new Color(tint) : PLOT_COLOR })
      }
    }
    if (signature === plotSignature) return
    plotSignature = signature
    while (plotLoops.length > claims.length) {
      const loop = plotLoops.pop()!
      plotGroup.remove(loop)
      loop.geometry.dispose()
      ;(loop.material as LineBasicMaterial).dispose()
    }
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i]!
      let loop = plotLoops[i]
      if (!loop) {
        loop = new LineLoop(new BufferGeometry(), new LineBasicMaterial({ transparent: true, opacity: 0.4, toneMapped: false, fog: false }))
        loop.userData.gtaoExclude = true
        plotLoops[i] = loop
        plotGroup.add(loop)
      }
      ;(loop.material as LineBasicMaterial).color.copy(claim.color)
      fitLoop(loop, claim.box)
    }
  }

  // The plot the armed deed would claim, drawn over everything so it reads from
  // inside the square.
  const previewMaterial = new LineBasicMaterial({ color: OK_COLOR, depthTest: false, toneMapped: false, fog: false })
  const plotPreview = new LineLoop(new BufferGeometry(), previewMaterial)
  plotPreview.renderOrder = 4
  plotPreview.userData.gtaoExclude = true
  plotPreview.visible = false
  group.add(plotPreview)

  /* Ghost ------------------------------------------------------------------ */

  const ghostMaterial = new MeshBasicMaterial({
    color: OK_COLOR,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    fog: false,
  })
  const ghost = new Group()
  ghost.visible = false
  group.add(ghost)
  let ghostKind: string | null = null

  function setGhostKind(kind: string | null) {
    if (kind === ghostKind) return
    ghostKind = kind
    ghost.clear()
    if (!kind) return
    const template = templates.get(kind)
    if (!template) return
    // `clone(true)` shares geometry with the template, which is what we want;
    // the materials are replaced outright, so nothing of the template's own is
    // touched and nothing here needs disposing beyond our two materials.
    const preview = template.clone(true)
    preview.traverse((object: Object3D) => {
      if (object instanceof Mesh) {
        object.material = ghostMaterial
        object.castShadow = false
        object.receiveShadow = false
        object.userData.gtaoExclude = true
        object.userData.shadowTagged = true
        object.renderOrder = 3
      }
    })
    ghost.add(preview)
  }

  /* Ray -------------------------------------------------------------------- */

  const ray = new Ray()
  const origin = new Vector3()
  const forward = new Vector3()
  const point = new Vector3()

  /** Where the crosshair meets the heightfield, by marching in tile space. */
  function terrainHit(): { x: number, y: number, distance: number } | null {
    let lo = 0
    for (let t = RAY_STEP; t <= MAX_RAY; t += RAY_STEP) {
      const px = origin.x + forward.x * t
      const py = origin.y + forward.y * t
      const pz = origin.z + forward.z * t
      const h = terrainHeight(world, px, pz)
      if (!Number.isFinite(h)) {
        lo = t
        continue
      }
      if (py > h) {
        lo = t
        continue
      }
      // Crossed below the ground between `lo` and `t`; bisect for the seam.
      let hi = t
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2
        const mx = origin.x + forward.x * mid
        const my = origin.y + forward.y * mid
        const mz = origin.z + forward.z * mid
        const mh = terrainHeight(world, mx, mz)
        if (Number.isFinite(mh) && my <= mh) hi = mid
        else lo = mid
      }
      return { x: origin.x + forward.x * hi, y: origin.z + forward.z * hi, distance: hi }
    }
    return null
  }

  /** Nearest placement the crosshair enters, by bounding box. */
  function pieceHit(actor: { x: number, y: number }): { prop: PropSpec, distance: number, x: number, y: number } | null {
    ray.origin.copy(origin)
    ray.direction.copy(forward)
    let best: { prop: PropSpec, distance: number, x: number, y: number } | null = null
    const seen = new Set<string>()
    for (const prop of propsNear(world, actor.x, actor.y, MAX_RAY)) {
      if (!prop.id || seen.has(prop.id)) continue
      seen.add(prop.id)
      const { ax, ay } = propHalfExtents(prop)
      const hx = Math.max(ax, MIN_PICK)
      const hy = Math.max(ay, MIN_PICK)
      const bottom = prop.base ?? prop.z ?? 0
      const top = bottom + Math.max(prop.height, 0.8)
      pickBox.min.set(prop.x - hx, bottom, prop.y - hy)
      pickBox.max.set(prop.x + hx, top, prop.y + hy)
      if (!ray.intersectBox(pickBox, point)) continue
      const distance = origin.distanceTo(point)
      if (best && distance >= best.distance) continue
      best = { prop, distance, x: point.x, y: point.z }
    }
    return best
  }

  /* Update ----------------------------------------------------------------- */

  function hide(hint: string): null {
    brushGroup.visible = false
    pieceHelper.visible = false
    ghost.visible = false
    plotPreview.visible = false
    build.targetOk.value = false
    build.targetHint.value = hint
    return null
  }

  /**
   * Aim, colour and return the current target. Called once a frame from the
   * scene's render loop, with the *predicted* body as the actor — the same
   * position the reach check will be run against a tick later.
   */
  function update(actor: { x: number, y: number }, selfId: string | null): BuildTarget | null {
    // Claims are drawn whether or not a tool is armed: whose ground you are
    // standing on is worth knowing while you are only walking over it.
    syncPlots()

    const camera = getCamera()
    const slot = build.active.value
    if (!camera || !slot || !selfId) return hide('')

    camera.getWorldPosition(origin)
    camera.getWorldDirection(forward)

    const piece = pieceHit(actor)
    const ground = terrainHit()

    if (slot.id === 'demolish') {
      ghost.visible = false
      brushGroup.visible = false
      if (!piece?.prop.id) return hide('nothing in range')
      const target = piece.prop
      const verdict = checkDemolish(world, placementOf(target, target.id!), { ...actor, id: selfId }, selfId)
      plotPreview.visible = false
      const { ax, ay } = propHalfExtents(target)
      const bottom = target.base ?? target.z ?? 0
      pieceBox.min.set(target.x - Math.max(ax, MIN_PICK), bottom, target.y - Math.max(ay, MIN_PICK))
      pieceBox.max.set(target.x + Math.max(ax, MIN_PICK), bottom + Math.max(target.height, 0.8), target.y + Math.max(ay, MIN_PICK))
      pieceHelper.visible = true
      helperMaterial.color.copy(verdict.ok ? OK_COLOR : BAD_COLOR)
      build.targetOk.value = verdict.ok
      build.targetHint.value = verdict.ok ? piece.prop.kind : refusalText(verdict, ownerName)
      return { mode: 'piece', x: piece.prop.x, y: piece.prop.y, id: piece.prop.id, ok: verdict.ok, hint: build.targetHint.value }
    }

    pieceHelper.visible = false

    // A piece in front of the ground is what you are aiming at: it is how a
    // wall goes on top of a floor rather than into the dirt beside it.
    const aim = piece && ground && piece.distance < ground.distance ? piece : ground
    if (!aim) return hide('nothing in range')

    if (slot.kind) {
      brushGroup.visible = false
      setGhostKind(slot.kind)
      const pose = snapPlacement(slot.kind, aim.x, aim.y, build.rot.value)
      const resolved = resolveBuild(
        world,
        { kind: slot.kind, x: aim.x, y: aim.y, rot: build.rot.value },
        actor,
        { owner: selfId, id: 'ghost', pieces: build.pieces.value, deeds: build.deeds.value },
      )
      const ok = resolved.ok
      const z = ok ? resolved.placement.z ?? 0 : terrainHeight(world, pose.x, pose.y)
      ghost.visible = ghost.children.length > 0
      ghost.position.set(pose.x, Number.isFinite(z) ? z : 0, pose.y)
      ghost.rotation.set(0, pose.rot, 0)
      ghostMaterial.color.copy(ok ? OK_COLOR : BAD_COLOR)
      if (slot.kind === DEED_KIND) {
        plotPreview.visible = true
        previewMaterial.color.copy(ok ? OK_COLOR : BAD_COLOR)
        fitLoop(plotPreview, plotBounds(pose))
      }
      else {
        plotPreview.visible = false
      }
      build.targetOk.value = ok
      build.targetHint.value = ok ? slot.label : refusalText(resolved, ownerName)
      return { mode: 'tile', x: pose.x, y: pose.y, rot: build.rot.value, ok, hint: build.targetHint.value }
    }

    setGhostKind(null)
    ghost.visible = false
    plotPreview.visible = false
    const mode = slot.id as 'raise' | 'lower' | 'flatten' | 'paint'
    // Paint works on tiles, the shovels on corners: the tile under the
    // crosshair is `floor`, the nearest corner is `round`. Using `round` for
    // paint put the highlight and the paint half a tile up and to the left of
    // where the player was looking.
    const tiles = mode === 'paint'
    const gx = tiles ? Math.floor(aim.x) : Math.round(aim.x)
    const gy = tiles ? Math.floor(aim.y) : Math.round(aim.y)
    const verdict = checkTerraform(
      world,
      { x: gx, y: gy, mode, size: build.size.value, surface: build.surface.value as SurfaceType },
      { ...actor, id: selfId },
    )
    const extent = brushExtent(gx, gy, build.size.value)
    fitBrush((extent.minX + extent.maxX + (tiles ? 1 : 0)) / 2, (extent.minY + extent.maxY + (tiles ? 1 : 0)) / 2, build.size.value)
    brushGroup.visible = true
    const tint = verdict.ok ? OK_COLOR : BAD_COLOR
    brushMaterial.color.copy(tint)
    brushLineMaterial.color.copy(tint)
    brushPostMaterial.color.copy(tint)
    build.targetOk.value = verdict.ok
    build.targetHint.value = verdict.ok ? slot.label : refusalText(verdict, ownerName)
    return { mode: 'tile', x: gx, y: gy, ok: verdict.ok, hint: build.targetHint.value }
  }

  function setVisible(visible: boolean) {
    group.visible = visible
    if (!visible) {
      build.targetOk.value = false
      build.targetHint.value = ''
    }
  }

  function dispose() {
    scene.remove(group)
    brush.geometry.dispose()
    brushMaterial.dispose()
    brushOutline.geometry.dispose()
    brushLineMaterial.dispose()
    brushPost.geometry.dispose()
    brushPostMaterial.dispose()
    ghostMaterial.dispose()
    pieceHelper.geometry.dispose()
    helperMaterial.dispose()
    plotPreview.geometry.dispose()
    previewMaterial.dispose()
    for (const loop of plotLoops) {
      loop.geometry.dispose()
      ;(loop.material as LineBasicMaterial).dispose()
    }
    plotLoops.length = 0
    group.clear()
  }

  return { update, setVisible, dispose }
}

/** `checkDemolish` reads a `WorldPlacement`; a `PropSpec` is the same record
 *  plus collision fields, so this only narrows it back down. */
function placementOf(prop: PropSpec, id: string): WorldPlacement {
  return { kind: prop.kind, x: prop.x, y: prop.y, rot: prop.rot, scale: prop.scale, z: prop.z, s3: prop.s3, id, owner: prop.owner }
}
