import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { NATURE_DIR, NATURE_MODELS, OBJ_MATERIALS, type NatureModelId } from "./nature-catalog";
import { PATH_WIDTH, seededRandom, type PathPolyline, type Placement } from "./terrain-layout";

const GROUND_TEXTURE_SIZE = 2048;
const GROUND_COLORS = {
  grass: "#7cb33d",
  grassLight: "rgba(176, 214, 84, 0.12)",
  grassDark: "rgba(62, 120, 36, 0.12)",
  pathEdge: "#8f8a4c",
  path: "#a2905a",
};

// The pack's textures are dark (rocks average ~65/255) and tuned for its own renders; brighten
// the rocks to the pale stone of its promo shots and push the grass towards a sunny lime green.
// These multiply the texture in linear colour, so values above 1 brighten it.
const MATERIAL_TINTS: Record<string, [r: number, g: number, b: number]> = {
  Rock: [7.5, 7.5, 7.2],
  Grass: [2.6, 2.7, 2],
};

function tint(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = (Array.isArray(child.material) ? child.material : [child.material]) as THREE.MeshStandardMaterial[];
    for (const material of materials) {
      const factors = MATERIAL_TINTS[material.name];
      if (factors && !material.userData.tinted) {
        material.color.setRGB(...factors);
        material.userData.tinted = true;
      }
    }
  });
}

async function loadModel(id: NatureModelId, objMaterials: Map<string, THREE.Material>) {
  if (NATURE_MODELS[id] === "gltf") {
    return (await new GLTFLoader().loadAsync(`${NATURE_DIR}/${id}.gltf`)).scene;
  }

  // OBJ models carry material names only; give them the pack's textures
  const object = await new OBJLoader().loadAsync(`${NATURE_DIR}/${id}.obj`);
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = (Array.isArray(child.material) ? child.material : [child.material]) as THREE.Material[];
    const textured = materials.map((material) => objMaterial(material.name, objMaterials));
    child.material = Array.isArray(child.material) ? textured : textured[0];
  });
  return object;
}

function objMaterial(name: string, cache: Map<string, THREE.Material>) {
  let material = cache.get(name);
  if (material) return material;

  const spec = OBJ_MATERIALS[name];
  if (spec) {
    const map = new THREE.TextureLoader().load(`${NATURE_DIR}/textures/${spec.texture}`);
    map.colorSpace = THREE.SRGBColorSpace;
    material = new THREE.MeshStandardMaterial({
      name,
      map,
      roughness: 0.9,
      alphaTest: spec.cutout ? 0.5 : 0,
      side: spec.cutout ? THREE.DoubleSide : THREE.FrontSide,
    });
  } else {
    console.warn(`No texture for OBJ material "${name}"`);
    material = new THREE.MeshStandardMaterial({ name, color: 0x888888 });
  }
  cache.set(name, material);
  return material;
}

