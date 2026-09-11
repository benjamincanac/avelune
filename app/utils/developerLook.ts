import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
  SkinnedMesh,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { Material, Object3D } from 'three'

/**
 * Turn a loaded Quaternius Peasant rig (male or female) into the Developer.
 * Black tee (tunic/blouse), bare forearms (elbow bands / gloves re-skinned and slimmed),
 * jeans (trousers + boot shafts), white sneakers (boot feet), a fitted baseball cap, ▲ marks.
 * Runs ONCE on the loaded template, before cloning: geometry and materials are shared by every rig.
 * Everything is measured off the rig in bind pose, in metres, so both bodies fit without tuning.
 */

const TEE = '#141416'
const JEANS = '#3d4966'
const SNEAKER = '#e8e8e4'
const SOLE = '#26262a'
const CAP = '#0d0d10'

const UP = new Vector3(0, 1, 0)
const FORWARD = new Vector3(0, 0, 1)

interface Bones {
  head: Object3D
  spine: Object3D
  /** [left (+x), right (−x)] */
  upperarm: [Vector3, Vector3]
  lowerarm: [Vector3, Vector3]
  hand: [Vector3, Vector3]
  thigh: [Vector3, Vector3]
  foot: [Vector3, Vector3]
  footY: number
  pelvisY: number
  waistY: number
  chestY: number
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function skinnedMeshes(obj: Object3D): SkinnedMesh[] {
  const out: SkinnedMesh[] = []
  obj.traverse((o) => {
    if (o instanceof SkinnedMesh) out.push(o)
  })
  return out
}

function firstMaterial(mesh: Mesh): MeshStandardMaterial {
  return (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial
}

function worldPos(obj: Object3D): Vector3 {
  return obj.getWorldPosition(new Vector3())
}

function indexArray(geometry: BufferGeometry): Uint32Array {
  const index = geometry.getIndex()
  if (index) return Uint32Array.from(index.array as ArrayLike<number>)
  return Uint32Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i)
}

/** Luminance sampler over a material's base colour map (glTF UVs: v runs top-down when flipY is off). */
function luminanceSampler(material: MeshStandardMaterial): ((u: number, v: number) => number) | null {
  const map = material.map
  const image = map?.image as (CanvasImageSource & { width: number, height: number }) | undefined
  if (!map || !image?.width) return null
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(image, 0, 0)
  const { width: w, height: h } = canvas
  const { data } = ctx.getImageData(0, 0, w, h)
  return (u, v) => {
    u -= Math.floor(u)
    v -= Math.floor(v)
    if (map.flipY) v = 1 - v
    const i = (Math.min(h - 1, Math.floor(v * h)) * w + Math.min(w - 1, Math.floor(u * w))) * 4
    return (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255
  }
}

/** Reorder a mesh's triangles into material groups: `classify` returns the material index per face. */
function regroup(mesh: Mesh, materials: Material[], classify: (a: number, b: number, c: number) => number) {
  const geometry = mesh.geometry
  const index = indexArray(geometry)
  const buckets: number[][] = materials.map(() => [])
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]!, b = index[t + 1]!, c = index[t + 2]!
    buckets[classify(a, b, c)]!.push(a, b, c)
  }
  const merged = new Uint32Array(index.length)
  let offset = 0
  geometry.clearGroups()
  buckets.forEach((bucket, i) => {
    if (!bucket.length) return
    merged.set(bucket, offset)
    geometry.addGroup(offset, bucket.length, i)
    offset += bucket.length
  })
  geometry.setIndex(new BufferAttribute(merged, 1))
  mesh.material = materials
}

/**
 * Split every triangle crossing the horizontal plane `planeY`, so a per-face material split lands on a
 * crisp line instead of a sawtooth. Bone indices and weights can't be blended, so a cut vertex takes them
 * from the nearer end of its edge.
 */
