import { BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, MeshStandardMaterial, Object3D, Vector3 } from 'three'
import { LANDSCAPE_CENTER, LANDSCAPE_EXPANSION, smoothstep } from '#shared/utils/terrain'
import { MEADOW_PALETTE } from './terrainChunk'

/**
 * The meadow's grass.
 *
 * This file used to draw the whole decorative landscape — a single heightfield
 * mesh keyed to the town constants, with the nature kit scattered over it and
 * no collision behind any of it. The ground is now real chunk terrain
 * (`terrainChunk.ts`) and the trees are real chunk placements the server
 * seeds, so all that is left here is the one thing that stays purely cosmetic:
 * wind-blown tufts, instanced per chunk and per garden bed.
 */

/** Quaternius Stylized Nature MegaKit pieces (CC0), converted by
 *  scripts/convert_nature.sh into public/models/nature/. Variants share a
 *  prefix so a placement can pick among them per family. */
export const NATURE_NAMES = [
  'tree1', 'tree2', 'tree3', 'tree4', 'tree5',
  // The regional tree families `shared/utils/vegetation.ts` plants outside the
  // meadow belt: conifers, autumn-red crooked trees, bare standing trunks.
  // Missing from here they would arrive as placements with no template and
  // render as nothing at all.
  'pine1', 'pine2', 'pine3',
  'twisted1', 'twisted2', 'twisted3',
  'dead1', 'dead2', 'dead3',
  'bush1', 'bush2',
  'fern', 'clover', 'plant',
  'flowers1', 'flowers2',
  // Cosmetic ground detail, scattered client-side per biome (`chunkScatter`).
  'mushroom1', 'mushroom2',
  'pebble1', 'pebble2', 'pebble3',
  'rock1', 'rock2', 'rock3',
] as const

/** One tuft: where it stands, how tall, and which way it fans. */
export interface GrassBlade {
  x: number
  z: number
  y: number
  size: number
  angle: number
  /** The ground's own pigment under the tuft, as `meadowCover` reports it: how
   *  far it runs from dry grass to lush, and how much straw is mixed in. The
   *  blades are coloured from it, so a tuft grows out of its ground instead of
   *  sitting on it. Left out, the tuft is lush (the town's watered beds). */
  lush?: number
  straw?: number
}

/** A rendered body the blades bend away from: world x/z and the height of its
 *  feet. Matches the shape the fountain already gets for its wakes. */
export interface GrassPusher {
  x: number
  z: number
  feetY: number
}

/** How many bodies the shader tests per vertex. Four covers you plus the peers
 *  close enough to matter; the loop runs for every blade, so it stays small. */
const PUSHER_SLOTS = 4
/** Unused slots park far outside the world so the radius test skips them
 *  without a second uniform for "is this slot live". */
const PUSHER_AWAY = 1e6
/** How far a body pushes, in world units. */
const PUSH_RADIUS = 0.9
/** Feet more than this above or below a blade's root let it stand back up, so
 *  a jump releases the grass instead of dragging it along under the player. */
const PUSH_CONTACT = 0.6

/**
 * Shared by *every* grass bank, because there is more than one: the chunk
 * meadows and the town's garden beds each build their own bank, and both must
 * react to the same bodies. One uniform object, one update per frame.
 */
const pushers = { value: Array.from({ length: PUSHER_SLOTS }, () => new Vector3(PUSHER_AWAY, PUSHER_AWAY, PUSHER_AWAY)) }
/** Scratch for the selection below: how far each filled slot sits from you. */
const slotDistance = new Array<number>(PUSHER_SLOTS).fill(Infinity)

/**
 * Point the blade-push uniform at the nearest rendered bodies. `nearX`/`nearZ`
 * is the local player: the radius is under a metre, so the only bodies worth a
 * slot are the ones standing next to you.
 */
export function setGrassPushers(actors: readonly GrassPusher[], nearX: number, nearZ: number) {
  const slots = pushers.value
  let filled = 0
  for (const actor of actors) {
    const distance = Math.hypot(actor.x - nearX, actor.z - nearZ)
    // Insertion sort into the slots: at four entries this beats allocating and
    // sorting a list every frame.
    let at = filled
    while (at > 0 && distance < slotDistance[at - 1]!) at--
    if (at >= PUSHER_SLOTS) continue
    for (let i = Math.min(filled, PUSHER_SLOTS - 1); i > at; i--) {
      slots[i]!.copy(slots[i - 1]!)
      slotDistance[i] = slotDistance[i - 1]!
    }
    slots[at]!.set(actor.x, actor.feetY, actor.z)
    slotDistance[at] = distance
    if (filled < PUSHER_SLOTS) filled++
  }
  for (let i = filled; i < PUSHER_SLOTS; i++) slots[i]!.set(PUSHER_AWAY, PUSHER_AWAY, PUSHER_AWAY)
}

