# Open world plan

Turn Avelune from one bundled town into a persistent world players terraform and build in, with the town kept as a protected region at the centre. Six phases, each shippable on its own. Decisions are made here so the phases can start without re-discussing them.

## What exists and what has to change

| Today | Problem | Change |
| --- | --- | --- |
| One `FloorPlan` from `generateHub()`, 144×144 flat `Uint8Array`, built once at boot on both sides (`server/utils/game.ts:59`, `MazeScene.vue:132`) | Fixed size, immutable, flat | `World` of 32×32 chunks, lazily generated, mutable, streamed |
| Ground is 0 except hardcoded moat and fountain functions | No terrain concept | Per-tile-corner heightmap in each chunk, bilinear `terrainHeight()` |
| `plan.props` is one flat array scanned 4 to 5 times per `stepBodyOnce` (`maze.ts:337`, `maze.ts:447`) | O(props) per substep, no spatial index | Props bucketed per chunk, queries read the 3×3 neighbourhood |
| `buildFloor()` clears and rebuilds the entire scene, one `InstancedMesh` per kind for the whole world (`MazeScene.vue:214`, `:238`) | Any edit rebuilds everything | Per-chunk groups, rebuilt per chunk |
| `courtyardLandscape.ts` draws a decorative heightfield with no collision | Visual only, keyed to town constants | Deleted, replaced by real terrain chunks |
| `state` frames go to every socket, `welcome` carries no geometry | No interest management, no world on the wire | Chunk streaming around each player, `state` filtered by distance |
| Only write path is the dev-only file save (`server/api/editor/save.post.ts`) | No runtime persistence, prod FS read-only | Upstash Redis, one key per chunk, write-behind |
| Zod bounds `[-4, 200]`, `COURTYARD`/`FORTIFICATIONS` constants used by minimap, sky lanterns, moat, tests | Town coordinates assumed to be the world | Town keeps its coordinates. World extends around it. |

## Decisions

**World coordinates.** 1 tile = 1 unit, unchanged. The town stays at 0..144 so nothing authored moves. The world is bounded to 32×32 chunks (1024×1024 tiles) centred on the town, from -440 to 584 on both axes. Chunk keys can be negative. Bounds are constants and can grow later.

**Chunk.** 32×32 tiles. Stores heights on tile corners as a 33×33 `Int16Array` in 0.05 unit steps (border row and column duplicate the neighbour, server keeps both in sync on edit), a 32×32 `Uint8Array` surface type (grass, dirt, stone, sand, path, water), a props array of `WorldPlacement`, and a `version` counter. About 3 KB per chunk in memory and on the wire before compression.

**Terrain shape.** Heights are continuous and interpolated bilinearly. Slopes steeper than 1.2 units per tile block movement, which is how cliffs and terraces work without a voxel model. Terraform tools move corner heights by 0.25 per click with a 1×1 to 3×3 brush, plus flatten and paint.

**Placements.** Same record as today plus identity:

```ts
interface WorldPlacement extends HubPropPlacement {
  id: string      // nanoid, unique in the world
  owner?: string  // player id; absent for generated and town pieces
}
```

`z` for kit pieces is gameplay elevation, computed by the server at place time as the terrain height under the piece, or the top of the piece it is stacked on. This generalises the rampart rule where `z` is elevation.

**Protected region.** Every chunk overlapping the fortification exterior (4..140) is locked: terrain flat at 0, moat and fountain keep their hardcoded height functions, no player edits. Town props are seeded into those chunks from the existing JSON at boot. The dev editor keeps authoring the town exactly as now.

**Generation.** Outside the town, chunks are generated on first touch by a deterministic `generateChunk(seed, cx, cy)` in `shared/`: fractal-ridge heights (port of `courtyardLandscape.ts:52`), surface from slope and height, trees, bushes and rocks from the existing nature kit as removable props. The same function runs in tests. The client never generates; it always receives.

**Build kit.** Twelve pieces in the existing art style, 2 unit grid, quarter turn rotations: `Kit_Wall`, `Kit_WallWindow`, `Kit_WallDoor`, `Kit_Floor`, `Kit_Roof`, `Kit_RoofCorner`, `Kit_Stairs`, `Kit_Fence`, `Kit_Gate`, `Kit_Torch`, `Kit_Path`, `Kit_Crate`. Each gets a `COURTYARD_ASSETS` entry so `makeProp` gives collision for free. Stacking works through the existing ledge logic.

**Authority and validation.** Unchanged principle. Every edit is a client request the server validates and applies to its chunk, then broadcasts to sessions that have the chunk loaded. Rules: within 6 tiles of the player, not in a protected chunk, height delta ≤ 0.25 per op, 8 edits per second per player, no overlap with solid pieces, 500 pieces per player, only the owner or nobody-owned pieces can be removed, no terraform under a piece.

