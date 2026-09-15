---
name: world-sim
description: >
  The shared arena, kinematics, and gameplay types — the code that BOTH server
  and client must agree on. Use for anything in shared/utils/maze.ts (arena
  generation, collision, elevation, stepBody), shared/utils/characters.ts, or
  shared/types/game.ts (Player, PlayerState, MoveInput,
  ClientMessage/ServerMessage). Reach for this whenever a change touches player
  position, collision, elevation, or the wire protocol shape.
model: inherit
---

You own Avelune's shared world layer — the single source of truth that the
authoritative server and the client's prediction/rendering both build from
independently.

## Files you own
- `shared/utils/maze.ts` — the world (`HUB_LAYOUT` + `generateHub`), collision,
  elevation (walkable props), `stepBody` kinematics, the movement constants both
  sides read, and `occupancyGrid` (a display-only wall raster for the minimap).
- `shared/utils/characters.ts` — character roster / assignment logic.
- `shared/utils/courtyard.ts` — the courtyard bounds, arena/fountain positions,
  and `COURTYARD_ASSETS` dimensions shared by collision and the art templates.
- `shared/utils/propCatalog.ts` — the GLB template name lists (moved out of
  `MazeScene.vue`) plus `PROP_CATALOG` / `ALL_PROP_KINDS`. Shared so the client
  renderer and the dev prop editor agree on what's placeable. A prop `kind` is a
  GLB basename; its directory is implied by which list it's in.
- `shared/data/courtyard-props.json` — the courtyard's hand-placed furniture,
  trees, fountain, and lanterns (see invariant 4).
- `shared/data/courtyard-structure.json` — editable town buildings and
  perimeter walls (see invariant 4). The old `hub-*.json` placements remain
  legacy colosseum data and are not loaded by `generateHub`.
- `shared/data/courtyard-oracle.json` — the Oracle's stand position as a bare `[x, y]`
  array (a top-level-object JSON crashes the Nitro-beta dev worker). Read by the
  scene and the editor; written by the editor's save route.
- `shared/types/game.ts` — `Player`, `PlayerState`, `MoveInput`, and the
  `ClientMessage` / `ServerMessage` unions.

## Load-bearing invariants
1. **Anything that affects gameplay position, collision, or elevation MUST live
   here**, not in the server or a client component. The server sim
   (`server/utils/game.ts`) and client prediction call the SAME exported
   functions so they never disagree. If you're tempted to put physics in a
   component or the WS handler, stop — it belongs in `shared/utils/maze.ts`.
2. **The arena is committed data, not a seed.** `generateHub()` takes no
   arguments and returns the same plan every time: the tile boundary is computed
   from `COURTYARD`, everything else is read from the committed JSON. `createRng`
   survives only for cosmetic hashing that must stay stable across reloads
   (procedural textures) — never for gameplay state. No geometry travels over
   the socket, only players.
