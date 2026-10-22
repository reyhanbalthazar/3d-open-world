// Bakes Mixamo animations onto the rig the game's characters use.
//
// The FBX files are animated on Quaternius' *humanoid* rig (a plain FK chain), but the game loads
// the *IK* rig from individual_characters/gltf: it has an extra Body bone that the legs hang from,
// and the feet are IK targets under Root instead of children of the shins. So the clips cannot be
// played as-is. For every frame, each bone's rotation is taken relative to its bind pose in world
// space and applied to the matching bone of the IK rig. The vertical hip motion is scaled to the IK
// rig's hip height; horizontal hip motion is dropped so the move happens on the spot. The feet only
// get rotations: lib/character-models.ts pins them to the shins at runtime.
//
// One clip per skeleton (men and women differ in proportions), written as small JSON files so
// players never download the FBX.  Run after adding an animation:  npm run assets:animations

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MIXAMO_ANIMATIONS } from "../lib/animation-catalog.ts";

// three's FileLoader (used for the glTF's embedded buffers) reports progress with ProgressEvent,
// which only browsers have
globalThis.ProgressEvent ??= class extends Event {
  lengthComputable: boolean;
  loaded: number;
  total: number;
  constructor(type: string, init: ProgressEventInit = {}) {
    super(type);
    this.lengthComputable = init.lengthComputable ?? false;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
} as unknown as typeof ProgressEvent;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = join(ROOT, "public/ultimate_modular_men_feb_2022/humanoid_rig/individual_characters/fbx");
const OUT = join(ROOT, "public/models/animations");
const FPS = 30;

// one representative character per skeleton
const SKELETONS = [
  { group: "men", file: "public/ultimate_modular_men_feb_2022/individual_characters/gltf/adventurer.gltf" },
  { group: "women", file: "public/ultimate_modular_women_april_2022/individual_characters/gltf/casual.gltf" },
];

// IK rig bone -> humanoid rig bone. Body and Hips both follow the humanoid Hips: Body carries the
// legs and Hips the spine, which the humanoid Hips does on its own.
const BONE_MAP: Record<string, string> = {
  Body: "Hips",
  Hips: "Hips",
  Abdomen: "Abdomen",
  Torso: "Torso",
  Chest: "Chest",
  Neck: "Neck",
  Head: "Head",
  ShoulderL: "ShoulderL",
  UpperArmL: "UpperArmL",
  LowerArmL: "LowerArmL",
  WristL: "HandL",
  ShoulderR: "ShoulderR",
  UpperArmR: "UpperArmR",
  LowerArmR: "LowerArmR",
  WristR: "HandR",
  UpperLegL: "UpperLegL",
  LowerLegL: "LowerLegL",
  FootL: "FootL",
  UpperLegR: "UpperLegR",
  LowerLegR: "LowerLegR",
  FootR: "FootR",
};

function arrayBuffer(path: string) {
  const buffer = readFileSync(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function bone(root: THREE.Object3D, name: string) {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`Bone "${name}" not found`);
  return found;
}

const worldQuaternion = (object: THREE.Object3D) => object.getWorldQuaternion(new THREE.Quaternion());
const worldPosition = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());

// World-space bind pose of every skinned bone: the pose the mesh was modelled in. For the glTF rig
// this differs a lot from the nodes' default transforms (the arms by ~70 degrees), so rotations
// must be measured from here.
function bindPose(root: THREE.Object3D) {
  const poses = new Map<string, { quaternion: THREE.Quaternion; position: THREE.Vector3 }>();
  root.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    object.skeleton.bones.forEach((b, i) => {
      if (poses.has(b.name)) return;
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      object.skeleton.boneInverses[i].clone().invert().decompose(position, quaternion, new THREE.Vector3());
      poses.set(b.name, { quaternion, position });
    });
  });
  return poses;
}

mkdirSync(OUT, { recursive: true });

const targets = await Promise.all(
  SKELETONS.map(async (skeleton) => {
    const gltf = await new GLTFLoader().parseAsync(readFileSync(join(ROOT, skeleton.file), "utf8"), "");
    return { ...skeleton, gltf };
  }),
);