function splitAtPlane(geometry: BufferGeometry, planeY: number): void {
  const names = ['position', 'normal', 'uv', 'uv1', 'skinIndex', 'skinWeight', 'color'].filter(n => geometry.getAttribute(n))
  const attrs = new Map(names.map(n => [n, geometry.getAttribute(n) as BufferAttribute]))
  const pos = attrs.get('position')!
  const index = indexArray(geometry)
  const extra = new Map(names.map(n => [n, [] as number[]]))
  const cache = new Map<string, number>()
  let count = pos.count
  const cut = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    const hit = cache.get(key)
    if (hit != null) return hit
    const t = (planeY - pos.getY(a)) / (pos.getY(b) - pos.getY(a))
    for (const [n, src] of attrs) {
      const blend = n !== 'skinIndex' && n !== 'skinWeight'
      for (let c = 0; c < src.itemSize; c++) {
        const va = src.getComponent(a, c)
        const vb = src.getComponent(b, c)
        extra.get(n)!.push(blend ? va + (vb - va) * t : t < 0.5 ? va : vb)
      }
    }
    cache.set(key, count)
    return count++
  }
  const out: number[] = []
  const above = (i: number) => (pos.getY(i) >= planeY ? 1 : 0)
  for (let t = 0; t < index.length; t += 3) {
    const tri = [index[t]!, index[t + 1]!, index[t + 2]!]
    const sides = tri.map(above)
    const n = sides[0]! + sides[1]! + sides[2]!
    if (n === 0 || n === 3) {
      out.push(...tri)
      continue
    }
    // Rotate so the vertex alone on its side comes first, then cut the two edges leaving it.
    const lone = sides.indexOf(n === 1 ? 1 : 0)
    const a = tri[lone]!, b = tri[(lone + 1) % 3]!, c = tri[(lone + 2) % 3]!
    const ab = cut(a, b)
    const ac = cut(a, c)
    out.push(a, ab, ac, ab, b, c, ab, c, ac)
  }
  for (const [n, src] of attrs) {
    const size = src.itemSize
    const merged = new Float32Array(count * size)
    for (let i = 0; i < src.count; i++) for (let c = 0; c < size; c++) merged[i * size + c] = src.getComponent(i, c)
    merged.set(extra.get(n)!, src.count * size)
    geometry.setAttribute(n, new BufferAttribute(merged, size))
  }
  geometry.setIndex(out)
}

/** Copy the given triangles (flat vertex indices) into a compact new geometry; `order` maps new → old vertex. */
function extract(geometry: BufferGeometry, tris: number[]): { geometry: BufferGeometry, order: number[] } {
  const remap = new Map<number, number>()
  const order: number[] = []
  const index = tris.map((v) => {
    let r = remap.get(v)
    if (r == null) {
      r = order.length
      remap.set(v, r)
      order.push(v)
    }
    return r
  })
  const out = new BufferGeometry()
  for (const name of ['position', 'normal', 'uv', 'uv1', 'skinIndex', 'skinWeight']) {
    const src = geometry.getAttribute(name) as BufferAttribute | undefined
    if (!src) continue
    const size = src.itemSize
    const arr = new Float32Array(order.length * size)
    order.forEach((v, i) => {
      for (let c = 0; c < size; c++) arr[i * size + c] = src.getComponent(v, c)
    })
    out.setAttribute(name, new BufferAttribute(arr, size))
  }
  out.setIndex(index)
  return { geometry: out, order }
}

interface Shell {
  verts: number
  minY: number
  maxY: number
}

/**
 * Drop whole disconnected shells of a mesh. Quaternius builds accessories as separate shells — the
 * male tunic's eight belt strips, buckle, shoulder pads, rivets and buttons, the boots' rolled cuff
 * flaps — so deleting a shell never opens a hole in the cloth under it.
 */