**Interest management.** Each session has a loaded chunk set: the 5×5 chunks around the player, sent on welcome and as the player crosses chunk borders, dropped at distance 4. `state` frames per session contain only players within 96 tiles. `join`/`leave` stay global so chat and the Oracle keep the full roster.

**Persistence.** Upstash Redis through the Vercel marketplace. One key per chunk, `chunk:<cx>:<cy>`, holding a binary blob (heights, surface, props JSON), plus `version`. Dirty chunks are flushed every 5 seconds and on shutdown with a compare-and-set on `version`. A CAS failure reloads the chunk and logs at error level. Unvisited chunks have no key and are generated. Player positions are not persisted; everyone spawns at the town.

**Single instance.** The design assumes one live server instance, same as the roster today. Two instances would each have their own live players and chunk cache. CAS keeps the store consistent but players on different instances would not see each other. Sharding stays in ROADMAP stretch. Verifying the Vercel WebSocket upgrade under load (ROADMAP §1) is a prerequisite for shipping any of this.

**Input model.** Build and terraform work Minecraft style from the pointer-locked crosshair: a ray from the camera hits terrain or a piece, the target tile is highlighted, click applies the active hotbar tool. No cursor, no free camera. The dev editor is untouched.

## Shared API after the change

`shared/utils/maze.ts` keeps its function names so call sites in `game.ts` and `MazeScene.vue` change only their first argument.

```ts
interface World {
  chunkSize: 32
  bounds: { minCx: number, maxCx: number, minCy: number, maxCy: number }
  getChunk(cx: number, cy: number): Chunk | undefined
  start: { x: number, y: number }
}

terrainHeight(world, x, y): number          // bilinear, -Infinity outside loaded chunks
surfaceHeight(world, x, y, feet): number    // max(terrain, moat/fountain specials, prop tops in 3×3 chunks)
isWalkable(world, x, y): boolean            // in bounds, chunk loaded, slope ok, not inside a solid prop
stepBody(world, body, dx, dy, dt)           // unchanged signature otherwise
propsNear(world, x, y, r): Iterable<PropSpec>
occupancyGrid(chunk): Uint8Array            // per chunk, for the minimap
applyTerrain(chunk, edit) / applyPlace(chunk, piece) / applyRemove(chunk, id)  // pure, used by both sides
```

`ramparts.ts` indexes per chunk instead of per plan. `moat.ts` and `courtyard.ts` are unchanged; the specials only apply inside the protected region.

## Protocol additions (`shared/types/game.ts`)

Client → server:

```ts
| { t: 'terraform', x: number, y: number, mode: 'raise' | 'lower' | 'flatten' | 'paint', size: 1 | 2 | 3, surface?: Surface }
| { t: 'build', kind: string, x: number, y: number, rot: number }
| { t: 'demolish', id: string }
```

Server → client:

```ts
| { t: 'chunk', cx: number, cy: number, v: number, h: string, s: string, props: WorldPlacement[] }  // h, s base64
| { t: 'unchunk', cx: number, cy: number }
| { t: 'terrain', cx: number, cy: number, v: number, edits: [i: number, h: number][], surface?: [i: number, s: number][] }
| { t: 'place', cx: number, cy: number, v: number, piece: WorldPlacement }
| { t: 'remove', cx: number, cy: number, v: number, id: string }
| { t: 'reject', reason: string }
```

`welcome` gains `world: { chunkSize, bounds, seed }`. `state` is unchanged in shape, filtered in content. Versions let the client detect a missed delta and request a resend by ignoring it and waiting for the next `chunk`.

## Phases

### Phase 1. World model and physics (world-sim)

Replace `FloorPlan` with `World` and chunks. No protocol change: both sides still build the full world locally from the seed plus town JSON, so the game plays exactly as before but the meadow outside the walls is real, collidable terrain.

- `shared/utils/world.ts`: `Chunk`, `World`, `createWorld`, `generateChunk`, `seedTown` (town JSON into protected chunks), `applyTerrain`, `applyPlace`, `applyRemove`, chunk key helpers, binary encode and decode.
- `shared/utils/maze.ts`: `terrainHeight`, chunk-neighbourhood prop queries, slope rule in `isWalkable`, `surfaceHeight` and `stepBody` on `World`. Delete `generateHub` and the flat `tiles` grid; `HUB_LAYOUT` becomes world bounds.
- `shared/utils/ramparts.ts`: index per chunk.
- `server/utils/game.ts` and `MazeScene.vue`: swap `PLAN`/`hubPlan` for a `World` built the same way. `MiniMap.vue` samples chunks.
- Tests: port `world-test.ts` and `rampart-test.ts` to `World`. Add terrain tests: bilinear height, slope blocking, terraform then walk, determinism (`createWorld` twice deep-equal, `generateChunk` stable), encode round trip. Wire a `pnpm test` script running the three `jiti` files.
- Delete `hub-*.json` (dead, confirm first).

Done when: `pnpm test`, typecheck and lint pass, and a bot walked out of the gate stands on a hill.

### Phase 2. Terrain rendering (scene-3d)

