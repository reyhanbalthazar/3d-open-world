import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  createActions,
  createFootPins,
  instantiateCharacter,
  loadCharacterModel,
  mixamoWeight,
  type CharacterActions,
} from "./character-models";
import type { CharacterId } from "./characters";
import type { AnimName, LocomotionName, PlayerInfo, PlayerState } from "./protocol";
import type { RadarMarker } from "./radar";
import { yawFromQuaternion } from "./world";

const FADE_DURATION = 0.3;
const SMOOTHING = 12;
const SNAP_DISTANCE = 5;
// just above the head of the Quaternius characters (~1.85 m tall)
const LABEL_HEIGHT = 2.15;

interface Profile {
  name: string;
  character: CharacterId;
  // marker colour on the radar and the name tag
  color: string;
}

interface RemotePlayer {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: CharacterActions;
  current: AnimName;
  feet: ReturnType<typeof createFootPins>;
  target: THREE.Vector3;
  targetRotation: THREE.Quaternion;
  label: CSS2DObject;
  color: string;
}

const UP = new THREE.Vector3(0, 1, 0);

const isLocomotion = (anim: AnimName): anim is LocomotionName => anim === "Idle" || anim === "Walk" || anim === "Run";
const isStride = (anim: AnimName) => anim === "Walk" || anim === "Run";

function colorFromId(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.7, 0.6).getStyle();
}

function createLabel(profile: Profile) {
  const element = document.createElement("div");
  element.className =
    "rounded-md border-l-[3px] bg-black/60 px-1.5 py-0.5 font-sans text-xs font-medium whitespace-nowrap text-white";
  element.style.borderLeftColor = profile.color;
  element.textContent = profile.name;

  const label = new CSS2DObject(element);
  label.position.set(0, LABEL_HEIGHT, 0);
  return label;
}

// Other players in the world, each with the character they picked and a name tag.
export class RemotePlayers {
  private profiles = new Map<string, Profile>();
  private players = new Map<string, RemotePlayer>();
  // latest position of players whose character model is still downloading
  private pending = new Map<string, PlayerState>();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  // players who have joined, whether or not they have moved yet
  get count() {
    return this.profiles.size;
  }

  names() {
    return [...this.profiles.values()].map((profile) => profile.name);
  }

  add(player: PlayerInfo) {
    this.profiles.set(player.id, { name: player.name, character: player.character, color: colorFromId(player.id) });
    if (player.state) this.upsert(player.id, player.state);
  }

  upsert(id: string, state: PlayerState) {
    const player = this.players.get(id);
    if (player) {
      player.target.set(state.x, 0, state.z);
      player.targetRotation.setFromAxisAngle(UP, state.yaw);
      this.play(player, state.anim);
      return;
    }

    const profile = this.profiles.get(id);
    if (!profile) return;

    const loading = this.pending.has(id);
    this.pending.set(id, state);
    if (loading) return;

    loadCharacterModel(profile.character).then(
      (gltf) => {
        const latest = this.pending.get(id);
        // the player may have left (or we reconnected) while the model downloaded
        if (!latest || this.profiles.get(id) !== profile) return;
        this.pending.delete(id);
        this.spawn(id, profile, gltf, latest);
      },
      (error) => console.error(`Could not load character "${profile.character}"`, error),
    );
  }

  remove(id: string) {
    this.profiles.delete(id);
    this.pending.delete(id);

    const player = this.players.get(id);
    if (!player) return;

    player.mixer.stopAllAction();
    player.mixer.uncacheRoot(player.group);
    // the label's DOM element is only removed when the label itself leaves the scene graph
    player.label.removeFromParent();
    this.scene.remove(player.group);
    this.players.delete(id);
  }

  clear() {
    for (const id of [...this.profiles.keys()]) this.remove(id);
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
      player.feet.update(mixamoWeight(player.actions));
    }
  }

  private spawn(id: string, profile: Profile, gltf: GLTF, state: PlayerState) {
    const model = instantiateCharacter(gltf);
    const label = createLabel(profile);

    const group = new THREE.Group();
    group.add(model, label);
    group.position.set(state.x, 0, state.z);
    group.quaternion.setFromAxisAngle(UP, state.yaw);
    this.scene.add(group);

    const mixer = new THREE.AnimationMixer(model);
    const actions = createActions(mixer, gltf.animations);
    // someone first seen in the middle of a move just stands until their next update
    const current = isLocomotion(state.anim) ? state.anim : "Idle";
    actions[current].play();

    this.players.set(id, {
      group,
      mixer,
      actions,
      current,
      feet: createFootPins(model),
      target: group.position.clone(),
      targetRotation: group.quaternion.clone(),
      label,
      color: profile.color,
    });
  }

  private play(player: RemotePlayer, anim: AnimName) {
    if (player.current === anim) return;

    // a move whose animation failed to load is skipped
    const next = player.actions[anim];
    if (!next) return;
    const old = player.actions[player.current]!;
    const previous = player.current;
    player.current = anim;

    next.reset();
    // keep the feet in step when switching between walk and run
    if (isStride(anim) && isStride(previous)) next.time = old.time * (next.getClip().duration / old.getClip().duration);
    next.fadeIn(FADE_DURATION).play();
    old.fadeOut(FADE_DURATION);
  }
}