function dropShells(mesh: Mesh, doomed: (shell: Shell, largest: Shell) => boolean): void {
  const geometry = mesh.geometry
  const pos = geometry.getAttribute('position') as BufferAttribute
  const index = indexArray(geometry)
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  for (let t = 0; t < index.length; t += 3) {
    const a = find(index[t]!), b = find(index[t + 1]!), c = find(index[t + 2]!)
    if (a !== b) parent[a] = b
    if (find(a) !== find(c)) parent[find(a)] = find(c)
  }
  const shells = new Map<number, Shell>()
  for (let i = 0; i < pos.count; i++) {
    const root = find(i)
    const shell = shells.get(root) ?? { verts: 0, minY: Infinity, maxY: -Infinity }
    shell.verts++
    shell.minY = Math.min(shell.minY, pos.getY(i))
    shell.maxY = Math.max(shell.maxY, pos.getY(i))
    shells.set(root, shell)
  }
  let largest: Shell = { verts: 0, minY: 0, maxY: 0 }
  for (const shell of shells.values()) if (shell.verts > largest.verts) largest = shell
  const gone = new Set<number>()
  for (const [root, shell] of shells) if (doomed(shell, largest)) gone.add(root)
  if (!gone.size) return
  const kept: number[] = []
  for (let t = 0; t < index.length; t += 3) {
    if (gone.has(find(index[t]!))) continue
    kept.push(index[t]!, index[t + 1]!, index[t + 2]!)
  }
  geometry.setIndex(kept)
}

/** A flat white ▲ of the given height, centred on its centroid, facing +Z. */
function makeMark(size: number): Mesh {
  const half = size / Math.sqrt(3)
  const shape = new Shape()
  shape.moveTo(-half, -size / 3)
  shape.lineTo(half, -size / 3)
  shape.lineTo(0, (2 * size) / 3)
  shape.closePath()
  return new Mesh(new ShapeGeometry(shape), new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }))
}

/**
 * Attach `obj` to `bone` with +Y as the rig's up and +Z as the rig's forward, whatever the bone's roll.
 * Measured in the bind pose, so call before the mixer moves anything.
 */
function hang(obj: Object3D, bone: Object3D, root: Object3D, up: number, forward: number) {
  const toBone = new Matrix4().copy(bone.matrixWorld).invert()
  const localUp = UP.clone().transformDirection(root.matrixWorld).transformDirection(toBone)
  const localFwd = FORWARD.clone().transformDirection(root.matrixWorld).transformDirection(toBone)
  const right = new Vector3().crossVectors(localUp, localFwd).normalize()
  obj.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(right, localUp, localFwd))
  obj.position.copy(localUp).multiplyScalar(up).addScaledVector(localFwd, forward)
  bone.add(obj)
}

/* -------------------------------------------------------------------------- */
/* Clothes                                                                    */
/* -------------------------------------------------------------------------- */

/** Flat-coloured cloth that keeps the Peasant normal map (folds) at reduced strength. Double-sided: sleeve and neck openings show cloth, not a hole. */
function cloth(color: string, roughness: number, from: MeshStandardMaterial, folds: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness,
    metalness: 0,
    side: DoubleSide,
    normalMap: folds ? from.normalMap : null,
    normalScale: from.normalScale.clone().multiplyScalar(folds),
  })
}

/**
 * Pull radial outliers of a sleeve back to its surface: per 2 cm slice along the arm, anything more than
 * 1.2 cm outside the slice's median radius (the shoulder pads) is brought down to just above it.
 */