/**
 * Where blades start dissolving and where they are gone, in world units from
 * the camera. `MazeScene`'s `DETAIL_RADIUS` mounts grass two chunks out (64
 * units at the nearest edge), so the fade has to finish inside that or the
 * meadow pops in at the ring instead of arriving already faded.
 */
export const GRASS_FADE_START = 50
export const GRASS_FADE_END = 62
/** Tallest blade in the tuft, the divisor that turns local height into the
 *  0..1 factor the wind and push are shaped by. Keep it in step with the
 *  `length` roll below. */
const TIP_HEIGHT = 0.42

/**
 * Density falls with distance. Every tuft carries a rank in 0..1, its index in
 * the patch, and survives while the share kept at its own distance is above
 * that rank, shrinking to nothing as it crosses. Tufts that remain spread wider
 * to hold the cover. Because rank is index order, a patch can also stop drawing
 * at the share kept at its *nearest* point: everything past that index has
 * already shrunk away, so `updateGrassLod` saves the vertex work without a pop.
 */
const KEEP_START = 10
const KEEP_END = 42
const KEEP_FAR = 0.08
const KEEP_MARGIN = 1.06
const grassKeep = (distance: number) => 1 - (1 - KEEP_FAR) * smoothstep(KEEP_START, KEEP_END, distance)

/** Trim a patch's instance count to what can still be standing, given the
 *  camera. Call once a frame per mounted patch; it is a few multiplications. */
export function updateGrassLod(mesh: InstancedMesh, cameraX: number, cameraZ: number) {
  const { total, centerX, centerZ, halfX, halfZ } = mesh.userData.grass as GrassPatchData
  const world = mesh.matrixWorld.elements
  const dx = Math.max(Math.abs(cameraX - centerX - world[12]!) - halfX, 0)
  const dz = Math.max(Math.abs(cameraZ - centerZ - world[14]!) - halfZ, 0)
  mesh.count = Math.min(total, Math.ceil(total * grassKeep(Math.hypot(dx, dz)) * KEEP_MARGIN))
}

interface GrassPatchData {
  total: number
  centerX: number
  centerZ: number
  halfX: number
  halfZ: number
}

/**
 * A tuft of curved, tapered blades fanning outward, with a soft base-to-tip
 * gradient and coherent GPU wind. Geometry and material are shared by every
 * patch drawn from this bank, so a patch costs exactly one draw call and the
 * whole meadow compiles one program.
 */
