---
name: world-sim
description: >
  The shared world, kinematics, and gameplay types — the code that BOTH server
  and client must agree on. Use for anything in shared/utils/world.ts (chunks,
  terrain, generation) or shared/utils/maze.ts (collision, elevation,
  stepBody), shared/utils/characters.ts, or
  shared/types/game.ts (Player, PlayerState, MoveInput,
  ClientMessage/ServerMessage). Reach for this whenever a change touches player
  position, collision, elevation, or the wire protocol shape.
model: inherit
---

You own Avelune's shared world layer — the single source of truth that the
authoritative server and the client's prediction/rendering both build from
independently.

## Files you own
- `shared/utils/world.ts` — the chunked `World`: `Chunk`, `createWorld`,
  `generateChunk`, `seedTown`, `applyTerrain` / `applyPlace` / `applyRemove`,
  `installChunk` / `removeChunk`, chunk key helpers, `encodeChunk` /
  `decodeChunk`, `WORLD_BOUNDS`.
- `shared/utils/voice.ts` — proximity voice's shared half: `selectVoicePairs` (who
  may hear whom, 24 tiles to connect and 30 to drop so a pair on the boundary is
  not rebuilt every pass, at most 6 listeners, applied nearest-first and
  **symmetrically**, because the server forwards both directions off one pair set
  and an asymmetric list would leave somebody talking into nothing), the binary audio
  layout both sides encode and decode (`encodeVoiceUp`/`decodeVoiceUp`,
  `encodeVoiceDown`/`decodeVoiceDown`, `voiceSeqDelta` for the 16-bit wrap), the
  token bucket, and the transcript filter the chat path uses. Nothing in here is
  client-only or server-only: the pairing rules and the frame layout are exactly
  the kind of thing the two sides must not each have their own copy of.
- `shared/utils/maze.ts` — physics over a `World`: `terrainHeight`, `propsNear`,
  `isWalkable`, `surfaceHeight`, collision, elevation (walkable props),
  `stepBody` kinematics, the movement constants both sides read, and
  `occupancyGrid` (a display-only wall raster, now per chunk, for the minimap).
- `shared/utils/terrain.ts` — the height field itself (`landscapeHeight`,
  `worldTerrainHeight(x, y, seed = WORLD_SEED)`) *and* the regional noise both it
  and `biome.ts` read. `WORLD_SEED` is declared here, the lowest layer that needs
  it. Terrain is **biome-aware**: `mountainUplift` is a continuous 0..1 field and
  the mountain amplitude, the crags and the heath's extra roll all multiply by it,
  so ranges rise and their foothills blend away smoothly. Everything blends on
  the *continuous field*, never on the discrete `Biome` label — threshold first
  and every border becomes a cliff. `biomeAt` thresholds the very same numbers,
  which is why a range's label and its shape cannot disagree.
  The town is untouched by all of it: inside `MEADOW_BELT` of `LANDSCAPE_CENTER`
  every relief term is gated to exactly zero, so the protected footprint, the
  flat square and their approach are the same heights they were before biomes
  existed (`scripts/terrain-test.ts` asserts that against a copy of the old
  field). Amplitudes are budgeted against `SLOPE_MAX`: a value-noise octave's
  steepest slope is `1.5 / lattice` per tile (a ridged one twice that), so a new
  term is sized from its lattice rather than by eye — a range has to be climbable
  along most routes, and a tile past `SLOPE_MAX` is a cliff face that no body
  walks up (see invariant 3).
- `shared/utils/props.ts` — `PropSpec`, `HubPropPlacement`, `WorldPlacement`,
  `SOLID_PROPS` and `makeProp`. Split out of `maze.ts` so `world.ts` (which
  buckets placements) and `maze.ts` (which queries them) share it without a
  runtime import cycle.
- `shared/utils/kit.ts` — `KIT_ASSETS`, the thirteen-piece dimension table that
  `snapGridFor` (`building.ts`) and the kit's stair spec (`ramparts.ts`) read,
  plus `KIT_NAMES`, `kitLabel` and `DEED_KIND`. It sits under `building.ts`
  rather than in it, so `world.ts` can index a deed post without importing the
  rules that decide what a plot means. The kit's collision entries in `props.ts`
  do **not** read it: `props.ts` imports only `courtyard.ts` and `ramparts.ts`,
  and its kit rows are hand-written literals restating the same numbers
  (`Kit_Wall` is 2 wide by 0.3 deep by 2.5 tall in both files). A kit dimension
  therefore has to change in both places, or collision keeps the old shape while
  the model and the snap grid move.