function ironSleeveOutliers(sleeve: SkinnedMesh, bones: Bones, maxAlong: number): void {
  const pos = sleeve.geometry.getAttribute('position') as BufferAttribute
  const slices = new Map<string, number[]>()
  const radii = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const k = pos.getX(i) >= 0 ? 0 : 1
    const along = Math.abs(pos.getX(i))
    if (along > maxAlong) continue
    radii[i] = radial(pos, i, bones, k).length()
    const key = `${k}:${Math.floor(along / 0.02)}`
    const slice = slices.get(key)
    if (slice) slice.push(i)
    else slices.set(key, [i])
  }
  for (const slice of slices.values()) {
    if (slice.length < 6) continue
    const sorted = slice.map(i => radii[i]!).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    for (const i of slice) {
      if (radii[i]! < median + 0.012) continue
      const k = pos.getX(i) >= 0 ? 0 : 1
      const r = radial(pos, i, bones, k)
      const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).addScaledVector(r, (median + 0.003) / radii[i]! - 1)
      pos.setXYZ(i, p.x, p.y, p.z)
    }
  }
  pos.needsUpdate = true
}

/**
 * Sleeves: everything past the elbow, and leather before it, becomes bare skin; the rest is the tee.
 * The male's elbow bands and the female's gloves come out as a slimmed skin copy that hugs the arm;
 * band faces already covered by the male's real forearm skin are simply dropped.
 */
function dressArms(armsRoot: Object3D, root: Object3D, bones: Bones, tee: Material, skinFallback: SkinnedMesh) {
  const meshes = skinnedMeshes(armsRoot)
  const sleeve = meshes.find(m => firstMaterial(m).name.startsWith('MI_Peasant'))
  if (!sleeve) return
  const realSkin = meshes.find(m => m !== sleeve)
  // Shoulder pads ride the top of the sleeves: iron them down before anything reads positions.
  ironSleeveOutliers(sleeve, bones, (Math.abs(bones.upperarm[0].x) + Math.abs(bones.lowerarm[0].x)) / 2)
  const geometry = sleeve.geometry
  const pos = geometry.getAttribute('position') as BufferAttribute
  const side = (i: number) => (pos.getX(i) >= 0 ? 0 : 1)
  const along = (i: number) => Math.abs(pos.getX(i))

  // Where the arm's own skin starts (male); the female has none, so nothing is dropped.
  let skinStart = Infinity
  if (realSkin) {
    const sp = realSkin.geometry.getAttribute('position') as BufferAttribute
    for (let i = 0; i < sp.count; i++) {
      const s = Math.abs(sp.getX(i))
      if (s > Math.abs(bones.upperarm[0].x) + 0.1) skinStart = Math.min(skinStart, s)
    }
  }

  // A tee sleeve ends halfway down the upper arm; everything past that is bare arm.
  const kind = (i: number): 'tee' | 'skin' => {
    const k = side(i)
    const mid = (Math.abs(bones.upperarm[k].x) + Math.abs(bones.lowerarm[k].x)) / 2
    return along(i) > mid ? 'skin' : 'tee'
  }

  const index = indexArray(geometry)
  const teeTris: number[] = []
  const skinTris: number[] = []
  let sleeveRadius = 0
  let sleeveCount = 0
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]!, b = index[t + 1]!, c = index[t + 2]!
    const skin = [a, b, c].filter(i => kind(i) === 'skin').length >= 2
    if (!skin) {
      teeTris.push(a, b, c)
      continue
    }
    // Under the real forearm skin already: drop rather than duplicate.
    if ([a, b, c].every(i => along(i) > skinStart + 0.008)) continue
    skinTris.push(a, b, c)
  }
  // The tee's sleeve radius just before the elbow sets how slim the bare arm is.
  for (let t = 0; t < teeTris.length; t++) {
    const i = teeTris[t]!
    const k = side(i)
    const s = along(i)
    if (s > Math.abs(bones.lowerarm[k].x) - 0.08 && s < Math.abs(bones.lowerarm[k].x)) {
      sleeveRadius += radial(pos, i, bones, k).length()
      sleeveCount++
    }
  }
  const armRadius = sleeveCount ? (sleeveRadius / sleeveCount) * 0.9 : 0.045
  // Vertices on the hem ring are shared with the tee: leave them put so the arm stays attached to the sleeve.
  const hemRing = new Set(teeTris)

  geometry.clearGroups()
  geometry.setIndex(new BufferAttribute(Uint32Array.from(teeTris), 1))
  sleeve.material = tee
  if (!skinTris.length) return

  // Skin copy: same skeleton, the skin material's texture sampled at one plain-skin texel.
  const skinSource = realSkin ?? skinFallback
  const skinUv = plainSkinUv(skinSource, bones, !!realSkin)
  const { geometry: copy, order } = extract(geometry, skinTris)
  const cp = copy.getAttribute('position') as BufferAttribute
  const cu = copy.getAttribute('uv') as BufferAttribute
  for (let i = 0; i < cp.count; i++) {
    cu.setXY(i, skinUv.x, skinUv.y)
    const k = cp.getX(i) >= 0 ? 0 : 1
    if (hemRing.has(order[i]!)) continue
    if (Math.abs(cp.getX(i)) > Math.abs(bones.hand[k].x) - 0.03) continue // hands keep their shape
    const r = radial(cp, i, bones, k)
    const len = r.length()
    if (len > armRadius) {
      const p = new Vector3(cp.getX(i), cp.getY(i), cp.getZ(i)).addScaledVector(r, armRadius / len - 1)
      cp.setXYZ(i, p.x, p.y, p.z)
    }
  }
  // One texel of the skin atlas for tone; the detail maps would sample garbage at that texel.
  // Dropping the AO map matters most: with no `uv1` it reads texel (0,0), which is black on the female atlas.
  const skinMaterial = firstMaterial(skinSource).clone()
  skinMaterial.aoMap = null
  skinMaterial.normalMap = null
  skinMaterial.roughnessMap = null
  skinMaterial.metalnessMap = null
  // Flat skin renders brighter than the mapped skin next to it; pull it down to match.
  skinMaterial.roughness = 0.85
  skinMaterial.color.setScalar(0.78)
  // The base-body meshes carry COLOR_0; a copy without it would multiply by black.
  skinMaterial.vertexColors = false
  skinMaterial.needsUpdate = true
  const skin = new SkinnedMesh(copy, skinMaterial)
  skin.name = `${sleeve.name}_skin`
  skin.bind(sleeve.skeleton, sleeve.bindMatrix)
  sleeve.parent?.add(skin)
}

