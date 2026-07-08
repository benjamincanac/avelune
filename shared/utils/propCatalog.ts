/**
 * The GLB template name lists, shared between the scene renderer
 * (`MazeScene.vue`, which loads each name from `/models/<dir>/<name>.glb`) and
 * the dev prop editor (which offers them as a placeable palette and validates
 * saves against `ALL_PROP_KINDS`). A prop `kind` is exactly a GLB basename; the
 * directory is implied by which list it appears in.
 *
 * These lists were factored out of `MazeScene.vue` verbatim — the renderer
 * imports them straight back, so its loading behavior is unchanged.
 */

/**
 * Quaternius "Ultimate Modular Ruins" props (CC0), converted from .blend to
 * GLB by scripts/convert_props.py. The hub gets a fixed arrangement; floors
 * get deterministic biome-flavored scatter.
 */
export const PROP_NAMES = [
  'Statue_Fox', 'Statue_Stag', 'Cart', 'Crate', 'Barrel', 'Chest', 'Flag_Wall',
  'Bricks', 'Skull', 'Pot1_Broken', 'Pot2_Broken', 'Column_Round_Short',
  'Bush_1x1', 'Bush_Round', 'Grass', 'DeadTree_1', 'Candles_1',
  // Structural modules
  'Floor_Standard', 'Floor_Squares', 'Floor_Diamond', 'Floor_SquareLarge',
  'Arch_Gothic', 'Arch_Round', 'Column_Round', 'Column_Square',
  'Support_Center', 'Support_Left', 'Support_Right', 'Support_Tall',
  'Rail_Straight', 'Curve_1_Overgrown', 'Curve_2_Overgrown', 'Torch',
  // Tower-interior masonry + fittings
  'Wall', 'Wall_Half', 'Wall_ArchRound', 'Wall_Broken', 'Wall_Hole', 'Window_Open',
  'Doors_GothicArch', 'Doors_RoundArch', 'Stairs', 'Stairs_2', 'Rail_Corner', 'Rail_Divider',
  'Bookcase_Full', 'Bookcase_Empty', 'Chest_Gold', 'Pot1', 'Pot2', 'Pot3',
  'Candles_2', 'Trapdoor', 'Arch_Gothic_RoundColumn',
  // Structural additions (floors, wall/window variety incl. the Verdant
  // overgrown set, curved corners, extra arches/doors) — eager so the first
  // complete floor paint isn't missing panels.
  'Floor_Hole_Corner', 'Floor_Hole_Straight', 'Floor_Standard_Half', 'Floor_Tree',
  'Wall_ArchGothic', 'Wall_ArchRound_Broken', 'Wall_Overgrown',
  'Wall_ArchRound_Overgrown', 'Wall_ArchRound_Overgrown_Broken',
  'Window_Bars', 'Window_Bars_Overgrown', 'Curve_1', 'Curve_2',
  'Arch_Round_RoundColumn', 'Doors_GothicArch_Covered', 'Doors_RoundArch_Covered',
] as const

/**
 * Purely-decorative Ruins props (banners, ground-hazard clutter, the water
 * bridge, extra scatter). Deferred to the post-hub load phase alongside the
 * fantasy furniture so they don't delay the first structural paint — a missing
 * banner or bush just pops in on the follow-up rebuild.
 */
export const PROP_DECOR_NAMES = [
  'Flag_GothicArch', 'Flag_RoundArch', 'Flag_Wall2',
  'BearTrap_Closed', 'BearTrap_Open', 'BridgeSection', 'Column_BridgeSupport',
  'Pot3_Broken', 'DeadTree_2', 'DeadTree_3', 'Bush_2x1', 'Bush_2x2', 'Bush_Large',
] as const

/**
 * Quaternius CC0 MegaKit models for the nature-village hub, optimized to GLB by
 * scripts/convert_kits.sh. Nature dresses the meadow; village builds the tower
 * cap, house facades, and plaza props. Loaded into the same template map.
 */
