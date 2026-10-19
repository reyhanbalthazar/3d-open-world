// Nature models from Quaternius' Ultimate Stylized Nature pack (CC0) that the world uses.
// Plain data, shared by scripts/prepare-nature-assets.ts (which builds the files under
// public/models/nature/) and the browser loader in lib/nature.ts.
//
// The pack ships some models only as OBJ, without texture references; their materials are
// matched to textures by name through OBJ_MATERIALS.

export const NATURE_DIR = "/models/nature";

export const NATURE_MODELS = {
  birch_tree_1: "gltf",
  birch_tree_2: "gltf",
  birch_tree_3: "gltf",
  birch_tree_4: "gltf",
  birch_tree_5: "gltf",
  maple_tree_1: "gltf",
  maple_tree_2: "gltf",
  maple_tree_4: "gltf",
  maple_tree_5: "gltf",
  dead_tree_1: "gltf",
  dead_tree_2: "gltf",
  dead_tree_5: "gltf",
  dead_tree_9: "gltf",
  bush: "gltf",
  bush_flowers: "gltf",
  bush_large: "gltf",
  bush_large_flowers: "gltf",
  bush_small: "gltf",
  bush_small_flowers: "gltf",
  flower_1_clump: "gltf",
  flower_2_clump: "gltf",
  flower_3_clump: "gltf",
  flower_4_clump: "gltf",
  flower_5_clump: "gltf",
  grass_large: "gltf",
  grass_small: "gltf",
  pine_tree_1: "obj",
  pine_tree_2: "obj",
  pine_tree_3: "obj",
  pine_tree_4: "obj",
  pine_tree_5: "obj",
  normal_tree_5: "obj",
  rock_1: "obj",
  rock_2: "obj",
  rock_3: "obj",
  rock_4: "obj",
  rock_5: "obj",
  plant_1: "obj",
  plant_2: "obj",
  plant_flowers: "obj",
} as const satisfies Record<string, "gltf" | "obj">;

export type NatureModelId = keyof typeof NATURE_MODELS;

// OBJ material name -> texture in NATURE_DIR/textures. Cutout materials are alpha-tested foliage.
export const OBJ_MATERIALS: Record<string, { texture: string; cutout?: boolean }> = {
  PineTree_Bark: { texture: "pine_tree_bark.jpg" },
  PineTree_Leaves: { texture: "pine_tree_leaves.png", cutout: true },
  NormalTree_Bark: { texture: "normal_tree_bark.jpg" },
  NormalTree_Leaves: { texture: "normal_tree_leaves.png", cutout: true },
  Rock: { texture: "rocks.jpg" },
  Flowers: { texture: "flowers.png", cutout: true },
};