export function createGrassBank(time: { value: number }) {
  const color = new Color()
  let seed = 57281
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const BLADES = 10
  for (let blade = 0; blade < BLADES; blade++) {
    // Blades stand on a disc rather than fanning out of one point, mostly
    // upright and each facing its own way: a tuft is a clump from every angle,
    // where a fan read as a dark star from above.
    const spot = blade * 2.399 + random() * 0.6
    const reach = Math.sqrt((blade + 0.5) / BLADES) * 0.17
    const rootX = Math.cos(spot) * reach
    const rootZ = Math.sin(spot) * reach
    const facing = random() * Math.PI * 2
    const lean = 0.04 + random() * 0.13
    const length = 0.24 + random() * 0.18
    const width = 0.034 + random() * 0.02
    const shade = random()
    const base = positions.length / 3
    // Two quads' worth of height in five vertices: base, waist, tip.
    for (const [t, taper] of [[0, 1], [0.5, 0.72], [1, 0]] as const) {
      const bend = lean * t * t
      const x = rootX + Math.cos(spot) * bend
      const z = rootZ + Math.sin(spot) * bend
      for (const side of taper ? [-1, 1] : [0]) {
        const across = side * width * taper
        positions.push(x + Math.cos(facing) * across, t * length, z + Math.sin(facing) * across)
        // Not a colour: height along the blade and the blade's own shade. The
        // shader builds the colour from the ground under the tuft.
        colors.push(t, shade, 0)
      }
    }
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geometry.setIndex(indices)
  // Broad upward normals give the blades a continuous meadow response to
  // sunlight, avoiding alternating dark paper faces as the camera rotates.
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  const material = new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 1 })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.landscapeTime = time
    shader.uniforms.grassPushers = pushers
    shader.uniforms.grassDry = { value: MEADOW_PALETTE.dryGrass }
    shader.uniforms.grassLush = { value: MEADOW_PALETTE.lush }
    shader.uniforms.grassStraw = { value: MEADOW_PALETTE.straw }
    shader.uniforms.grassHighland = { value: MEADOW_PALETTE.highland }
    shader.vertexShader = `${/* glsl */ `
      uniform float landscapeTime;
      uniform vec3 grassPushers[${PUSHER_SLOTS}];
      uniform vec3 grassDry;
      uniform vec3 grassLush;
      uniform vec3 grassStraw;
      uniform vec3 grassHighland;
      varying float vGrassFade;

      float grassHash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      // Value noise, smoothstep-interpolated. Cheap, and all the gust envelope
      // needs: it only has to be continuous and slow.
      float grassNoise(vec2 p) {
        vec2 cell = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = grassHash(cell);
        float b = grassHash(cell + vec2(1.0, 0.0));
        float c = grassHash(cell + vec2(0.0, 1.0));
        float d = grassHash(cell + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
    `}\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        // Chunk meshes sit at their chunk's origin and their instances are
        // chunk-local, so neither the instance matrix nor the model matrix
        // alone is a world position. Wind phase, the push radius and the fade
        // all read the same composed frame.
        #ifdef USE_INSTANCING
          mat4 grassModel = modelMatrix * instanceMatrix;
        #else
          mat4 grassModel = modelMatrix;
        #endif
        mat3 grassBasis = mat3(grassModel);
        float grassScale = max(length(grassBasis[0]), 1e-4);
        // The tuft's own origin: phase comes from here, never from the vertex,
        // so a whole tuft leans as one piece.
        vec3 grassRoot = grassModel[3].xyz;
        vec3 grassWorld = (grassModel * vec4(transformed, 1.0)).xyz;
        // 0 at the root, 1 at a tall blade's tip. Squared, so the roots stay
        // planted and only the upper blade travels.
        float grassUp = clamp(position.y / ${TIP_HEIGHT.toFixed(3)}, 0.0, 1.0);
        float grassBend = grassUp * grassUp;

        const vec2 grassWindDir = vec2(0.8575, 0.5145);

        // Layer 1 — the prevailing sway, a travelling wave along the wind with
        // a standing lean under it, so the meadow never reads as still.
        float grassSwayPhase = dot(grassRoot.xz, grassWindDir) * 0.32 - landscapeTime * 1.15;
        vec2 grassWind = grassWindDir * (0.55 + 0.45 * sin(grassSwayPhase)) * 0.05;

        // Layer 2 — gusts, gated by a slow low-frequency envelope drifting
        // downwind over world xz. That envelope is what makes a gust front you
        // can watch roll across the field rather than a uniform shimmer.
        float grassGustEnvelope = grassNoise(grassRoot.xz * 0.045 - grassWindDir * landscapeTime * 0.35);
        grassGustEnvelope = smoothstep(0.34, 0.78, grassGustEnvelope);
        float grassGustPhase = dot(grassRoot.xz, grassWindDir) * 0.55 - landscapeTime * 2.2;
        grassWind += grassWindDir * sin(grassGustPhase) * grassGustEnvelope * 0.11;

        // Layer 3 — per-tuft turbulence, hashed off the root so neighbours
        // break up instead of marching in lockstep.
        float grassTurbPhase = landscapeTime * 2.7 + grassHash(grassRoot.xz) * 6.2831853;
        grassWind += vec2(sin(grassTurbPhase), cos(grassTurbPhase * 0.73)) * (0.006 + grassGustEnvelope * 0.012);

        // World-space wind, scaled with the tuft so a knee-high clump leans
        // further than an ankle-high one.
        vec3 grassOffset = vec3(grassWind.x, 0.0, grassWind.y) * grassBend * grassScale;

        // Bodies push the blades away radially, in world units, and press them
        // down a little so a trampled patch reads flattened rather than fanned.
        for (int i = 0; i < ${PUSHER_SLOTS}; i++) {
          vec2 grassAway = grassRoot.xz - grassPushers[i].xz;
          float grassReach = length(grassAway);
          if (grassReach >= ${PUSH_RADIUS.toFixed(3)}) continue;
          float grassContact = 1.0 - smoothstep(${(PUSH_CONTACT * 0.55).toFixed(3)}, ${PUSH_CONTACT.toFixed(3)}, abs(grassPushers[i].y - grassRoot.y));
          if (grassContact <= 0.0) continue;
          float grassPush = 1.0 - grassReach / ${PUSH_RADIUS.toFixed(3)};
          grassPush *= grassPush * grassContact * grassBend;
          vec2 grassDir = grassReach > 1e-3 ? grassAway / grassReach : vec2(1.0, 0.0);
          grassOffset += vec3(grassDir.x * grassPush * 0.5, -grassPush * 0.22, grassDir.y * grassPush * 0.5);
        }

        // Fade out before the detail ring ends, and shrink on the way so the
        // dither reads as the meadow thinning rather than blinking off.
        vGrassFade = 1.0 - smoothstep(${GRASS_FADE_START.toFixed(1)}, ${GRASS_FADE_END.toFixed(1)}, distance(cameraPosition, grassWorld));
        transformed *= mix(0.45, 1.0, vGrassFade);

        // instanceColor is data here, not a tint: rank, lushness, straw.
        #ifdef USE_INSTANCING_COLOR
          vec3 grassData = instanceColor;
        #else
          vec3 grassData = vec3(0.0, 1.0, 0.0);
        #endif
        // Thin with distance, measured at the root so a tuft shrinks whole.
        float grassKeep = 1.0 - ${(1 - KEEP_FAR).toFixed(3)} * smoothstep(${KEEP_START.toFixed(1)}, ${KEEP_END.toFixed(1)}, distance(cameraPosition.xz, grassRoot.xz));
        transformed *= smoothstep(0.0, 0.06, grassKeep * ${KEEP_MARGIN.toFixed(2)} - grassData.x);
        transformed.xz *= 1.0 + (1.0 - grassKeep) * 0.8;

        // The terrain's own pigment recipe (groundColor in terrainChunk):
        // roots take the ground's colour, tips lift toward the light.
        vec3 grassGround = mix(mix(grassDry, grassLush, grassData.y), grassStraw, grassData.z);
        float grassFar = smoothstep(45.0, 145.0, distance(grassRoot.xz, vec2(${LANDSCAPE_CENTER.toFixed(1)})) - ${LANDSCAPE_EXPANSION.toFixed(1)});
        grassGround = mix(grassGround, grassHighland, grassFar * 0.42);
        vec3 grassTip = grassGround * 1.18 + vec3(0.0, 0.05, 0.0);
        vColor.rgb = mix(grassGround * 0.8, grassTip, color.r) * (0.82 + color.g * 0.3);

        // Back into the instance's own frame: the matrix is a Y rotation times
        // a uniform scale, so its inverse is the transpose over the scale
        // squared, which is what these three dots are.
        transformed += vec3(dot(grassBasis[0], grassOffset), dot(grassBasis[1], grassOffset), dot(grassBasis[2], grassOffset)) / (grassScale * grassScale);
      `)
    shader.fragmentShader = `varying float vGrassFade;\n${shader.fragmentShader}`
      // Blades are lit by one broad upward normal. DoubleSide would flip it on
      // back faces and leave half the blades lit from below, so flip it back.
      .replace('#include <normal_fragment_begin>', /* glsl */ `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
        #endif
      `)
      .replace('void main() {', /* glsl */ `void main() {
        // Screen-door dissolve. Interleaved gradient noise over gl_FragCoord
        // scatters the discarded pixels evenly, so the blades thin out without
        // a transparent pass, without sorting, and with depth writes intact.
        float grassDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        if (vGrassFade < grassDither) discard;
      `)
  }
  material.customProgramCacheKey = () => 'courtyard-meadow-grass-v5'

  const dummy = new Object3D()
  return {
    /** One instanced patch. The caller owns removing and disposing it; the
     *  geometry and material stay with the bank. */
    patch(blades: readonly GrassBlade[]): InstancedMesh | null {
      if (!blades.length) return null
      const mesh = new InstancedMesh(geometry, material, blades.length)
      blades.forEach((blade, i) => {
        dummy.position.set(blade.x, blade.y, blade.z)
        dummy.rotation.set(0, blade.angle, 0)
        dummy.scale.setScalar(blade.size)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        // Data for the shader, not a tint: rank, lushness, straw.
        mesh.setColorAt(i, color.setRGB((i + 0.5) / blades.length, blade.lush ?? 1, blade.straw ?? 0))
      })
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const blade of blades) {
        minX = Math.min(minX, blade.x)
        maxX = Math.max(maxX, blade.x)
        minZ = Math.min(minZ, blade.z)
        maxZ = Math.max(maxZ, blade.z)
      }
      mesh.userData.grass = { total: blades.length, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2, halfX: (maxX - minX) / 2, halfZ: (maxZ - minZ) / 2 } satisfies GrassPatchData
      mesh.receiveShadow = true
      // A whole meadow of blades in three cascades buys nothing, and the swayed
      // vertices are not in the depth material anyway.
      mesh.castShadow = false
      mesh.userData.shadowTagged = true
      // Blades are flat cards; GTAO's opaque normal override would occlude with
      // them as solid quads.
      mesh.userData.gtaoExclude = true
      mesh.computeBoundingSphere()
      // The sphere is fitted to the *undisplaced* instances, and the shader
      // moves blades after that: a gust carries a tall tuft's tip about
      // 0.17 units per unit of scale, and a body pushes half a unit further.
      // Pad for both, or a patch at the edge of the frustum culls while its
      // blades are still on screen.
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 1.2
      return mesh
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

export type GrassBank = ReturnType<typeof createGrassBank>
