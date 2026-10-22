import * as THREE from "three";

// Bits flying off whatever a tool hits: stone chunks from a rock, wood chips from a tree, and
// leaves from a cut plant. They fly, tumble, bounce once or twice and shrink away.

export type DebrisKind = "stone" | "wood" | "leaves";

interface Preset {
  colors: number[];
  // number of pieces for a target of radius 1; small targets still get `minCount`
  count: number;
  minCount: number;
  // piece size, as a fraction of the target radius, with an absolute floor in metres
  size: [min: number, max: number];
  minSize: number;
  speed: [min: number, max: number];
  lift: [min: number, max: number];
  gravity: number;
  // per-second slow-down of horizontal speed in the air (leaves flutter)
  drag: number;
  life: number;
  shape: "chunk" | "chip" | "leaf";
}

const PRESETS: Record<DebrisKind, Preset> = {
  stone: {
    colors: [0xd9d4c7, 0xc7c1b2],
    count: 20, minCount: 10, size: [0.09, 0.22], minSize: 0.05,
    speed: [1.5, 3.5], lift: [2.5, 5], gravity: 14, drag: 0, life: 1.3, shape: "chunk",
  },
  wood: {
    colors: [0xb07d48, 0xd2a46a, 0x8a5a33],
    count: 30, minCount: 7, size: [0.12, 0.2], minSize: 0.05,
    speed: [1.2, 2.8], lift: [1.5, 3.5], gravity: 12, drag: 0, life: 1.1, shape: "chip",
  },
  leaves: {
    colors: [0x5f9e32, 0x7cb83a, 0x4c8a2a, 0x9acb4a],
    count: 26, minCount: 8, size: [0.09, 0.16], minSize: 0.035,
    speed: [0.6, 1.8], lift: [1.2, 2.8], gravity: 3.5, drag: 1.6, life: 1.7, shape: "leaf",
  },
};

const SHRINK_TIME = 0.35;

interface Piece {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  size: number;
  life: number;
  preset: Preset;
}

export class Debris {
  private scene: THREE.Scene;
  private pieces: Piece[] = [];
  private geometries: Record<Preset["shape"], THREE.BufferGeometry> = {
    chunk: new THREE.DodecahedronGeometry(1, 0),
    chip: new THREE.BoxGeometry(1, 0.35, 0.55),
    leaf: new THREE.OctahedronGeometry(1, 0).scale(1, 0.15, 0.6),
  };
  private materials = new Map<number, THREE.Material>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private material(color: number) {
    let material = this.materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true, side: THREE.DoubleSide });
      this.materials.set(color, material);
    }
    return material;
  }

  // radius: the target's size, so bigger things throw more and bigger pieces
  burst(kind: DebrisKind, x: number, y: number, z: number, radius: number) {
    const preset = PRESETS[kind];
    const count = Math.max(preset.minCount, Math.round(preset.count * radius));
    for (let i = 0; i < count; i++) {
      const size = Math.max(preset.minSize, radius * THREE.MathUtils.randFloat(...preset.size));
      const angle = Math.random() * Math.PI * 2;
      const speed = THREE.MathUtils.randFloat(...preset.speed);
      const color = preset.colors[Math.floor(Math.random() * preset.colors.length)];
      const mesh = new THREE.Mesh(this.geometries[preset.shape], this.material(color));
      mesh.position.set(x + Math.cos(angle) * radius * 0.4, y + THREE.MathUtils.randFloatSpread(radius * 0.6), z + Math.sin(angle) * radius * 0.4);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      mesh.scale.setScalar(size);
      mesh.castShadow = preset.shape !== "leaf";
      this.scene.add(mesh);
      this.pieces.push({
        mesh,
        velocity: new THREE.Vector3(Math.cos(angle) * speed, THREE.MathUtils.randFloat(...preset.lift), Math.sin(angle) * speed),
        spin: new THREE.Vector3().randomDirection().multiplyScalar(THREE.MathUtils.randFloat(4, 10)),
        size,
        life: preset.life * THREE.MathUtils.randFloat(0.75, 1),
        preset,
      });
    }
  }

  update(delta: number) {
    const step = Math.min(delta, 0.05);
    this.pieces = this.pieces.filter((piece) => {
      const { mesh, velocity, spin, size, preset } = piece;
      piece.life -= step;
      if (piece.life <= 0) {
        this.scene.remove(mesh);
        return false;
      }

      velocity.y -= preset.gravity * step;
      const drag = Math.exp(-preset.drag * step);
      velocity.x *= drag;
      velocity.z *= drag;
      mesh.position.addScaledVector(velocity, step);
      const floor = size * (preset.shape === "leaf" ? 0.15 : 1);
      if (mesh.position.y < floor) {
        // land, losing most of the energy; leaves just settle
        mesh.position.y = floor;
        velocity.y = preset.shape === "leaf" ? 0 : Math.abs(velocity.y) * 0.3;
        velocity.x *= 0.5;
        velocity.z *= 0.5;
        spin.multiplyScalar(0.5);
      }
      mesh.rotation.x += spin.x * step;
      mesh.rotation.y += spin.y * step;
      mesh.rotation.z += spin.z * step;
      mesh.scale.setScalar(size * Math.min(1, piece.life / SHRINK_TIME));
      return true;
    });
  }

  dispose() {
    for (const { mesh } of this.pieces) this.scene.remove(mesh);
    this.pieces = [];
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
  }
}
