// Extra character animations from Mixamo, baked onto the game's rig by
// scripts/bake-mixamo-animations.ts into public/models/animations/<file>_<men|women>.json.
// Plain data, shared by that script and the browser loader in lib/character-models.ts.

export const ANIMATIONS_DIR = "/models/animations";

export const MIXAMO_ANIMATIONS = [
  // played once on Space. impactTime: when the swing lands (the right hand's fastest moment,
  // as measured by the bake script), which is when a held tool works on what is in front
  { name: "Slash", file: "slash", source: "adventurer_stable_sword_outward_slash.fbx", impactTime: 0.85 },
] as const;

export type MixamoAnimationName = (typeof MIXAMO_ANIMATIONS)[number]["name"];