/** Horizontal offset of vertex `i` from its leg's thigh→foot axis (nearest side by x). */
function legRadial(pos: BufferAttribute, i: number, bones: Bones): Vector3 {
  const k = pos.getX(i) >= 0 ? 0 : 1
  const a = bones.thigh[k]
  const b = bones.foot[k]
  const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
  const axis = new Vector3().subVectors(b, a)
  const t = new Vector3().subVectors(p, a).dot(axis) / axis.lengthSq()
  const foot = new Vector3().copy(a).addScaledVector(axis, t)
  return p.sub(foot).setY(0)
}

/** Radial offset of vertex `i` from the arm's bone axis on side `k`. */
function radial(pos: BufferAttribute, i: number, bones: Bones, k: 0 | 1): Vector3 {
  const a = bones.upperarm[k]
  const b = bones.hand[k]
  const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
  const axis = new Vector3().subVectors(b, a)
  const t = new Vector3().subVectors(p, a).dot(axis) / axis.lengthSq()
  const foot = new Vector3().copy(a).addScaledVector(axis, t)
  return p.sub(foot)
}

/**
 * A texel of plain skin. Hands mesh: the vertex nearest mid-forearm. Head mesh: the median-luminance
 * texel over the front of the face, which skips eyes, brows, lips and the dark underwear blocks the
 * base-body atlas keeps around the neck.
 */