- `app/utils/terrainChunk.ts`: one `Mesh` per chunk from the 33×33 heights, vertex colours by surface type blended with the triplanar `townMaterials` pigment, normals recomputed on edit, through `shadows.ts` and the GTAO exclusion flags.
- `app/utils/chunkProps.ts`: per-chunk `InstancedMesh` per kind, rebuilt when that chunk's props change. `instantiateModule` from `MazeScene.vue:327` moves here.
- `MazeScene.vue`: `floorGroup` becomes `Map<chunkKey, Group>`. `buildFloor()` only rebuilds the town's cosmetic `createCourtyardScene` on editor changes. Chunks mount and unmount as the client's loaded set changes.
- Delete the heightfield and vegetation half of `courtyardLandscape.ts`; the nature kit now comes from chunk props. `cityMoat.ts` and `courtyardScene.ts` stay as the town's special render.
- Minimap draws terrain colour and occupancy per chunk, range no longer tied to `COURTYARD`.

Done when: the view from the walls matches today's meadow and the driver screenshot from `run-mmo` looks right in all four time-of-day modes.

### Phase 3. Streaming and terraform (server-net, world-sim, game-ui)

- `server/utils/world.ts`: chunk cache, lazy generate, dirty set, per-session loaded set, `sendChunksAround(session)` on welcome and border crossing, `unchunk` at distance 4.
- `game.ts`: `state` filtered by distance per session; `terraform` handler with the validation rules, apply, broadcast `terrain` to sessions holding the chunk. Rate limiter shared with `build`.
- `app/composables/useWorld.ts`: non-reactive chunk map fed by `useGame`, implements `World`. Prediction and camera use it. Missing chunk under the player is treated as blocked so nobody falls through during a late load.
- Hotbar with shovel tools, target tile highlight, click to send `terraform`. Optimistic local apply, reconciled by the server delta.
- `ws-test.mjs` gains a terraform round trip and a chunk-on-welcome assertion. `spawn-bots.mjs` gets a `--dig` flag.

Done when: two browsers terraform the same hill and both see it, and 50 bots at 20 Hz keep the tick under 10 ms.

### Phase 4. Building (assets, scene-3d, game-ui, server-net)

- Twelve kit GLBs through the existing Blender and `gltf-transform` pipeline, under 100 KB each, catalogued in `COURTYARD_ASSETS` and `propCatalog`.
- `build` and `demolish` handlers: reach, overlap, stacking height, ownership, budget.
- Client ghost: the armed kind's template rendered translucent at the snapped target, green or red by a client-side overlap check, rotation on `R`. Demolish targets the crosshair piece with the existing bounding-box pick from `hubEditor.ts:245`.
- Hotbar pages: tools, kit. Piece count shown in the HUD.

Done when: a player builds a two-storey house with a door and stairs, walks in and up, another player sees it, and cannot remove it.

### Phase 5. Persistence (server-net)

- `@upstash/redis`, `UPSTASH_REDIS_REST_URL` and token in runtime config. Local dev without the env falls back to in-memory only.
- Load chunk from Redis on first touch, else generate. Write-behind every 5 s and on `SIGTERM`. CAS on version.
- `scripts/world-admin.mjs`: export, import, wipe a chunk range, reset the world.

Done when: build, redeploy, build is still there. Two instances started locally against the same Redis never corrupt a chunk.

### Phase 6. Polish and follow-ups

- Ownership plots: a placed `Kit_Deed` claims a 16×16 area where only the owner edits.
- Oracle `arena_state` gains nearby structure counts and the busiest builder.
- Bots that build, for load tests.
- Update `.claude/agents/world-sim.md`, `scene-3d.md`, `server-net.md` for the chunk contracts and move this file's status into ROADMAP.

## Effort

| Phase | Sessions | Mostly |
| --- | --- | --- |
| 1 | 2 | world-sim |
| 2 | 2 | scene-3d |
| 3 | 2 | server-net, game-ui |
| 4 | 3 | assets, game-ui |
| 5 | 1 | server-net |
| 6 | 2 | mixed |

Phases 1 and 2 can run in parallel on the shared `World` interface once it is written. 3 depends on 1. 4 depends on 2 and 3. 5 depends on 3. Roughly two weeks of iteration, and the town is never broken in between because every phase ends with the current game still playable.

## Risks

- **Vercel WebSocket upgrade** is still unverified in prod. Everything here rests on it. Verify before Phase 3.
- **Single instance.** If Vercel spins up a second instance under load, players split. Redis CAS protects data, not the experience.
- **Welcome payload.** 25 chunks at 3 KB is 75 KB per join. Acceptable. If it grows, send the 3×3 first and the ring after.
- **Nitro beta dev server** crash-loops under GLB bursts today. Chunk streaming adds no GLB loads, but verify with a prod build as the run-mmo skill already says.
- **Style seam** between the authored town and player builds. The kit must come from the same Blender palette and `townMaterials` overlay, or it will read as two games.