- `shared/utils/building.ts` — the pure edit rules both sides run: `EDIT_REACH`,
  `EDITS_PER_SECOND`, `MAX_PIECES_PER_PLAYER`, `BUILD_GRID`, `snapPlacement`,
  `overlappingPiece` (AABB plus the vertical band `[z, z + height]`, which is
  what lets pieces stack), `supportHeight` (a placed piece's `z`, bounded by the
  aim height below), `pieceOverBrush`, `isPlaceableKind`, `canRemove`, and the
  deed-plot rules below. The server decides with them; the client only colours
  its ghost preview with them. `snapGridFor(kind)` is the grid a piece snaps to:
  `BUILD_GRID` (2) for everything except pieces whose footprint fits in a tile (`Kit_Crate`, `Kit_Torch`, `Kit_Deed`), which get `BUILD_GRID_SMALL`
  (1) so two of them can sit side by side, and 0 for the free-standing nature
  kit. It is the footprint that decides and not a list of kinds, so a new small
  piece gets the small grid without a rule being touched. The client ghost must
  call it too or it previews a pose the server won't store.

  **Cells and edges.** A kit piece is either a cell piece or an edge piece, and
  `isEdgeKind(kind)` says which. Cell pieces (`Kit_Floor`, `Kit_Roof`,
  `Kit_RoofCorner`, `Kit_Stairs`, `Kit_Path`, `Kit_Crate`, `Kit_Torch`,
  `Kit_Deed`) snap to the CENTRE of a grid cell, as everything used to. Edge
  pieces — the panels: `Kit_Wall`, `Kit_WallWindow`, `Kit_WallDoor`,
  `Kit_Fence`, `Kit_Gate` — snap to the nearest cell EDGE (a half-grid line, so
  one coordinate is a multiple of the grid and the other is offset by half of
  it) and take their heading from that edge. `R` therefore no longer turns a
  panel: `snapPlacement` reads its `rot` only as a flip (every other quarter
  turn adds π), so the caller must hand it the RAW aim, never an already-snapped
  pose — re-snapping a pose reads its own heading back as a different flip.
  Both `resolveBuild` and the client ghost snap from the raw request.

  Panels meeting at a cell corner share exactly half a wall's depth there, which
  the old overlap test read as two walls fused. `overlapBounds` insets an edge
  piece's footprint by `EDGE_CORNER_INSET` (0.15, half of `Kit_Wall`'s depth) at
  each end of its run, and `overlappingPiece` and `supportHeight` both reason
  about that inset box: a corner is a join, so it neither refuses a build nor
  holds the next panel up a storey. `propBounds` and the physical collision
  boxes in `props.ts` stay exact, so four panels still seal a cell — the
  perpendicular neighbour covers precisely the strip the inset gave up.

  **Aim height.** A `build` request carries an optional `h`, the world height
  the client's ray hit. `supportHeight(world, prop, aim)` then answers with the
  highest surface under the footprint a body standing at `aim + AIM_SLACK`
  (0.3) could step onto, sampling `surfaceHeight(world, x, y, feet)` at the
  same centre-plus-inset-corners it always did. Without `h` it is the old rule,
  the highest surface anywhere under the footprint — which is what put a
  replaced ground-floor wall on the roof and a crate upstairs. `h` is a hint,
  never a position: the server still derives `z` from real surfaces, and
  `cleanAim` drops a non-finite one and clamps the rest, so the worst a client
  can do with it is get the old behaviour back. Once the support is chosen the
  band `[z, z + height]` has to be free (`overlappingPiece`) *and* fit under
  whatever hangs over it: `ceilingOver` refuses with `no room there` when a
  piece whose bottom is strictly above the candidate's cuts into the band.
  Touching exactly is clearance, so a 2.5 wall stands under a floor laid at 2.5.

  **Deed plots.** A `Kit_Deed` post (`DEED_KIND`, in `kit.ts` so `world.ts` can
  index it without importing the rules) claims the `DEED_SIZE` (16) tile square
  centred on its own tile, `DEED_LIMIT` (1) per player. `plotBounds` is
  half-open in tiles, so two plots exactly `DEED_SIZE` apart touch without
  overlapping. Inside a plot only the owner may terraform, build or demolish —
  unowned wild growth included. Outside every plot anyone may demolish any
  player's piece: `canRemove` only says whether a piece is removable at all
  (built by a player, or wild nature), and the plot is the sole protection. `checkDeedPlacement` refuses a post whose plot would overlap
  another player's plot, a protected tile, or a piece somebody else built; your
  own pieces are fine, so you can fence a house first and deed it after.
  `deedAt` / `plotOwner` / `foreignClaim` answer from `chunk.deeds`, a derived
  per-chunk index of the deeds a chunk *owns* (rebuilt from `placements`
  wherever they change, moves no version, never persisted or sent) — a claim
  query widens its box by a whole plot before reading it, because a deed
  `DEED_SIZE` tiles away still reaches in. `plotsOverlapping` is that widened
  query and `deedsInBox` in `world.ts` is the index it reads, the way
  `propsInBox` is for props. `isProtectedBox`, also in `world.ts`, is the box
  form of `isProtectedTile`, because a plot covers 256 tiles and testing them
  one at a time is not a per-frame answer. Pulling the deed releases the plot
  and leaves every piece where it stands: the claim is the post, not the ground.
  A refusal carries `claim` (the owner's *id*) alongside the generic
  `that plot is claimed`; `refusalText(verdict, names)` is what turns it into
  `that plot belongs to <name>`, and only a caller holding a roster can.
  **`propsInBox` answers by eight-tile index cell, so any rule reading it must
  re-test the exact footprint** — the plot's piece check did not, and claimed
  neighbours three tiles outside the square.
- `shared/utils/vegetation.ts` — `generateVegetation(seed, cx, cy)`, the
  deterministic nature scatter (trees and rocks solid, bushes walk-through) with
  `wild:<cx>:<cy>:<n>` ids so a felled tree never regrows under a new name. Each
  piece carries `z = worldTerrainHeight(x, y)` rounded to 2 decimals, so it
  collides at the height of the hill it grew on. The scatter is meadow, not
  woodland: a per-chunk copse centre makes trees cluster, and they are sparse
  everywhere else.
  Deliberately NOT inside `generateChunk`: the server's `loadChunk` applies it
  once per chunk, and the client receives the result as placements.
  The scatter is regional. `FLAVOURS` keys a per-biome table (families, copse
  odds, cover, scale) and every candidate asks `biomeAt` at **its own point**,
  never once per chunk, so a border cuts across a chunk instead of following the
  grid. Candidate `n` keeps its position and its `wild:` id whatever the biome:
  the denser biomes take the `INFILL` candidates appended after the original 26
  (`Flavour.infill`), and meadow's numbers are the original ones, so a chunk that
  is meadow throughout still generates exactly what it always did. The infill
  hash indices (`n * 7 + k`) must stay clear of the copse salts at `0x10D`, which
  caps the candidate total at 38. `BIOME_TREES` is the families by biome and
  `isWildTree` the whole set — never test a tree with `kind.startsWith('tree')`,
  pines and dead trunks are trees too. `TREELINE` and `BARREN_LINE` are altitude,
  not biome: above the treeline a candidate falls through to ground cover
  (boulders), above the bare line nothing grows, whatever country it stands in.
- `shared/utils/biome.ts` — `biomeAt(seed, x, y)` returning
  `'meadow' | 'forest' | 'pinewood' | 'grove' | 'heath' | 'mountain'`. Labels
  only: the fields it thresholds live in `terrain.ts` (two `REGION_SIZE`-lattice
  value-noise fields for the low country, `mountainUplift` for a range), because
  the height field has to read the same numbers and a label is the wrong thing to
  interpolate. Pure in world tile coordinates, no chunk grid and no world state,
  cheap enough per candidate point. Meadow is the largest share and is forced
  inside `MEADOW_BELT` of `LANDSCAPE_CENTER` so the approach to the walls never
  changes character. A range outranks the region fields, and the label threshold
  sits *above* the height onset on purpose: the foothills keep their neighbour's
  label, so a wood climbs into a range instead of stopping at its edge. Both
  sides hold the seed — `WORLD_SEED` as a constant, `welcome.world.seed` on the
  wire — so the client may call this freely, but only for cosmetics (ground
  scatter, ambient critters). A biome still decides nothing about collision,
  elevation or edit rules directly; it only tells generation what to plant, and
  the *ground* it plants on comes from `terrain.ts`, which is the server's.
  Widening this union breaks every `Record<Biome, …>` table in `app/**` — that is
  deliberate, and those are the rendering agent's to fill in.
- `shared/utils/characters.ts` — the character roster and everything that
  qualifies one: `OUTFITS`, `HAIRSTYLES`, `OUTFIT_COLORS`, `BEARD_MESH`, and the
  rules `canBeard` / `isBearded` / `isHairless` / `outfitColorCount` read.
  `Player.character`, `Player.outfitColor` and `Player.beard` are validated
  against this table, which is why it is shared and not the onboarding screen's.
- `shared/utils/courtyard.ts` — the courtyard bounds, arena/fountain positions,
  and `COURTYARD_ASSETS` dimensions shared by collision and the art templates.
- `shared/utils/moat.ts` — `MOAT` (the floor and water heights, the swim draft
  and speed, the bridge underside, and `bodyHeight`, which `maze.ts` re-exports
  as `BODY_HEIGHT`), `MOAT_STAIRS`, and the channel's geometry: `isOnMoatStairs`,
  `moatGroundHeight`, `moatWaterDepth` and `hitsMoatObstacle`, all four of which
  `maze.ts` imports. Nothing in here imports `maze.ts` back, so what a body
  brings to those functions arrives as an argument (`feet`, `radius`) rather
  than an import, the same arrangement `ramparts.ts` uses (see "Fortified city
  boundary").
- `shared/utils/ramparts.ts` — the height-aware kinds and the geometry of their
  decks, treads and rails (see "Raised rampart passages").
- `shared/utils/propCatalog.ts` — `PROP_CATALOG` and `ALL_PROP_KINDS`, composed
  from `COURTYARD_NAMES` (`courtyard.ts`) and `KIT_NAMES` (`kit.ts`). The name
  lists themselves live beside the dimensions they belong to, so a kind cannot
  be catalogued without a footprint. Shared so the client renderer and the dev
  prop editor agree on what's placeable. A prop `kind` is a GLB basename; its
  directory is implied by which list it's in. The nature kit is deliberately not
  in here: `NATURE_KINDS` in `building.ts` is what a player
  may plant. `ALL_PROP_KINDS` gates every kind the editor may save
  (`server/api/editor/save.post.ts`), courtyard pieces included; `isKitKind` is
  the caller that narrows it to the `Kit_` ones.
- `shared/utils/realm.ts` — `normalizeRealm` and `realmName`: the id every store
  key is scoped by, and the city name shown for it. It rides the wire as
  `welcome.world.realm`, which is why it is shared rather than the server's.
- `shared/data/courtyard-props.json` — the courtyard's hand-placed furniture,
  trees, fountain, and lanterns (see invariant 5).
- `shared/data/courtyard-structure.json` — editable town buildings and
  perimeter walls (see invariant 5). The legacy colosseum `hub-*.json` files are
  deleted.
- `shared/data/courtyard-oracle.json` — the Oracle's stand pose as a bare
  `[x, y, rot]` array (a top-level-object JSON crashes the Nitro-beta dev
  worker). Read by the scene and the editor; written by the editor's save route.
- `shared/types/game.ts` — `Player`, `PlayerState`, `MoveInput`, and the
  `ClientMessage` / `ServerMessage` unions.

## Load-bearing invariants
1. **Anything that affects gameplay position, collision, or elevation MUST live
   here**, not in the server or a client component. The server sim
   (`server/utils/game.ts`) and client prediction call the SAME exported
   functions so they never disagree. If you're tempted to put physics in a
   component or the WS handler, stop — it belongs in `shared/utils/maze.ts`.
2. **The world is a seed plus committed data, never a live download.**
   `createWorld()` seeds the authored town from the committed JSON into the
   town chunks and generates everything else lazily through
   `generateChunk(seed, cx, cy)`, which is pure: same coordinates in, same bytes
   out, on the server, in the client and in the tests. Only the server builds
   it; the client receives chunks over the socket (`chunk` / `terrain` /
   `place` / `remove` frames) and mirrors the server's edits with the same
   `applyTerrain` / `applyPlace` / `applyRemove`, so both sides still hold
   identical bytes. A chunk that arrives whole — off the wire, or out of the
   server's store — goes in through `installChunk`, which is the single place
   cross-chunk bucketing happens for a chunk nobody generated: it buckets the
   incoming placements outward into the loaded neighbours, adopts the long
   pieces those neighbours own inward, and rebuilds both rampart indexes. It
   refills a chunk already at those coordinates *in place*, because the server's
   dirty set and frame cache hold `Chunk` objects. `removeChunk` is its inverse
   and takes the loans back. Neither ever invents a neighbour: `bucket` lends
   only into chunks that already exist, so a streaming client can never generate
   terrain the server did not send it. `LEND_RADIUS` (2) is how far out the
   adopt and withdraw scans look, so it is also the real bound on how far a
   placement may reach: `bucket` will happily lend a piece wider than that into
   a chunk no later scan visits, and the loan would never come back.
   **`version` counts mutations of a chunk's own content — heights, surface,
   the placements it owns — exactly one per mutation.** Lending a piece to a
   neighbour or adopting one is derived index state and moves no version, which
   is why a straddling `applyPlace` bumps only the owner. That is what keeps a
   client's number from ever running ahead of the server's, and so what makes
   the client's "apply when newer" rule safe. `z` on a kit piece is gameplay elevation (its support
   height), like the rampart kinds.
   `createRng` survives only for cosmetic hashing that must stay stable across
   reloads (procedural textures) — never for gameplay state.
3. **The world is 32×32 chunks of 32 tiles, `-448..576` on both axes
   (`WORLD_BOUNDS`), and its edge is a hard wall.** A chunk holds 33×33 corner
   heights (`Int16Array`, 0.05 steps, the last row/column duplicating the
   neighbour), a 32×32 surface raster, its placements and a `version`.
   `surfaceFor` derives that raster from height and slope, so it needs no biome:
   `ROCK_LINE` (34) is bare rock and `SNOW_LINE` (50, hashed into a ragged band)
   is `SURFACE.snow`, both above the 31 the pre-mountain world ever reached, so
   nothing below the ranges changed colour. Snow is generated, never painted.
   `terrainHeight` interpolates bilinearly and returns `-Infinity` for a missing
   chunk, so an unloaded chunk reads as void rather than a hole to fall through.
   `isWalkable` blocks the world edge, missing chunks, and any tile whose local
   gradient exceeds `SLOPE_MAX` (1.2 per tile) — that is how cliffs work. That
   is the 2D answer, for bots, critters and the camera. A body is resolved by
   height: `isWalkableAt(world, tx, ty, feet)` opens a steep tile to feet at or
   above its highest corner minus `STEP_MAX`, the ledge rule a raised piece
   uses, so a jump clears a dug hole and walking off a cliff top is a fall. The
   world edge and a missing chunk stay walls at every height. `slideBody` passes
   `body.z` to `moveWithCollision`, which without a `feet` argument is still the
   2D wall. A body can therefore stand on a face, having landed on it or walked
   off its top, and `climbsSteepTile` in `canEnter` is what keeps the landing
   snap from carrying it up: below the tile's top band, a move that ends on
   higher terrain than it started from is refused, level and downhill never
   are. A face whose rise is within a jump (about 2 per tile) can be jumped,
   exactly like a pit rim of that depth. The two are the same geometry.
   **Every spatial query goes through the per-chunk cell index.** Props are
   bucketed into every chunk the square `prop.r` in each direction around them
   reaches (so a 78-tile gallery run is never missed), and inside each chunk into
   `chunk.cells`: 16 buckets of `CELL_SIZE` (8) tiles, one entry per cell that
   same square covers. `propsInBox(world, minX, minY, maxX, maxY)` in `world.ts`
   is the single primitive — it reads only the cells the box covers and stamps
   each spec (`PropSpec.mark`) so a prop comes back once per query.
   `propsNear(world, x, y, r)` in `maze.ts` is that box plus the old
   `hypot <= prop.r + r` disc test, and `overlappingPiece` / `pieceOverBrush` in
   `building.ts` call `propsInBox` with their own AABB. Nothing may scan a flat
   list of the world's props, or a whole chunk's `props`, in a physics path
   again: `chunk.props` stays the per-chunk list for renderers, the minimap
   raster and the tests. Cells are derived index state like `props` and
   `ramparts` — they move no version, are never persisted or sent, and are
   maintained wherever `chunk.props` is (`bucket`, `unbucket`,
   `adoptOverlapping`, `withdrawLent`, `installChunk`, `decodeChunk`). That
   index is what took `stepBody` from 1.18 ms to 0.35 ms per tick for 12 bodies
   among 400 kit pieces (`scripts/bench-step.ts`), and it is why the cost no
   longer tracks how built-up the neighbourhood is.
4. **The town is a protected footprint, not a chunk band.**
   `PROTECTED_FOOTPRINT` in `world.ts` hugs the geometry: the moat's outer
   square plus a 1-tile `TOWN_MARGIN` (`[22, 121]`), the bank stair with the
   same margin, and exactly the tiles under the bridge's landing (`x` `[68, 75]`,
   `y` `[121, 122]`). It is what the town *draws*: `isProtectedTile` gives those
   tiles the `path` surface, sinks their corners by `TOWN_CLEARANCE` and keeps
   props off them, so widening it would trench the meadow beside the road.
   **What an edit may touch is the wider question, and `editLock` answers it.**
   It returns `'town'` inside the footprint, `'gate'` inside `GATE_APPROACH` —
   the deck's width flared by `GATE_APPROACH_MARGIN` (4) on each side, running
   from the bridge's far end past the spawn (`x` `[64, 79]`, `y` `[123, 133]`) —
   and `null` everywhere else. `checkTerraform` / `resolveBuild` /
   `checkDeedPlacement` refuse on either (a brush is refused if any corner it
   writes lands inside); `checkDemolish` refuses only `'town'`, because a piece
   standing in the approach is in the way by definition and has to be
   removable. The approach is generated meadow that renders as meadow — no
   renderer reads it — and it exists because the bridge is the only way in, so
   one wall or one trench across its mouth would shut the town to everybody.
   `isTownChunk(cx, cy)` is the coarser fact: a chunk overlapping the footprint,
   seeded from the town JSON by `seedTown`, created up front and never evicted.
   Its tiles outside the footprint are ordinary editable ground.
   `isFlatTownGround` (the `[4, 140]` square) still shapes the *initial* terrain
   at height 0 so the ground outside the walls starts level, and it is what
   `generateVegetation` keeps clear, so the near-wall meadow stays open; but only
   footprint tiles get the `path` surface, the rest of the square is grass.
   The moat bed, its bank stair and the fountain basin are height-aware surfaces
   layered on top by `maze.ts`, not terrain. `HUB_LAYOUT` is now only the
   town's own 144-tile extent (the editor's bounds) plus the spawn at
   `(72, 129)`; `COURTYARD` sets city bounds `[32, 112]`. `FORTIFICATIONS`
   defines the level square `[4, 140]`, curtain walls, moat and the south
   bridge. `TOWN_STREETS`, `TOWN_GARDENS` and `TOWN_DISTRICTS` share the authored
   layout with the scene and minimap. Buildings and furniture collide through
   authored footprints. The raised gallery, stairs and rails
   are the one exception to the render-only prop `z` contract (see "Raised
   rampart passages"). Units are tiles; `PLAYER_RADIUS` and prop radii too. Keep
   tunables as exported constants so both sides read the same numbers.
5. **The town loads its props/pieces from two committed JSON files**, both
   written by the dev editor and both seeded into the town chunks (each
   `hand: true`, with a deterministic `town:<index>` id) through `makeProp`. `courtyard-props.json` = furniture and
   landscaping; `courtyard-structure.json` = buildings and walls. A stored
   placement is `{kind, x, y, rot, scale, z?, s3?}`; a `WorldPlacement` adds
   `{id, owner?}`: for these authored `town:<index>` pieces `z` is render-only
   elevation; `s3` overrides
   uniform scale for both rendering and collision. Collision stays ground-based
   even when a solid kind is placed above ground. **That render-only rule holds
   only for the town.** `propFromPlacement` keys off the `town:` id prefix (see
   `isTownPlacement`): every other placement — the build kit, generated
   vegetation, anything a player placed — reads `z` as gameplay elevation and
   gets a collision band (see "Elevation bands"). A `SOLID_PROPS` entry is a collision disc (`r`), or an
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


## Elevation bands

`PropSpec` carries three heights: `height` is the piece's own thickness (the
scaled `SOLID_PROPS` value), `top` is the **absolute** world height of its
walkable surface, and `base` is the absolute bottom of its collision band. A
hand-authored town piece has no `base` and `top === height`, exactly as before.
Everything else is banded at `[base, base + height]`, with `base = z`;
`elevateProp(prop, z)` is the one place that keeps `z`/`base`/`top` in step, and
`resolveBuild` calls it after choosing a piece's support height.

