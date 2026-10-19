// Extra character animations from Mixamo, baked onto the game's rig by
// scripts/bake-mixamo-animations.ts into public/models/animations/<file>_<men|women>.json.
// Plain data, shared by that script and the browser loader in lib/character-models.ts.

export const ANIMATIONS_DIR = "/models/animations";

export const MIXAMO_ANIMATIONS = [
  // played once on Space
  { name: "Slash", file: "slash", source: "adventurer_stable_sword_outward_slash.fbx" },
] as const;

export type MixamoAnimationName = (typeof MIXAMO_ANIMATIONS)[number]["name"];
