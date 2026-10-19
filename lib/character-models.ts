import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { ANIMATIONS_DIR, MIXAMO_ANIMATIONS, type MixamoAnimationName } from "./animation-catalog";
import { getCharacter, type CharacterId } from "./characters";
import type { LocomotionName } from "./protocol";

const cache = new Map<CharacterId, Promise<GLTF>>();
const extraClips = new Map<string, Promise<THREE.AnimationClip | null>>();

// A missing animation file only means that move is unavailable, never a missing character.
function loadExtraClip(url: string) {
  let promise = extraClips.get(url);
  if (!promise) {
    promise = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((json) => THREE.AnimationClip.parse(json))
      .catch((error) => {
        console.error(`Could not load the animation ${url}`, error);
        return null;
      });
    extraClips.set(url, promise);
  }
  return promise;
}

// Each character file is downloaded once and shared by the local player, the join screen preview
// and every remote player using it; use instantiateCharacter() to get a copy to put in the scene.
// The Mixamo animations baked for its skeleton are added to its animations. onProgress (0..1) is
// only reported to the caller that starts the download.
export function loadCharacterModel(id: CharacterId, onProgress?: (fraction: number) => void): Promise<GLTF> {
  let promise = cache.get(id);
  if (!promise) {
    const character = getCharacter(id);
    const skeleton = character.group === "Men" ? "men" : "women";
    const model = new GLTFLoader().loadAsync(character.url, (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    });
    const extras = MIXAMO_ANIMATIONS.map((animation) => loadExtraClip(`${ANIMATIONS_DIR}/${animation.file}_${skeleton}.json`));
    promise = Promise.all([model, ...extras]).then(([gltf, ...clips]) => {
      for (const clip of clips) if (clip) gltf.animations.push(clip);
      return gltf;
    });
    promise.catch(() => cache.delete(id));
    cache.set(id, promise);
  }
  return promise;
}

export function instantiateCharacter(gltf: GLTF) {
  const model = cloneSkinned(gltf.scene);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  return model;
}

// Mixamo moves are only present when their files loaded.
export type CharacterActions = Record<LocomotionName, THREE.AnimationAction> &
  Partial<Record<MixamoAnimationName, THREE.AnimationAction>>;

// Every Quaternius character ships the same named clips, so actions are looked up by name.
export function createActions(mixer: THREE.AnimationMixer, animations: THREE.AnimationClip[]): CharacterActions {
  const action = (name: LocomotionName) => {
    const clip = THREE.AnimationClip.findByName(animations, name);
    if (!clip) throw new Error(`Character model has no "${name}" animation`);
    return mixer.clipAction(clip);
  };
  const actions: CharacterActions = { Idle: action("Idle"), Walk: action("Walk"), Run: action("Run") };

  for (const { name } of MIXAMO_ANIMATIONS) {
    const clip = THREE.AnimationClip.findByName(animations, name);
    if (!clip) continue;
    const move = mixer.clipAction(clip);
    // plays once and holds its last frame while fading back out
    move.setLoop(THREE.LoopOnce, 1);
    move.clampWhenFinished = true;
    actions[name] = move;
  }
  return actions;
}

// How much the Mixamo moves currently drive the pose (0..1).
export function mixamoWeight(actions: CharacterActions) {
  let weight = 0;
  for (const { name } of MIXAMO_ANIMATIONS) weight = Math.max(weight, actions[name]?.getEffectiveWeight() ?? 0);
  return Math.min(1, weight);
}

// The characters' feet are IK targets parented to Root rather than to the shins, so a clip that
// only turns the legs (like the baked Mixamo moves) would leave the feet behind. While such a clip
// plays, pull each foot to the end of its shin, where it sits in the bind pose.
export function createFootPins(model: THREE.Object3D) {
  const bindWorld = new Map<string, THREE.Matrix4>();
  model.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    object.skeleton.bones.forEach((bone, i) => {
      if (!bindWorld.has(bone.name)) bindWorld.set(bone.name, object.skeleton.boneInverses[i].clone().invert());
    });
  });

  const pins = (["L", "R"] as const).flatMap((side) => {
    const shin = model.getObjectByName(`LowerLeg${side}`);
    const foot = model.getObjectByName(`Foot${side}`);
    const shinBind = bindWorld.get(`LowerLeg${side}`);
    const footBind = bindWorld.get(`Foot${side}`);
    if (!shin || !foot?.parent || !shinBind || !footBind) return [];
    // the ankle, in the shin's own space
    const ankle = new THREE.Vector3().setFromMatrixPosition(footBind).applyMatrix4(shinBind.clone().invert());
    return [{ shin, foot, ankle }];
  });

  const target = new THREE.Vector3();
  return {
    update(weight: number) {
      if (weight <= 0 || pins.length === 0) return;
      model.updateMatrixWorld(true);
      for (const { shin, foot, ankle } of pins) {
        target.copy(ankle).applyMatrix4(shin.matrixWorld);
        foot.parent!.worldToLocal(target);
        foot.position.lerp(target, weight);
      }
    },
  };
}