A banded piece is resolved by height, not by footprint alone:

- it **supports** feet at `feet >= top - STEP_MAX` — the same ledge rule a
  gallery deck uses, applied in `surfaceHeight` through `supportsFeet`;
- it **blocks** when the body's span `[feet, feet + BODY_HEIGHT]` overlaps the
  band and the feet have not reached the top. That is `hitsRaisedPiece`, which
  `stepBodyOnce` ORs into both axis tests. Ground-based pieces need no such test:
  they block by presenting a surface too tall to step onto;
- otherwise the body passes **underneath**, which is what makes a second-storey
  `Kit_Floor` a ceiling rather than a wall.

Those tests read the body's **centre**, which is what decides where feet stand.
The body's **width** is `hitsSolidPiece`: a disc of `PLAYER_RADIUS` against every
piece that is a wall at this height, ground-based or banded, so a character stops
at a facade instead of sinking a shoulder into it. It refuses only a move that
*deepens* an overlap, so a body already touching a wall can slide and walk away.
Slabs no thicker than `STEP_MAX` (a `Kit_Floor`) are exempt, or a stair tread
catches the landing slab's edge from below.

**Every horizontal displacement of a body goes through `slideBody`**, the
exported horizontal half of `stepBodyOnce`. The landing snap has no step limit
(terraforming can raise the ground under a player), so a centre that gets inside
a tall footprint is lifted to its roof. A raw `x += error` in the client's
reconcile did exactly that around building corners.