export const NATURE_NAMES = [
  'CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'Pine_1', 'Pine_2',
  'Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3', 'Pebble_Round_1', 'Pebble_Round_2',
  'Bush_Common', 'Bush_Common_Flowers', 'Grass_Common_Tall', 'Grass_Wispy_Tall',
  'Fern_1', 'Clover_1', 'Flower_3_Group', 'Plant_1', 'Mushroom_Common',
] as const
export const VILLAGE_NAMES = [
  // Tower cap + house gable roofs (named by the footprint they cover).
  'Roof_Tower_RoundTiles', 'Roof_RoundTiles_4x4', 'Roof_RoundTiles_4x6',
  'Roof_RoundTiles_6x4', 'Roof_RoundTiles_6x6', 'Roof_RoundTiles_6x8',
  'Roof_Front_Brick4', 'Roof_Front_Brick6', 'Roof_Dormer_RoundTile', 'Roof_Wooden_2x1',
  // House shells: stone ground floor, timber upper floor, gate arch.
  'Wall_UnevenBrick_Straight', 'Wall_UnevenBrick_Window_Wide_Round', 'Wall_UnevenBrick_Door_Round',
  'Wall_Plaster_Straight', 'Wall_Plaster_Window_Wide_Round', 'Wall_Plaster_Door_Round',
  'Wall_Plaster_WoodGrid', 'Wall_Arch', 'Corner_Exterior_Wood', 'Corner_Exterior_Brick',
  'Balcony_Simple_Straight', 'Door_1_Round', 'Window_Wide_Round1', 'WindowShutters_Wide_Round_Open',
  // Dressing: chimneys, vines, market + street furniture, curb edging.
  'Prop_Chimney', 'Prop_Chimney2', 'Prop_Vine1', 'Prop_Vine2', 'Prop_Vine4',
  'Prop_Wagon', 'Prop_WoodenFence_Single', 'Prop_Crate', 'Prop_Support',
  'Prop_ExteriorBorder_Straight1',
] as const

/**
 * Quaternius "Fantasy Props MegaKit" (CC0) furniture, optimized to GLB by
 * scripts/convert_fantasy.sh. These dress the tower-interior labyrinth floors —
 * bookcases, banners, chandeliers, chests, forge gear — themed per biome by
 * `scatterInterior`. Loaded into the shared template map from /models/fantasy.
 */
export const FANTASY_NAMES = [
  'Bookcase_2', 'Chair_1', 'Bench', 'Stool', 'Bed_Twin1',
  'Chandelier', 'CandleStick', 'CandleStick_Triple',
  'Chest_Wood', 'Crate_Wooden',
  'Banner_1', 'Banner_2', 'WeaponStand', 'Sword_Bronze', 'Shield_Wooden',
  'Cauldron', 'BookStand', 'Book_Stack_1', 'Coin_Pile', 'Coin_Pile_2',
  'Cabinet', 'Shelf_Simple', 'Lantern_Wall', 'Torch_Metal', 'Rope_1',
  'Anvil', 'Workbench', 'Cage_Small', 'Vase_2', 'Potion_1', 'Scroll_1', 'Table_Large',
] as const

/** A palette section: a human label + the model dir + the kinds it offers. */
export interface PropCategory {
  label: string
  dir: string
  names: readonly string[]
}

/**
 * The editor palette, grouped by source kit. Every kind here has a GLB under
 * `/models/<dir>/` and is loaded into the scene's template map by `MazeScene`,
 * so the editor can clone any of them without loading anything itself.
 */
export const PROP_CATALOG: PropCategory[] = [
  { label: 'Nature', dir: 'nature', names: NATURE_NAMES },
  { label: 'Village', dir: 'village', names: VILLAGE_NAMES },
  { label: 'Ruins', dir: 'props', names: PROP_NAMES },
  { label: 'Ruins decor', dir: 'props', names: PROP_DECOR_NAMES },
  { label: 'Fantasy', dir: 'fantasy', names: FANTASY_NAMES },
]

/** Every valid prop kind — the allow-list the save route validates against. */
export const ALL_PROP_KINDS: ReadonlySet<string> = new Set(
  PROP_CATALOG.flatMap(c => c.names as readonly string[]),
)
