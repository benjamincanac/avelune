/**
 * The GLB template name lists `ArenaScene.vue` loads from `/models/<dir>/<name>.glb`.
 * A prop `kind` is exactly a GLB basename; the directory is implied by which list it appears in.
 * Only kinds referenced by the arena JSON download; the rest is the catalog of converted kits.
 */

/**
 * Quaternius "Ultimate Modular Ruins" props (CC0), converted from .blend to
 * GLB by scripts/convert_props.py. Every piece is hand-placed in the arena JSON —
 * nothing here is scattered procedurally.
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
  // Masonry + fittings
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
 * Purely-decorative Ruins props (banners, clutter, bridge sections, extra
 * scatter). Deferred to the post-arena load phase alongside the fantasy
 * furniture so they don't delay the first structural paint — a missing banner or
 * bush just pops in on the follow-up rebuild.
 */
export const PROP_DECOR_NAMES = [
  'Flag_GothicArch', 'Flag_RoundArch', 'Flag_Wall2',
  'BearTrap_Closed', 'BearTrap_Open', 'BridgeSection', 'Column_BridgeSupport',
  'Pot3_Broken', 'DeadTree_2', 'DeadTree_3', 'Bush_2x1', 'Bush_2x2', 'Bush_Large',
] as const

/**
 * Quaternius CC0 MegaKit models, optimized to GLB by scripts/convert_kits.sh.
 * Nature dresses the meadow the stadium stands on; the village kit is converted
 * but currently unplaced. Loaded into the same template map.
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
 * scripts/convert_fantasy.sh. Interior furniture — bookcases, banners,
 * chandeliers, chests, forge gear — available for dressing the arena. Loaded
 * into the shared template map from /models/fantasy.
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

/**
 * Quaternius "Modular Dungeon" (2019, CC0) interior kit, converted from .blend
 * to prefixed GLB by scripts/convert_new_kits.py. Every filename carries the
 * `Dungeon_` prefix so its kind can't collide with the Ruins/Fantasy kinds
 * (Torch, Barrel, Crate, Chest, Column, Wall, Skull, Coin_Pile, …). Loaded from
 * /models/dungeon.
 */
export const DUNGEON_NAMES = [
  'Dungeon_Arch', 'Dungeon_Arch_Door', 'Dungeon_Arch_Door_bottompivot', 'Dungeon_Arch_bars',
  'Dungeon_Bag_Coins', 'Dungeon_Bag_Standing', 'Dungeon_Banner', 'Dungeon_Banner_wall',
  'Dungeon_Barrel', 'Dungeon_Barrel2', 'Dungeon_Brick', 'Dungeon_Bucket',
  'Dungeon_Chair', 'Dungeon_Chest', 'Dungeon_Chest_Gold', 'Dungeon_Cobweb',
  'Dungeon_Cobweb2', 'Dungeon_Coin_Pile', 'Dungeon_Column', 'Dungeon_Column2',
  'Dungeon_Crate', 'Dungeon_Decorative_Wall', 'Dungeon_Fence_90_Modular', 'Dungeon_Fence_End_Modular',
  'Dungeon_Fence_Straight_Modular', 'Dungeon_Floor_BricksSeparate', 'Dungeon_Floor_BricksSeparate2', 'Dungeon_Floor_Modular',
  'Dungeon_Pedestal', 'Dungeon_Pedestal2', 'Dungeon_Skull', 'Dungeon_Spikes',
  'Dungeon_Stairs_Modular', 'Dungeon_Stairs_SideCover', 'Dungeon_Stairs_SideCoverWall', 'Dungeon_Statue_Horse',
  'Dungeon_Sword_WallMount', 'Dungeon_Table_Big', 'Dungeon_Table_Small', 'Dungeon_Torch',
  'Dungeon_Trap_empty', 'Dungeon_Trap_spikes', 'Dungeon_Trapdoor', 'Dungeon_Trapdoor_open',
  'Dungeon_Vase', 'Dungeon_WallCover_Modular', 'Dungeon_Wall_Modular', 'Dungeon_Woodfire',
] as const

/**
 * Quaternius "Modular Medieval Buildings" (2017, CC0) exterior fortification
 * kit — towers, wall panels, gatehouse entrance pieces — converted to prefixed
 * GLB by scripts/convert_new_kits.py. Loaded from /models/castle.
 */
export const CASTLE_NAMES = [
  'Castle_Banner', 'Castle_Bridge', 'Castle_Door', 'Castle_Dummy',
  'Castle_LargeSimpleTower', 'Castle_LargeSquareTower', 'Castle_LargeSquareTowerBricks', 'Castle_LargeTower',
  'Castle_PointyTower', 'Castle_SimpleTowerBricks', 'Castle_Simpletower', 'Castle_SmallSquareTower',
  'Castle_SmallSquareTowerBricks', 'Castle_SmallTower', 'Castle_TallWall', 'Castle_TallWallBricks',
  'Castle_TallWallEntrance', 'Castle_Target', 'Castle_TargetWithArrows', 'Castle_Tower',
  'Castle_Tunnel', 'Castle_Wall', 'Castle_WallBricks', 'Castle_WallEntrance',
  'Castle_WallEntranceBricks', 'Castle_WatchTowerWRoof', 'Castle_Watchtower', 'Castle_Well',
  'Castle_WindowGothic', 'Castle_WindowSquare',
] as const

/**
 * Quaternius "Modular Medieval Buildings" (2018, CC0) crypt interior kit —
 * modular stone walls, columns, sarcophagus/entrance framing, bones, potions —
 * converted to prefixed GLB by scripts/convert_new_kits.py. Loaded from
 * /models/crypt.
 */
export const CRYPT_NAMES = [
  'Crypt_Barrel', 'Crypt_Bars', 'Crypt_Bones', 'Crypt_Bones2',
  'Crypt_Book2', 'Crypt_Book3', 'Crypt_Book_Open', 'Crypt_Candelabrum',
  'Crypt_Candelabrum_tall', 'Crypt_Candle', 'Crypt_Carpet', 'Crypt_Chest',
  'Crypt_Chest_gold', 'Crypt_Column', 'Crypt_Column_Broken', 'Crypt_Column_Broken2',
  'Crypt_Entrance', 'Crypt_Entrance2', 'Crypt_ModularColumn_bottom', 'Crypt_ModularColumn_middle',
  'Crypt_ModularColumn_top', 'Crypt_ModularFloor', 'Crypt_ModularStoneWall', 'Crypt_ModularStoneWall_EntranceTop',
  'Crypt_ModularStoneWall_top', 'Crypt_Potion', 'Crypt_Potion2', 'Crypt_Potion3',
  'Crypt_Potion4', 'Crypt_Potion5', 'Crypt_Potion6', 'Crypt_Rock1',
  'Crypt_Rock2', 'Crypt_Rock3', 'Crypt_Rock4', 'Crypt_Rock5',
  'Crypt_Stairs', 'Crypt_Torch', 'Crypt_Torch_wall', 'Crypt_WallRocks',
  'Crypt_Window',
] as const