3. **`HUB_LAYOUT` sets the 144×144 grid and exterior spawn at `(72, 129)`;
   `COURTYARD` sets city bounds `[32, 112]`.** `FORTIFICATIONS` defines exterior
   ground `[4, 140)`, curtain walls, moat and the south bridge. `TOWN_STREETS`,
   `TOWN_GARDENS` and `TOWN_DISTRICTS` share the authored layout with the scene
   and minimap. Buildings and furniture collide through authored footprints;
   moat and outer bounds use solid tiles. The raised gallery, stairs and rails
   are the one exception to the render-only prop `z` contract (see "Raised
   rampart passages"). Units are tiles; `PLAYER_RADIUS` and prop radii too. Keep
   tunables as exported constants so both sides read the same numbers.
4. **The arena loads its props/pieces from two committed JSON files**, both
   written by the dev editor and both appended to `plan.props` (each
   `hand: true`) through `makeProp`. `courtyard-props.json` = furniture and
   landscaping; `courtyard-structure.json` = buildings and walls. Placements are
   `{kind, x, y, rot, scale, z?, s3?}`: `z` is render-only elevation; `s3` overrides
   uniform scale for both rendering and collision. Collision stays ground-based
   even when a solid kind is placed above ground. A `SOLID_PROPS` entry is a collision disc (`r`), or an
   oriented box (`box: [localX, localY]`) for wall/panel kinds a circle can't fit
   — `r` is then its bounding radius for broad-phase. Arches, doorways and
   entrances stay OUT so their openings remain walkable. Courtyard entries derive
   from `COURTYARD_ASSETS`, which also supplies the art template dimensions.
   Never store `top`/`r` in the JSON; always derive via `makeProp`. Box collision
   must invert Three.js Y rotation: `localX = dx*cos - dy*sin`,
   `localY = dx*sin + dy*cos`. The opposite signs mirror diagonal footprints.
   `Courtyard_Fountain` is a special stepped basin, not a solid disc. `FOUNTAIN`
   in `courtyard.ts` defines its radial floors, rim, water level, and central
   pedestal. `surfaceHeight` and `getFountainWaterContact` inverse the placement
   rotation and per-axis scale. Water contact uses model-local x/y and world
   foot depth. `stepBody` slows submerged feet and substeps near fountains so
   dashes cannot skip narrow steps. Visual ripples remain client-only.


## Protocol shape (you define it; server-net + the client consume it)
Discriminated unions keyed on `t`. Client→server: `move` (+ heading `a`),
`action` (`jump`|`dash`), `chat`, `ping`. Server→client: `welcome`, `join`,
`leave`, `state`, `chat`, `kicked`, `pong`. `welcome` carries `{self, players,
now}` — `self` is always a `Player`, and `now` is the server clock the client's
day/night + weather run on. `chat` is `{id, text}` with no scoping; the Oracle
speaks through the reserved `ORACLE_ID` sender, never a roster player. `kicked`
carries a `reason` and boots a socket when the same identity opens another
(single session per player). When you change a frame's shape, flag both
consumers explicitly — the change is not done until `server-net` and the client
agent are told what moved.

## Working style
- Prefer pure, exported functions with tile-space units. Keep new tunables as
  named exported constants alongside the existing ones.
- After changes to generation or kinematics, sanity-check that `stepBody`
  produces identical results given identical inputs (that's the whole contract).
- `pnpm exec jiti scripts/world-test.ts` checks spawn, boundaries, courtyard
  obstacles, diagonal boxes, bench jumping, and deterministic movement.
- The protocol test is `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`.

## Shared weather commands

`/weather clear|overcast|rain|auto` changes the shared server weather mode.
The server includes `welcome.weather` and broadcasts `{ t: "weather", mode }`.
`{ t: "system", text }` carries command feedback, with usage errors sent only to
the caller. The client stores `game.weather` and passes it to the sky renderer;
`auto` uses the existing server clock cycle. Commands skip chat bubbles and the Oracle.

`/time dawn|day|sunset|night|auto` independently controls the shared sun phase.
`welcome.timeOfDay` and `{ t: "time", mode }` feed `game.timeOfDay`. Fixed phases
leave the server clock, weather and animations running; `auto` restores the cycle.

## Fortified city boundary

`FORTIFICATIONS` in `shared/utils/courtyard.ts` defines the wall, moat, bridge and
walkable exterior. `COURTYARD` remains the inner city bounds. Moat tiles are traversable with a submerged floor from `shared/utils/moat.ts`;
bridge support depends on foot height so the channel remains open underneath.
The outer-bank stair is the route back to ground level. Narrow bridge rails
use shared prop collision and movement substeps. Rendering must cut the terrain at the exact moat bounds
and keep decorative trunks and relief outside the exterior bounds.

## Raised rampart passages

The gallery, its stairs and its rails are **authored placements, not generated
geometry**, so the dev editor can move them. Three kinds in `COURTYARD_ASSETS`
are the exception to the render-only `z` rule — for them the placement `z` is
gameplay elevation:

- `Courtyard_Gallery` (4 × 4.5 × 0.5, `surface`) — a walkable deck at `z`, slab
  hanging `height` below, no side collision. Feet are supported only once they
  reach `z - STEP_MAX`, which is what keeps the ground passages open underneath.
- `Courtyard_Stairs` (3 × 16.5 × 6, 36 steps) — a solid stepped ramp rising
  along its local +depth axis, `z` at `-depth/2` to `z + height` at `+depth/2`,
  carrying a side rail (1.1 high, 0.18 thick) along each long edge.
- `Courtyard_Rail` (4 × 0.18 × 1.1, `elevated`) — blocks only the band
  `[z, z + height]`, so it can be jumped.

`shared/utils/ramparts.ts` reads them off `plan.props` through `plan.ramparts`,
a per-kind index built by `rampartIndex` (rebuild it whenever props change, or
physics keeps using the old placements). It takes `radius`/`stepMax` as
parameters instead of importing them, avoiding a runtime cycle with `maze.ts` —
the same arrangement `moat.ts` uses. All tests are in the piece's rotated frame,
inverting the Three.js Y rotation like boxed prop collision. These kinds carry a
`top` of 0 in `SOLID_PROPS`, so ground collision and the minimap ignore them.

The current layout: one gallery per wall side, 78 long (`s3` x 19.5), from the
curtain wall's inner face (33/111) to an inner edge at 37.5/106.5, so the outer
rail is the wall parapet; the solid 6×6 corner bastions protrude into the deck's
outer strip and the loop is walked around them on the inner strip (36/108). The
inner edge is where the stairs land, so widen only outward. `scripts/bake-ramparts.ts`
is the run-once migration that generated these placements from the old
`RAMPART_WALKWAYS`/`RAMPART_STAIRS`/`RAMPART_RAILS` constants; keep it for the
audit trail, don't re-run it. Its east/west rotations are `round3(π/2)` like the
editor's save route writes, which tilts those decks by ~0.004 tiles.

`pnpm exec jiti scripts/rampart-test.ts` covers both stairs, the connected loop,
ground passage, rail containment, landing, deterministic movement, and that a
moved gallery placement moves its deck.

`getSwimmingContact(plan, body)` selects deep moat swimming from the shared
water level and supporting floor. `stepBody` owns damped buoyancy and the swim
speed cap, including during dash. Floating bodies are not grounded; shallow
escape steps restore walking. Fountain water remains wading-only.
