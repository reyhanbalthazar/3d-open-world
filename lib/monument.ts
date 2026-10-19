import * as THREE from "three";
import type { Obstacle } from "./terrain-layout";

// The landmark in the middle of the map: a paved plaza, a tall octagonal stone tower crowned
// with a floating crystal, and a ring of standing stones with gates to the south and north.
// Built from simple low-poly shapes in the pack's pale stone, since the packs have no buildings.

// warm pale stone; the green light bounced off the grass cools it down in the scene
const STONE = 0xe8dcc4;
const STONE_DARK = 0xc2b394;
const PAVING = 0xd6c8a8;
const CRYSTAL = 0x6fe3ff;

const PILLAR_RING = 4.6;
// angle around the tower (from +x towards +z) and height of each standing stone; 180 deg is broken
const PILLARS: Array<[degrees: number, height: number]> = [
  [0, 3.3],
  [60, 3.4],
  [120, 3.4],
  [180, 1.4],
  [240, 3.2],
  [300, 3.2],
];
// pairs of stones joined by a lintel: the gate facing the south spawn, and one facing north
const GATES: Array<[number, number]> = [
  [4, 5],
  [1, 2],
];
const CRYSTAL_HEIGHT = 9.2;

function pillarPosition(degrees: number) {
  const angle = THREE.MathUtils.degToRad(degrees);
  return { x: Math.cos(angle) * PILLAR_RING, z: Math.sin(angle) * PILLAR_RING };
}

// where the top of a broken stone lies, just outside its stump
function fallenPosition(degrees: number) {
  const { x, z } = pillarPosition(degrees);
  return { x: x * 1.25, z: z * 1.25 + 0.6 };
}

export const MONUMENT_POSITION = { x: 0, z: 0 };

// the tower's stepped base, every standing stone and the fallen piece are solid
export const MONUMENT_OBSTACLES: Obstacle[] = [
  { x: 0, z: 0, radius: 2.4 },
  ...PILLARS.map(([degrees]) => ({ ...pillarPosition(degrees), radius: 0.55 })),
  ...PILLARS.filter(([, height]) => height < 2).map(([degrees]) => ({ ...fallenPosition(degrees), radius: 0.8 })),
];

// Plain flat-shaded stone: the pack's mossy rock texture smears into camouflage on these shapes.
function stoneMaterial(color: number) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true });
}

export function createMonument() {
  const monument = new THREE.Group();
  const stone = stoneMaterial(STONE);
  const stoneDark = stoneMaterial(STONE_DARK);
  const paving = stoneMaterial(PAVING);

  function add(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    monument.add(mesh);
    return mesh;
  }

  // plaza: two thin paved discs, flush with the ground so players simply walk over them
  add(new THREE.CylinderGeometry(6.8, 6.9, 0.08, 24), paving, 0, 0, 0);
  add(new THREE.CylinderGeometry(3.2, 3.3, 0.12, 16), stoneDark, 0, 0, 0);

  // tower: stepped base, tapering octagonal shaft with carved bands, flared cap and crown spikes
  add(new THREE.CylinderGeometry(2.25, 2.4, 0.5, 8), stoneDark, 0, 0.25, 0);
  add(new THREE.CylinderGeometry(1.75, 1.9, 0.5, 8), stone, 0, 0.75, 0);
  add(new THREE.CylinderGeometry(0.95, 1.25, 6.2, 8), stone, 0, 4.1, 0);
  add(new THREE.CylinderGeometry(1.32, 1.32, 0.28, 8), stoneDark, 0, 1.55, 0);
  add(new THREE.CylinderGeometry(1.12, 1.12, 0.24, 8), stoneDark, 0, 4.4, 0);
  add(new THREE.CylinderGeometry(1.35, 0.98, 0.5, 8), stoneDark, 0, 7.45, 0);
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    add(new THREE.ConeGeometry(0.16, 0.9, 5), stone, Math.cos(angle) * 1.05, 8.1, Math.sin(angle) * 1.05);
  }

  // standing stones, one of them broken with its top lying in the grass
  const tops: number[] = [];
  PILLARS.forEach(([degrees, height], i) => {
    const { x, z } = pillarPosition(degrees);
    const pillar = add(new THREE.CylinderGeometry(0.42, 0.52, height, 6), stone, x, height / 2, z);
    pillar.rotation.y = i * 0.7;
    tops.push(height);

    if (height < 2) {
      const lying = fallenPosition(degrees);
      const fallen = add(new THREE.CylinderGeometry(0.4, 0.44, 1.8, 6), stone, lying.x, 0.38, lying.z);
      fallen.rotation.set(0.15, 0.6, Math.PI / 2);
    }
  });

  for (const [a, b] of GATES) {
    const start = pillarPosition(PILLARS[a][0]);
    const end = pillarPosition(PILLARS[b][0]);
    const length = Math.hypot(end.x - start.x, end.z - start.z) + 0.9;
    const lintel = add(
      new THREE.BoxGeometry(length, 0.45, 0.8),
      stoneDark,
      (start.x + end.x) / 2,
      Math.min(tops[a], tops[b]) + 0.22,
      (start.z + end.z) / 2,
    );
    lintel.rotation.y = -Math.atan2(end.z - start.z, end.x - start.x);
  }

  // the crystal glows on its own and lights the stones around it
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.55),
    new THREE.MeshStandardMaterial({
      color: CRYSTAL,
      emissive: CRYSTAL,
      emissiveIntensity: 1.6,
      roughness: 0.2,
      flatShading: true,
    }),
  );
  crystal.scale.set(1, 1.7, 1);
  crystal.position.y = CRYSTAL_HEIGHT;
  monument.add(crystal);

  const glow = new THREE.PointLight(CRYSTAL, 8, 14, 2);
  glow.position.y = CRYSTAL_HEIGHT;
  monument.add(glow);

  monument.position.set(MONUMENT_POSITION.x, 0, MONUMENT_POSITION.z);

  return {
    object: monument,
    // the crystal slowly turns and bobs
    update(elapsed: number) {
      crystal.rotation.y = elapsed * 0.8;
      crystal.position.y = CRYSTAL_HEIGHT + Math.sin(elapsed * 1.6) * 0.18;
    },
  };
}