for (const animation of MIXAMO_ANIMATIONS) {
  const source = new FBXLoader().parse(arrayBuffer(join(SOURCE_DIR, animation.source)), "");
  const sourceClip = source.animations[0];
  source.updateMatrixWorld(true);
  const sourceBind = bindPose(source);
  const sourceRest = new Map(Object.values(BONE_MAP).map((name) => [name, sourceBind.get(name)!.quaternion]));
  // the foot bone's height when standing (bind pose) marks the floor
  const sourceFloorY = sourceBind.get("FootL")!.position.y;
  const sourceHipHeight = sourceBind.get("Hips")!.position.y - sourceFloorY;

  const mixer = new THREE.AnimationMixer(source);
  mixer.clipAction(sourceClip).play();

  for (const { group, gltf } of targets) {
    const model = gltf.scene.clone(true);
    model.updateMatrixWorld(true);

    // bones in parent-before-child order, so each one is solved after its parent has moved
    const depth = (object: THREE.Object3D): number => (object.parent ? depth(object.parent) + 1 : 0);
    const bones = Object.keys(BONE_MAP)
      .map((name) => bone(model, name))
      .sort((a, b) => depth(a) - depth(b));
    const targetBind = bindPose(gltf.scene);
    const targetRest = new Map(bones.map((b) => [b.name, targetBind.get(b.name)!.quaternion]));
    const targetFloorY = targetBind.get("FootL")!.position.y;
    const targetHipHeight = targetBind.get("Body")!.position.y - targetFloorY;
    const hipScale = targetHipHeight / sourceHipHeight;

    // Body's place as the game's own Idle animation puts it; only its height changes below
    const body = bone(model, "Body");
    const idleBody = gltf.animations.find((clip) => clip.name === "Idle")?.tracks.find((t) => t.name === "Body.position");
    const bodyStart = idleBody ? new THREE.Vector3().fromArray(idleBody.values, 0) : body.position.clone();
    body.position.copy(bodyStart);
    body.updateMatrixWorld(true);
    const bodyStartWorldY = worldPosition(body).y;

    // to check the result: each ankle in its shin's space, from the bind pose
    const bindMatrix = (name: string) => {
      const { position, quaternion } = targetBind.get(name)!;
      return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
    };
    const ankles = (["L", "R"] as const).map((side) => ({
      shin: bone(model, `LowerLeg${side}`),
      ankle: new THREE.Vector3()
        .setFromMatrixPosition(bindMatrix(`Foot${side}`))
        .applyMatrix4(bindMatrix(`LowerLeg${side}`).invert()),
    }));
    const lowestFoot: number[] = [];
    // wrist positions per frame, to find which hand swings and when it moves fastest (the hit)
    const wrists = { L: [] as THREE.Vector3[], R: [] as THREE.Vector3[] };

    const frames = Math.round(sourceClip.duration * FPS) + 1;
    const times: number[] = [];
    const rotations = new Map<string, number[]>(bones.map((b) => [b.name, []]));
    const bodyPositions: number[] = [];
    const delta = new THREE.Quaternion();
    const parentWorld = new THREE.Quaternion();

    for (let frame = 0; frame < frames; frame++) {
      const time = Math.min(frame / FPS, sourceClip.duration);
      times.push(time);
      mixer.setTime(time);
      source.updateMatrixWorld(true);

      // Hip height above the floor, scaled to the target's leg length. Absolute, not relative to
      // the first frame: a move that starts in a crouch (like the sword stance) must stay low.
      const bodyWorldY = targetFloorY + (worldPosition(bone(source, "Hips")).y - sourceFloorY) * hipScale;
      body.position.set(bodyStart.x, bodyStart.y + (bodyWorldY - bodyStartWorldY), bodyStart.z);
      bodyPositions.push(...body.position.toArray());

      for (const targetBone of bones) {
        const sourceName = BONE_MAP[targetBone.name];
        // how far the source bone has turned from its bind pose, in world space...
        delta.copy(worldQuaternion(bone(source, sourceName))).multiply(sourceRest.get(sourceName)!.clone().invert());
        // ...applied to the target bone's bind pose, then expressed relative to its (already solved) parent
        const world = delta.clone().multiply(targetRest.get(targetBone.name)!);
        targetBone.parent!.getWorldQuaternion(parentWorld);
        targetBone.quaternion.copy(parentWorld.invert().multiply(world));
        targetBone.updateMatrixWorld(true);
        rotations.get(targetBone.name)!.push(...targetBone.quaternion.toArray());
      }

      model.updateMatrixWorld(true);
      const heights = ankles.map(({ shin, ankle }) => ankle.clone().applyMatrix4(shin.matrixWorld).y - targetFloorY);
      lowestFoot.push(Math.min(...heights));
      wrists.L.push(worldPosition(bone(model, "WristL")));
      wrists.R.push(worldPosition(bone(model, "WristR")));
    }

    for (const side of ["L", "R"] as const) {
      let fastest = 0;
      let fastestTime = 0;
      for (let i = 1; i < frames; i++) {
        const speed = wrists[side][i].distanceTo(wrists[side][i - 1]) * FPS;
        if (speed > fastest) {
          fastest = speed;
          fastestTime = (times[i] + times[i - 1]) / 2;
        }
      }
      console.log(`  ${animation.name} ${group}: hand ${side} fastest ${fastest.toFixed(1)} m/s at ${fastestTime.toFixed(2)} s`);
    }

    const tracks: THREE.KeyframeTrack[] = [
      ...bones.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, rotations.get(b.name)!)),
      new THREE.VectorKeyframeTrack("Body.position", times, bodyPositions),
    ];
    const clip = new THREE.AnimationClip(animation.name, sourceClip.duration, tracks);
    const json = JSON.stringify(THREE.AnimationClip.toJSON(clip));
    const file = `${animation.file}_${group}.json`;
    writeFileSync(join(OUT, file), json);
    // a grounded move keeps one foot near the floor in every frame; a big minimum means it floats
    console.log(
      `${file}: ${frames} frames, ${(json.length / 1024).toFixed(0)} KB, ` +
        `lowest foot ${Math.min(...lowestFoot).toFixed(2)} .. ${Math.max(...lowestFoot).toFixed(2)} m above the floor`,
    );
  }
}