`BODY_HEIGHT` (= `MOAT.bodyHeight`) is the shared player height. `occupancyGrid`
rasters by `height`, not `top`, so a slab two storeys up is not a minimap wall.
`isPieceCameraBlocked` is the banded twin of `isRampartCameraBlocked` — the
client's boom must OR both, or it will clip through a raised floor.

Stepped ramps are a kind table in `ramparts.ts`, not a second code path:
`Courtyard_Stairs` and `Kit_Stairs` both go into a chunk's `ramparts.stairs`
(`isStairKind`), and `isHeightAwareKind` is what `maze.ts` and `world.ts` use to
keep them out of ordinary footprint collision. Kit stairs carry no rails
(`railHeight` 0).

## Protocol shape (you define it; server-net + the client consume it)
Discriminated unions keyed on `t`. Client→server: `move` (+ heading `a` and the held `sprint` flag; the speed factor is
shared `speedMultiplier`, never a constant inlined by a consumer),
`action` (`jump`|`dash`|`respawn`, the last one the way out of a hole and on its
own cooldown), `chat`, `ping`, `voice` (`{on}`, the opt-in switch only; the
audio itself is the binary channel in `voice.ts` and never JSON), and the edit
verbs `terraform` (a `TerraformKind` of `raise`|`lower`|`flatten`|`paint`, plus
the `surface` the painting one writes), `build` (with the optional aim height
`h`), `demolish`. Server→client: `welcome`, `join`, `leave`, `state`, `chat`,
`kicked`, `pong`, plus the world stream `chunk` (encoded heights/surface as
base64 and the chunk's placements), `unchunk`, `terrain` (`[cornerIndex,
int16Height][]` deltas, quantised exactly as `Chunk.heights`, plus
`[tileIndex, surface][]` deltas when the brush painted), `place`,
`remove`, `voice-peers` (who this player may hear and under which numeric talker
id their frames arrive, the whole set rather than a delta, so a client that
missed one converges anyway), and `reject`. `terrain` also carries optional `by` (the player whose
brush it was), `mode` and `at` (`[x, y]`): a height carries no owner the way a
placement does, so this is the only way the world feed can attribute ground
work, and a corner index is not a place anyone can read. `TERRAFORM_VERBS` is
how each mode gets worded for that feed, and `setSurface` in `world.ts` is the
one place a raster tile changes: it only marks its chunk touched, and
`applyTerrain` bumps each touched chunk once for the whole brush, however many
tiles it wrote. `welcome` carries
`{self, players, now, weather, timeOfDay, world, pieces, deeds, feed}` —
`self` is always a `Player`, `now` is the server clock the client's day/night +
weather run on, `weather` and `timeOfDay` are the shared overrides that clock
yields to (see "Shared weather commands"), `world` is `{chunkSize, bounds, seed, realm, persistent, streamed}` (`persistent` false on the in-memory store, shown as a sandbox warning in the HUD; `streamed` is how many chunks the server streams around a settled player, which the client cannot derive and the entry screen needs as a denominator), and `pieces` is how many
pieces this identity owns in the *whole* world (only the server can count that;
a client holds 25 chunks), and `deeds` how many plots they hold, counted the
same way. `feed` is the server's recent `WorldEvent` rows, newest first, which
the HUD feed starts from; after that the client words its own rows from the live frames. `place` and `remove` carry optional `pieces`/`deeds` with the same
meaning, present only on the copy sent to the player whose edit it was — every
other viewer gets the frame without them and ignores the fields. `state` is filtered
per session to players within 192 tiles; `join`/`leave` stay global. `chat` is `{id, text}` with no scoping, plus `voice` on a line the server transcribed from speech rather than read from a keyboard; the Oracle
speaks through the reserved `ORACLE_ID` sender, never a roster player, and its lines carry `to`, the id of the player it answers, which the scene turns the NPC to face. `kicked`
carries a `reason` and boots a socket when the same identity opens another
(single session per player). When you change a frame's shape, flag both
consumers explicitly — the change is not done until `server-net` and the client
agent are told what moved.

## Working style
- Prefer pure, exported functions with tile-space units. Keep new tunables as
  named exported constants alongside the existing ones.
- After changes to generation or kinematics, sanity-check that `stepBody`
  produces identical results given identical inputs (that's the whole contract).
- `pnpm test` runs `world-test.ts`, `rampart-test.ts`, `terrain-test.ts` and
  `building-test.ts` (and every other `scripts/*-test.ts`) through vitest. `building-test.ts` covers the elevation
  bands: a wild tree on a hill, a kit wall on a slope, walking under and
  standing on a stacked floor, climbing kit stairs onto a landing, and the
  stack-versus-overlap verdicts `resolveBuild` returns, the aim height (which
  storey a crate lands on, a ground-floor wall put back in its slot, the
  `no room there` refusal, and a bogus `h` being ignored or clamped), plus the
  per-piece snap grid, the footprint edge at the end of the gate bridge, and
  the gate approach refusing builds, digs and deeds while still allowing a
  demolish. `world-test.ts` checks spawn, the world edge, town obstacles,
  diagonal boxes, bench jumping and deterministic movement; `terrain-test.ts`
  covers bilinear heights, the slope rule, jumping over and out of a dug pit, the
  cliff face that cannot be walked up, terraform-then-walk, chunk-border
  sync, generation determinism, the encode round trip, and the protected
  footprint — that the road ends the drawn footprint while `editLock` keeps the
  approach and the spawn shut to edits, that the meadow past it is editable, and
  that the bank stair is still covered.
  `scripts/moat-test.ts`, `scripts/index-test.ts` and
  `scripts/character-animation-test.ts` also build a `World` and are run the
  same way; `index-test.ts` is the one that covers the per-chunk cell index and
  what a query must never miss. Two more build no world at all:
  `voice-test.ts` covers the pairing rules, the hysteresis and the frame layout
  round trip, and `character-test.ts` the outfit, hair and beard rules.
- The protocol test is `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`.

## Shared weather commands

Players change the shared sky by asking the Oracle: `oracleHears` reads the
request in its classifier pass and calls `setWeather` / `setTimeOfDay` in
`server/utils/game.ts`, and its reply is the announcement.
`/weather clear|overcast|rain|auto` is the same switch as a dev-only chat
command (`DEV_COMMANDS`: `import.meta.dev` or `AVELUNE_DEV_COMMANDS=1`), kept so
a harness can fix the sky without a model call.
The server includes `welcome.weather` and broadcasts `{ t: "weather", mode }`.
`{ t: "system", text }` carries command feedback, with usage errors sent only to
the caller. The client stores `game.weather` and passes it to the sky renderer;
`auto` uses the existing server clock cycle. Commands skip chat bubbles and the Oracle.

`/time dawn|day|sunset|night|auto`, dev-only too, independently controls the shared sun phase.
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

`shared/utils/ramparts.ts` reads them off each chunk's `ramparts`, a per-kind
index built by `rampartIndex` (`world.ts` rebuilds it whenever a chunk's props
change, or physics keeps using the old placements). It takes `radius`/`stepMax` as
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

`scripts/rampart-test.ts` covers both stairs, the connected loop,
ground passage, rail containment, landing, deterministic movement, and that a
moved gallery placement moves its deck.

`getSwimmingContact(world, body)` selects deep moat swimming from the shared
water level and supporting floor. `stepBody` owns damped buoyancy and the swim
speed cap, including during dash. Floating bodies are not grounded; shallow
escape steps restore walking. Fountain water remains wading-only.