// Adds every placement to the scene, one InstancedMesh per model part, so hundreds of
// trees and grass clumps cost a few dozen draw calls. Models load in the background; the returned
// controller can hide or move single placements (things broken with tools) at any time, even
// before they have loaded.
export function addNature(scene: THREE.Scene, placements: Placement[], isCancelled: () => boolean) {
  // grouped by model and shadow casting, since border copies of a model skip shadows
  const groups = new Map<string, { model: NatureModelId; castShadow: boolean; indices: number[] }>();
  placements.forEach((placement, index) => {
    const key = `${placement.model}|${placement.castShadow}`;
    const group = groups.get(key) ?? { model: placement.model, castShadow: placement.castShadow, indices: [] };
    group.indices.push(index);
    groups.set(key, group);
  });

  // placement index -> the instance slots drawing it, and the matrix each slot shows when visible
  const instances = new Map<number, Array<{ mesh: THREE.InstancedMesh; slot: number; matrix: THREE.Matrix4 }>>();
  const hidden = new Set<number>();
  // an extra world-space transform on top of a placement (a tree falling, a rock growing back)
  const offsets = new Map<number, THREE.Matrix4>();
  const collapsed = new THREE.Matrix4().makeScale(0, 0, 0);
  const moved = new THREE.Matrix4();

  function matrixFor(index: number, matrix: THREE.Matrix4) {
    if (hidden.has(index)) return collapsed;
    const offset = offsets.get(index);
    return offset ? moved.multiplyMatrices(offset, matrix) : matrix;
  }

  function show(index: number) {
    for (const { mesh, slot, matrix } of instances.get(index) ?? []) {
      mesh.setMatrixAt(slot, matrixFor(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  const objMaterials = new Map<string, THREE.Material>();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (const { model, castShadow, indices } of groups.values()) {
    loadModel(model, objMaterials).then(
      (template) => {
        if (isCancelled()) return;

        tint(template);
        template.updateMatrixWorld(true);
        template.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;

          const mesh = new THREE.InstancedMesh(child.geometry, child.material, indices.length);
          indices.forEach((index, slot) => {
            const placement = placements[index];
            position.set(placement.x, 0, placement.z);
            rotation.setFromAxisAngle(up, placement.rotation);
            scale.setScalar(placement.scale);
            const matrix = new THREE.Matrix4().compose(position, rotation, scale).multiply(child.matrixWorld);
            mesh.setMatrixAt(slot, matrixFor(index, matrix));
            const list = instances.get(index) ?? [];
            list.push({ mesh, slot, matrix });
            instances.set(index, list);
          });
          mesh.castShadow = castShadow;
          mesh.receiveShadow = true;
          mesh.computeBoundingSphere();
          scene.add(mesh);
        });
      },
      (error) => console.error(`Could not load nature model "${model}"`, error),
    );
  }

  return {
    setHidden(index: number, value: boolean) {
      if (value) hidden.add(index);
      else hidden.delete(index);
      show(index);
    },
    // null puts the placement back where it was laid out
    setTransform(index: number, transform: THREE.Matrix4 | null) {
      if (transform) offsets.set(index, transform.clone());
      else offsets.delete(index);
      show(index);
    },
  };
}

// The ground is one painted texture: sunny grass with soft lighter and darker patches, and dirt
// paths with blurred edges. Painting it once on a canvas is cheaper than more geometry.
export function createGround(
  size: number,
  paths: readonly PathPolyline[],
  clearingRadius: number,
  maxAnisotropy: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GROUND_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const pxPerMeter = GROUND_TEXTURE_SIZE / size;
  // the plane is laid flat, so canvas x/y follow world x/z
  const toPx = (meters: number) => (meters + size / 2) * pxPerMeter;
  const random = seededRandom(7);

  ctx.fillStyle = GROUND_COLORS.grass;
  ctx.fillRect(0, 0, GROUND_TEXTURE_SIZE, GROUND_TEXTURE_SIZE);

  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = random() < 0.5 ? GROUND_COLORS.grassLight : GROUND_COLORS.grassDark;
    ctx.beginPath();
    ctx.arc(random() * GROUND_TEXTURE_SIZE, random() * GROUND_TEXTURE_SIZE, (0.6 + random() * 2.6) * pxPerMeter, 0, Math.PI * 2);
    ctx.fill();
  }

  // bare, trodden earth in the middle of the map, fading into the grass at the clearing's edge
  const center = toPx(0);
  const clearing = ctx.createRadialGradient(center, center, 0, center, center, clearingRadius * pxPerMeter);
  clearing.addColorStop(0, GROUND_COLORS.path);
  clearing.addColorStop(0.62, GROUND_COLORS.path);
  clearing.addColorStop(0.8, GROUND_COLORS.pathEdge);
  clearing.addColorStop(1, "rgba(143, 138, 76, 0)");
  ctx.fillStyle = clearing;
  ctx.fillRect(0, 0, GROUND_TEXTURE_SIZE, GROUND_TEXTURE_SIZE);
  // a few tufts of grass survive on the bare ground
  for (let i = 0; i < 70; i++) {
    const angle = random() * Math.PI * 2;
    const distance = (0.45 + random() * 0.5) * clearingRadius;
    ctx.fillStyle = GROUND_COLORS.grassDark;
    ctx.beginPath();
    ctx.arc(toPx(Math.cos(angle) * distance), toPx(Math.sin(angle) * distance), (0.3 + random() * 0.8) * pxPerMeter, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const strokes = [
    { width: PATH_WIDTH + 0.8, color: GROUND_COLORS.pathEdge, blur: 0.9 },
    { width: PATH_WIDTH - 0.6, color: GROUND_COLORS.path, blur: 0.5 },
  ];
  for (const { width, color, blur } of strokes) {
    ctx.filter = `blur(${blur * pxPerMeter}px)`;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * pxPerMeter;
    for (const path of paths) {
      ctx.beginPath();
      path.forEach(([x, z], i) => (i === 0 ? ctx.moveTo(toPx(x), toPx(z)) : ctx.lineTo(toPx(x), toPx(z))));
      ctx.stroke();
    }
  }
  ctx.filter = "none";

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;

  const geometry = new THREE.PlaneGeometry(size, size);
  // laid flat, the plane's top edge (v = 1, the canvas's first row) ends up at world z = -size/2,
  // which is where toPx() puts canvas y = 0, so the texture lines up without remapping
  geometry.rotateX(-Math.PI / 2);

  const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
  ground.receiveShadow = true;
  return ground;
}
