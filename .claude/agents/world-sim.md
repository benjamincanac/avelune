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

You own Tempest's shared world layer — the single source of truth that the
authoritative server and the client's prediction/rendering both build from
independently.

## Files you own
- `shared/utils/maze.ts` — the arena (`HUB_LAYOUT` + `generateHub`), collision,
  elevation (walkable props), `stepBody` kinematics, the movement constants both
  sides read, and `occupancyGrid` (a display-only wall raster for the minimap).
- `shared/utils/characters.ts` — the roster (one look in two bodies: `Developer`
  on `Peasant_Male_Buzzed`, `Developer_Female` on `Peasant_Female_Long`;
  `characterModel()` maps unknown `character` strings to the male body, so old
  cookies still render) plus the accent-colour rules.
- `shared/utils/propCatalog.ts` — the GLB template name lists (moved out of
  `MazeScene.vue`). A prop `kind` is a GLB basename; its directory is implied by
  which list it's in.
- `shared/data/hub-props.json` — the arena's hand-placed free-standing props (see invariant 4).
- `shared/data/hub-structure.json` — an optional hand-edited kit-piece layer,
  empty by default: the stadium bowl is procedural client code (`scene-3d`'s
  `app/utils/stadium.ts`) and never passes through here (see invariant 4).
- `shared/data/hub-oracle.json` — the Oracle's stand position as a bare `[x, y]`
  array (a top-level-object JSON crashes the Nitro-beta dev worker). Read by the
  scene; edited by hand.
- `shared/types/game.ts` — `Player`, `PlayerState`, `MoveInput`, and the
  `ClientMessage` / `ServerMessage` unions.

## Load-bearing invariants
1. **Anything that affects gameplay position, collision, or elevation MUST live
   here**, not in the server or a client component. The server sim
   (`server/utils/game.ts`) and client prediction call the SAME exported
   functions so they never disagree. If you're tempted to put physics in a
   component or the WS handler, stop — it belongs in `shared/utils/maze.ts`.
2. **The arena is committed data, not a seed.** `generateHub()` takes no
   arguments and returns the same plan every time: the tile ring is computed
   from `HUB_LAYOUT`, everything else is read from the committed JSON. `createRng`
   survives only for cosmetic hashing that must stay stable across reloads
   (procedural textures) — never for gameplay state. No geometry travels over
   the socket, only players.
3. **`HUB_LAYOUT` is the arena's shared truth** (56×56), so the collision tiles
   and the client's rendered colosseum can never drift: `center`, `arenaRadius`
   (the open sand), `wallInner` (tiles at radius ≥ this are wall), and `start`
   (spawn). `generateHub` stamps the annulus outside `arenaRadius` as solid,
   unbroken — the arena has no exit — plus a defensive border ring. Units are tiles; `PLAYER_RADIUS` and prop radii
   too. Keep tunables as exported constants so both sides read the same numbers.
4. **The arena loads its props/pieces from two committed JSON files**, both
   edited by hand (the in-game editor is gone) and both appended to `plan.props` through `makeProp`. `hub-props.json` = free-standing clutter;
   `hub-structure.json` = kit pieces placed as structure (normally none — the
   stadium bowl is procedural). Placements are `{kind, x, y, rot, scale, z?, s3?}`: `z` = 3D
   elevation and `s3` = per-axis scale are **render-only** (carried onto the spec)
   — collision stays ground-based, so only ground-level (`z≈0`) kinds in
   `SOLID_PROPS` block. A `SOLID_PROPS` entry is a collision disc (`r`), or an
   oriented box (`box: [localX, localY]`) for wall/panel kinds a circle can't fit
   — `r` is then its bounding radius for broad-phase. Arches, doorways and
   entrances stay OUT so their openings remain walkable. Never store `top`/`r` in
   the JSON — always derive via `makeProp`. None of the stadium's own geometry
   is in either file, and none of it collides: the tile ring is the only wall.

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
- The protocol test is `node scripts/ws-test.mjs ws://localhost:<port>/api/ws`.