function plainSkinUv(source: SkinnedMesh, bones: Bones, forearm: boolean): Vector2 {
  const pos = source.geometry.getAttribute('position') as BufferAttribute
  const uv = source.geometry.getAttribute('uv') as BufferAttribute
  if (forearm) {
    let best = 0
    let bestScore = Infinity
    const target = (Math.abs(bones.lowerarm[0].x) + Math.abs(bones.hand[0].x)) / 2
    for (let i = 0; i < pos.count; i++) {
      const score = Math.abs(Math.abs(pos.getX(i)) - target)
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    return new Vector2(uv.getX(best), uv.getY(best))
  }
  const headY = worldPos(bones.head).y
  const luma = luminanceSampler(firstMaterial(source))
  const face: { i: number, l: number }[] = []
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y > headY + 0.04 && y < headY + 0.14 && pos.getZ(i) > 0.02) face.push({ i, l: luma ? luma(uv.getX(i), uv.getY(i)) : 0 })
  }
  face.sort((a, b) => a.l - b.l)
  const pick = face[Math.floor(face.length / 2)]?.i ?? 0
  return new Vector2(uv.getX(pick), uv.getY(pick))
}

/* -------------------------------------------------------------------------- */
/* The cap                                                                    */
/* -------------------------------------------------------------------------- */

/** Crown profile as (radius, height) fractions, rim to top: a low, round baseball dome. */
const CROWN = [[1, 0], [1, 0.1], [0.99, 0.3], [0.955, 0.52], [0.87, 0.72], [0.7, 0.88], [0.42, 0.97], [0, 1]] as const

function crownRadiusAt(yFrac: number): number {
  for (let i = 1; i < CROWN.length; i++) {
    const [r0, y0] = CROWN[i - 1]!
    const [r1, y1] = CROWN[i]!
    if (yFrac <= y1) return r0 + ((yFrac - y0) / (y1 - y0)) * (r1 - r0)
  }
  return 0
}

/** The visor: a curved, drooping sheet with thickness, widest at the front, tapering to the temples. */
function makeVisor(rx: number, rz: number, length: number, material: Material): Mesh {
  const SEG = 24
  const ROWS = 5
  const THICK = 0.005
  const MAX_A = Math.PI * 0.46
  const pos: number[] = []
  const idx: number[] = []
  const point = (a: number, t: number, layer: number) => {
    const c = Math.cos(a)
    const s = Math.sin(a)
    const reach = length * Math.max(0, (c - 0.2) / 0.8)
    const droop = -0.004 - t * t * 0.024 - (a / MAX_A) ** 2 * t * 0.02
    pos.push(rx * s + s * reach * t, droop - layer * THICK, rz * c + c * reach * t)
    return pos.length / 3 - 1
  }
  const grid = (layer: number) => {
    const ids: number[][] = []
    for (let i = 0; i <= SEG; i++) {
      const row: number[] = []
      const a = -MAX_A + (2 * MAX_A * i) / SEG
      for (let j = 0; j <= ROWS; j++) row.push(point(a, j / ROWS, layer))
      ids.push(row)
    }
    return ids
  }
  const top = grid(0)
  const bottom = grid(1)
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d)
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < ROWS; j++) {
      quad(top[i]![j]!, top[i]![j + 1]!, top[i + 1]![j + 1]!, top[i + 1]![j]!)
      quad(bottom[i]![j]!, bottom[i + 1]![j]!, bottom[i + 1]![j + 1]!, bottom[i]![j + 1]!)
    }
    quad(top[i]![ROWS]!, bottom[i]![ROWS]!, bottom[i + 1]![ROWS]!, top[i + 1]![ROWS]!)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.setIndex(idx)
  geometry.computeVertexNormals()
  return new Mesh(geometry, material)
}

