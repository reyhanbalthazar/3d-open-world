import * as THREE from "three";
import type { ToolName } from "./protocol";

// Low-poly tools (the packs have none): a war hammer for rocks, an axe for trees and a sickle
// ("clurit") for bushes and plants. Each is built around its grip point, with the handle along +Y
// and its working part (hammer head, axe blade, sickle blade) out along +X.

const WOOD = 0x8a5a33;
const WOOD_DARK = 0x6b4226;
const IRON = 0x6d7178;
const IRON_DARK = 0x4a4e55;
const STEEL = 0xc3cad2;
const LEATHER = 0x4b3324;

export const TOOL_LABELS: Record<ToolName, string> = { hammer: "Hammer", axe: "Axe", sickle: "Sickle" };
export const TOOL_TARGETS: Record<ToolName, string> = { hammer: "Rocks", axe: "Trees", sickle: "Bushes & plants" };

const HAND_BONE = "WristR";
// from the wrist towards the fingers, where the fist closes around the handle (bind pose metres)
const GRIP_OFFSET = 0.085;
const HANDLE_TILT = THREE.MathUtils.degToRad(55);

function toolBuilder() {
  const tool = new THREE.Group();
  const materials = new Map<number, THREE.Material>();
  const material = (color: number) => {
    let found = materials.get(color);
    if (!found) {
      found = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: color === STEEL ? 0.4 : 0, flatShading: true });
      materials.set(color, found);
    }
    return found;
  };
  const add = (geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    tool.add(mesh);
    return mesh;
  };
  return { tool, add };
}

// a flat shape in the XY plane, given a little thickness along Z
function plate(shape: THREE.Shape, thickness: number) {
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 10 });
  geometry.translate(0, 0, -thickness / 2);
  return geometry;
}

function createHammer() {
  const { tool, add } = toolBuilder();
  add(new THREE.CylinderGeometry(0.028, 0.034, 0.78, 7), WOOD, 0, 0.2, 0);
  add(new THREE.CylinderGeometry(0.038, 0.038, 0.16, 7), LEATHER, 0, 0, 0);
  add(new THREE.CylinderGeometry(0.045, 0.04, 0.05, 7), IRON_DARK, 0, -0.2, 0);
  // the head: a block with a flat striking face on one side and a narrower peen on the other
  add(new THREE.BoxGeometry(0.2, 0.15, 0.15), IRON, 0, 0.6, 0);
  add(new THREE.BoxGeometry(0.06, 0.18, 0.18), IRON_DARK, 0.12, 0.6, 0);
  add(new THREE.BoxGeometry(0.12, 0.1, 0.1), IRON, -0.15, 0.6, 0);
  add(new THREE.BoxGeometry(0.05, 0.08, 0.13), IRON_DARK, -0.03, 0.6, 0);
  return tool;
}

function createAxe() {
  const { tool, add } = toolBuilder();
  add(new THREE.CylinderGeometry(0.025, 0.031, 0.84, 7), WOOD, 0, 0.22, 0);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.14, 7), LEATHER, 0, 0, 0);
  // head: socket around the handle, a short butt behind it, and a flared blade with a bright edge
  add(new THREE.BoxGeometry(0.08, 0.13, 0.065), IRON_DARK, 0, 0.58, 0);
  add(new THREE.BoxGeometry(0.05, 0.09, 0.055), IRON, -0.06, 0.58, 0);
  const blade = new THREE.Shape();
  blade.moveTo(0.03, 0.045);
  blade.lineTo(0.15, 0.1);
  blade.quadraticCurveTo(0.2, 0, 0.15, -0.1);
  blade.lineTo(0.03, -0.045);
  blade.closePath();
  add(plate(blade, 0.035), IRON, 0, 0.58, 0);
  const edge = new THREE.Shape();
  edge.moveTo(0.14, 0.095);
  edge.quadraticCurveTo(0.2, 0, 0.14, -0.095);
  edge.quadraticCurveTo(0.175, 0, 0.14, 0.095);
  add(plate(edge, 0.038), STEEL, 0, 0.58, 0);
  return tool;
}

// The Indonesian clurit: a short wooden handle and a crescent blade sweeping up and over.
function createSickle() {
  const { tool, add } = toolBuilder();
  add(new THREE.CylinderGeometry(0.022, 0.027, 0.22, 7), WOOD_DARK, 0, 0, 0);
  add(new THREE.CylinderGeometry(0.029, 0.029, 0.03, 7), IRON_DARK, 0, 0.115, 0);
  add(new THREE.BoxGeometry(0.03, 0.09, 0.012), STEEL, -0.016, 0.165, 0);
  const deg = THREE.MathUtils.degToRad;
  const blade = new THREE.Shape();
  // outer edge from the handle up over the top and down to the tip, then the inner edge back
  blade.absarc(0.12, 0.27, 0.17, deg(205), deg(-40), true);
  blade.absarc(0.13, 0.26, 0.14, deg(-40), deg(205), false);
  blade.closePath();
  add(plate(blade, 0.012), STEEL, 0, 0, 0);
  return tool;
}

const BUILDERS: Record<ToolName, () => THREE.Group> = { hammer: createHammer, axe: createAxe, sickle: createSickle };

// Puts every tool in the character's right hand, all hidden; showTool() picks the one held.
// The grip is worked out from the skeleton's bind (T-)pose, where the right arm points sideways and
// a fist holds a handle pointing ahead (+Z), so it fits every character, men and women alike.
export function attachTools(model: THREE.Object3D) {
  const tools = Object.fromEntries(
    (Object.keys(BUILDERS) as ToolName[]).map((name) => {
      const tool = BUILDERS[name]();
      tool.visible = false;
      return [name, tool];
    }),
  ) as Record<ToolName, THREE.Group>;

  const hand = model.getObjectByName(HAND_BONE);
  let bind: THREE.Matrix4 | undefined;
  model.traverse((object) => {
    if (bind || !(object instanceof THREE.SkinnedMesh)) return;
    const index = object.skeleton.bones.findIndex((bone) => bone.name === HAND_BONE);
    if (index >= 0) bind = object.skeleton.boneInverses[index].clone().invert();
  });
  if (!hand || !bind) return tools;

  const bindRotation = new THREE.Quaternion();
  const bindScale = new THREE.Vector3();
  bind.decompose(new THREE.Vector3(), bindRotation, bindScale);
  const toHand = bindRotation.clone().invert();

  // world directions in the bind pose, expressed in the hand bone's own space
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(toHand).normalize();
  const fingers = new THREE.Vector3(0, 1, 0);
  // tip the handle from straight ahead towards the fingers, so with the arm hanging the tool
  // hangs forward and down instead of jutting out level
  const handle = forward.multiplyScalar(Math.cos(HANDLE_TILT)).addScaledVector(fingers, Math.sin(HANDLE_TILT)).normalize();
  const head = new THREE.Vector3().crossVectors(fingers, handle).normalize();
  const third = new THREE.Vector3().crossVectors(head, handle).normalize();
  const grip = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(head, handle, third));

  for (const tool of Object.values(tools)) {
    tool.quaternion.copy(grip);
    // the hand bone may carry the armature's scale; keep the tools life-size
    tool.scale.setScalar(1 / bindScale.x);
    tool.position.copy(fingers).multiplyScalar(GRIP_OFFSET / bindScale.x);
    hand.add(tool);
  }
  return tools;
}

export function showTool(tools: Record<ToolName, THREE.Object3D>, held: ToolName | null) {
  for (const [name, tool] of Object.entries(tools)) tool.visible = name === held;
}
