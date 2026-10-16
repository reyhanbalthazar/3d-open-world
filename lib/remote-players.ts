import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import type { AnimName, PlayerState } from "./protocol";
import type { RadarMarker } from "./radar";
import { yawFromQuaternion } from "./world";

// Index of each animation clip inside Soldier.glb.
export const CLIP_INDEX: Record<AnimName, number> = { Idle: 0, Walk: 3, Run: 1 };

const FADE_DURATION = 0.3;
const SMOOTHING = 12;
const SNAP_DISTANCE = 5;

interface RemotePlayer {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Record<AnimName, THREE.AnimationAction>;
  current: AnimName;
  target: THREE.Vector3;
  targetRotation: THREE.Quaternion;
  materials: THREE.Material[];
  color: string;
}

const UP = new THREE.Vector3(0, 1, 0);

function hueFromId(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 360) / 360;
}

// Other players in the world, cloned from the local Soldier model and tinted per player.
export class RemotePlayers {
  private players = new Map<string, RemotePlayer>();
  private pending = new Map<string, PlayerState>();
  private template: GLTF | undefined;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  get count() {
    return this.players.size + this.pending.size;
  }

  // Players can join before the model has loaded; they spawn once it is available.
  setTemplate(gltf: GLTF) {
    this.template = gltf;
    for (const [id, state] of this.pending) this.upsert(id, state);
    this.pending.clear();
  }

  upsert(id: string, state: PlayerState) {
    if (!this.template) {
      this.pending.set(id, state);
      return;
    }

    const player = this.players.get(id) ?? this.spawn(id, state);
    player.target.set(state.x, 0, state.z);
    player.targetRotation.setFromAxisAngle(UP, state.yaw);
    this.play(player, state.anim);
  }

  remove(id: string) {
    this.pending.delete(id);

    const player = this.players.get(id);
    if (!player) return;

    player.mixer.stopAllAction();
    player.mixer.uncacheRoot(player.group);
    this.scene.remove(player.group);
    for (const material of player.materials) material.dispose();
    this.players.delete(id);
  }

  clear() {
    for (const id of [...this.players.keys()]) this.remove(id);
    this.pending.clear();
  }

  *markers(): Generator<RadarMarker> {
    for (const player of this.players.values()) {
      const { position, quaternion } = player.group;
      yield { x: position.x, z: position.z, yaw: yawFromQuaternion(quaternion), color: player.color };
    }
  }

  update(delta: number) {
    const t = 1 - Math.exp(-SMOOTHING * delta);

    for (const player of this.players.values()) {
      if (player.group.position.distanceTo(player.target) > SNAP_DISTANCE) {
        player.group.position.copy(player.target);
      } else {
        player.group.position.lerp(player.target, t);
      }
      player.group.quaternion.slerp(player.targetRotation, t);
      player.mixer.update(delta);
    }
  }

  private spawn(id: string, state: PlayerState) {
    const template = this.template!;
    const model = cloneSkinned(template.scene);
    const tint = new THREE.Color().setHSL(hueFromId(id), 0.7, 0.6);
    const materials: THREE.Material[] = [];

    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = (object.material as THREE.MeshStandardMaterial).clone();
      material.color.copy(tint);
      object.material = material;
      materials.push(material);
    });

    const group = new THREE.Group();
    group.add(model);
    group.position.set(state.x, 0, state.z);
    group.quaternion.setFromAxisAngle(UP, state.yaw);
    this.scene.add(group);

    const mixer = new THREE.AnimationMixer(model);
    const actions = {
      Idle: mixer.clipAction(template.animations[CLIP_INDEX.Idle]),
      Walk: mixer.clipAction(template.animations[CLIP_INDEX.Walk]),
      Run: mixer.clipAction(template.animations[CLIP_INDEX.Run]),
    };
    actions[state.anim].play();

    const player: RemotePlayer = {
      group,
      mixer,
      actions,
      current: state.anim,
      target: group.position.clone(),
      targetRotation: group.quaternion.clone(),
      materials,
      color: tint.getStyle(),
    };
    this.players.set(id, player);
    return player;
  }

  private play(player: RemotePlayer, anim: AnimName) {
    if (player.current === anim) return;

    const old = player.actions[player.current];
    const next = player.actions[anim];
    player.current = anim;

    next.reset();
    // keep the feet in step when switching between walk and run
    if (anim !== "Idle") next.time = old.time * (next.getClip().duration / old.getClip().duration);
    next.fadeIn(FADE_DURATION).play();
    old.fadeOut(FADE_DURATION);
  }
}