/** A baseball cap sized to the head: rim ellipse `rx`×`rz`, crown `height` above the rim, origin at the rim centre. */
function makeCap(rx: number, rz: number, height: number): Group {
  const cap = new Group()
  const material = new MeshStandardMaterial({ color: CAP, roughness: 0.88, side: DoubleSide })
  const crown = new Mesh(new LatheGeometry(CROWN.map(([r, y]) => new Vector2(r * rx, y * height)), 40), material)
  crown.scale.z = rz / rx
  cap.add(crown)
  const band = new Mesh(new TorusGeometry(rx, 0.0055, 8, 48), material)
  band.rotation.x = Math.PI / 2
  band.scale.y = rz / rx
  band.position.y = 0.004
  cap.add(band)
  const button = new Mesh(new SphereGeometry(0.011, 12, 8), material)
  button.position.y = height
  cap.add(button)
  cap.add(makeVisor(rx, rz, rz * 0.72, material))
  // ▲ on the front panel, following the crown's slope.
  const yFrac = 0.45
  const mark = makeMark(0.034)
  mark.position.set(0, yFrac * height + 0.004, rz * crownRadiusAt(yFrac) + 0.0025)
  mark.rotation.x = -0.3
  cap.add(mark)
  return cap
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export function prepareDeveloper(root: Object3D): void {
  if (root.userData.developer) return
  root.userData.developer = true
  root.updateMatrixWorld(true)

  const meshes = skinnedMeshes(root)
  const prefix = meshes.map(m => /^(Male|Female)_Peasant/.exec(m.name)?.[0]).find(Boolean)
  const head = meshes.find(m => firstMaterial(m).name.startsWith('MI_Superhero'))
  const bone = (name: string) => root.getObjectByName(name)
  const headBone = bone('Head')
  const spine = bone('spine_03')
  if (!prefix || !head || !headBone || !spine) return
  const pair = (name: string): [Vector3, Vector3] => [worldPos(bone(`${name}_l`)!), worldPos(bone(`${name}_r`)!)]
  const bones: Bones = {
    head: headBone,
    spine,
    upperarm: pair('upperarm'),
    lowerarm: pair('lowerarm'),
    hand: pair('hand'),
    thigh: pair('thigh'),
    foot: pair('foot'),
    footY: worldPos(bone('foot_l')!).y,
    pelvisY: worldPos(bone('pelvis')!).y,
    waistY: worldPos(bone('spine_01')!).y,
    chestY: worldPos(spine).y,
  }

  const body = root.getObjectByName(`${prefix}_Body`)
  const legs = root.getObjectByName(`${prefix}_Legs`)
  const feet = root.getObjectByName(`${prefix}_Feet`)
  const arms = root.getObjectByName(`${prefix}_Arms`)
  const peasant = body ? firstMaterial(skinnedMeshes(body)[0]!) : firstMaterial(meshes[0]!)

  // Flat matte: the tunic's leather-and-buttons normal map would keep reading as a tunic.
  const tee = cloth(TEE, 0.92, peasant, 0)
  const jeans = cloth(JEANS, 0.95, peasant, 0.5)
  const sneaker = cloth(SNEAKER, 0.6, peasant, 0)
  const sole = cloth(SOLE, 0.9, peasant, 0)

  for (const m of body ? skinnedMeshes(body) : []) {
    // Belt strips, buckle, shoulder pads, rivets, buttons: every small shell goes, when the cloth itself is
    // a few big shells (the male tunic). The female bodice is stitched from small panels, so it is left whole.
    dropShells(m, (shell, largest) => largest.verts > 400 && shell.verts < 200)
    m.material = tee
  }
  // Trousers; remember where the hem is and how wide, so the boot shafts can meet it.
  let hemRadius = 0
  let hemY = 0
  for (const m of legs ? skinnedMeshes(legs) : []) {
    m.material = jeans
    const pos = m.geometry.getAttribute('position') as BufferAttribute
    let low = Infinity
    for (let i = 0; i < pos.count; i++) low = Math.min(low, pos.getY(i))
    // Drop the hem ring 4.5 cm so the jeans cover the boot top instead of tucking into it.
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < low + 0.015) pos.setY(i, pos.getY(i) - 0.045)
    }
    pos.needsUpdate = true
    hemY = low
    let sum = 0
    let n = 0
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < low + 0.04) {
        sum += legRadial(pos, i, bones).length()
        n++
      }
    }
    hemRadius = n ? sum / n : 0
  }
  // Boots: the shaft becomes the jeans' leg — the rolled-over cuff flap is cut away and the shaft under it
  // flares to meet the trouser hem — the foot a sneaker, the bottom its sole, cut on clean planes.
  for (const m of feet ? skinnedMeshes(feet) : []) {
    let pos = m.geometry.getAttribute('position') as BufferAttribute
    const ankle = bones.footY + 0.05
    if (hemRadius) {
      const cuffStart = hemY - 0.09
      const radii = new Float32Array(pos.count)
      let shaftRadius = 0
      let n = 0
      for (let i = 0; i < pos.count; i++) {
        radii[i] = legRadial(pos, i, bones).length()
        const y = pos.getY(i)
        if (y > ankle + 0.06 && y < cuffStart) {
          shaftRadius += radii[i]!
          n++
        }
      }
      shaftRadius = n ? shaftRadius / n : hemRadius
      // The rolled cuff is its own shells, hanging entirely inside the cuff band.
      dropShells(m, shell => shell.minY > cuffStart)
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i)
        if (y < cuffStart || radii[i]! < 1e-6) continue
        const t = Math.min(1, (y - cuffStart) / Math.max(0.01, hemY - cuffStart))
        // A touch under the hem radius, so the lowered jeans hem sits outside the shaft, never inside it.
        const target = shaftRadius + (hemRadius * 0.92 - shaftRadius) * t
        const r = legRadial(pos, i, bones)
        const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).addScaledVector(r, target / radii[i]! - 1)
        pos.setXYZ(i, p.x, p.y, p.z)
      }
      pos.needsUpdate = true
    }
    splitAtPlane(m.geometry, ankle)
    splitAtPlane(m.geometry, 0.028)
    pos = m.geometry.getAttribute('position') as BufferAttribute
    regroup(m, [jeans, sneaker, sole], (a, b, c) => {
      const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3
      return y > ankle ? 0 : y > 0.028 ? 1 : 2
    })
  }
  if (arms) dressArms(arms, root, bones, tee, head)

  // Cap fitted to the head + hair volume above the brow line.
  let top = -Infinity
  const above: Vector3[] = []
  const crownMeshes = meshes.filter(m => m === head || firstMaterial(m).name.startsWith('MI_Hair'))
  const all: Vector3[] = []
  for (const m of crownMeshes) {
    const pos = m.geometry.getAttribute('position') as BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const p = m.localToWorld(new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))
      all.push(p)
      top = Math.max(top, p.y)
    }
  }
  // Rim just above the brow line; the dome adds a couple of centimetres over the skull.
  const rimY = top - 0.075
  for (const p of all) if (p.y > rimY) above.push(p)
  let rx = 0, zMin = Infinity, zMax = -Infinity
  for (const p of above) {
    rx = Math.max(rx, Math.abs(p.x))
    zMin = Math.min(zMin, p.z)
    zMax = Math.max(zMax, p.z)
  }
  const cap = makeCap(rx + 0.01, (zMax - zMin) / 2 + 0.01, top - rimY + 0.022)
  cap.rotation.x = 0.12
  const headPos = worldPos(headBone)
  hang(cap, headBone, root, rimY - headPos.y, (zMax + zMin) / 2 - headPos.z)

  // ▲ on the chest, just off the tee's surface at the upper chest.
  const spinePos = worldPos(spine)
  const markY = spinePos.y + 0.03
  let chestZ = spinePos.z + 0.1
  for (const m of body ? skinnedMeshes(body) : []) {
    const pos = m.geometry.getAttribute('position') as BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i)) < 0.03 && Math.abs(pos.getY(i) - markY) < 0.04) chestZ = Math.max(chestZ, pos.getZ(i))
    }
  }
  hang(makeMark(0.07), spine, root, markY - spinePos.y, chestZ + 0.004 - spinePos.z)
}
