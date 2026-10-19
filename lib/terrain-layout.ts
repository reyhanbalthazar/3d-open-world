import type { NatureModelId } from "./nature-catalog";
import { MAP_HALF } from "./world";

// Where every tree, rock, bush and patch of grass goes, and where the dirt paths run.
// Generated from a fixed seed, so every player builds exactly the same world without the
// server having to send it.

const SEED = 20220519;
// the middle of the map is a bare clearing around the monument (lib/monument.ts); nothing grows there
export const CLEARING_RADIUS = 11;
// stay this far inside the map edge so nothing pokes out of the forest border
const INSIDE = MAP_HALF - 1.5;
// a band of dense forest just outside the play area hides the edge of the world
const BORDER_START = MAP_HALF + 1.5;
const BORDER_END = MAP_HALF + 9;

export const PATH_WIDTH = 3;

// Dirt paths as Catmull-Rom control points (x, z). They run past the spawn point and on into
// the forest, so they seem to lead somewhere.
const PATH_CONTROL_POINTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[-4, -36], [-2, -17], [0, -6], [1, 2], [-3, 12], [2, 22], [0, 36]],
  [[1, 2], [9, 4], [16, -2], [24, -6], [36, -4]],
  [[-2, -17], [-11, -14], [-20, -19], [-36, -17]],
];

export type PathPolyline = Array<[x: number, z: number]>;

export interface Placement {
  model: NatureModelId;
  x: number;
  z: number;
  rotation: number;
  scale: number;
  castShadow: boolean;
}

// circles the local player cannot walk into (tree trunks and rocks)
export interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

interface Scatter {
  models: readonly NatureModelId[];
  count: number;
  // "path_edge" lines the dirt paths, like flowers and grass along a trail
  area: "inside" | "border" | "path_edge";
  scale: [min: number, max: number];
  // minimum gap to other spaced objects; 0 places anywhere (grass, flowers)
  spacing: number;
  // keep at least this far from the middle of any path
  pathClearance: number;
  // collision radius at scale 1
  obstacleRadius?: number;
  castShadow: boolean;
}

const TREES = [
  "birch_tree_1",
  "birch_tree_2",
  "birch_tree_3",
  "birch_tree_4",
  "birch_tree_5",
  "maple_tree_1",
  "maple_tree_2",
  "maple_tree_4",
  "maple_tree_5",
  "pine_tree_1",
  "pine_tree_2",
  "pine_tree_3",
  "pine_tree_4",
  "pine_tree_5",
  "normal_tree_5",
] as const;
const BORDER_TREES = [
  "pine_tree_1",
  "pine_tree_2",
  "pine_tree_3",
  "pine_tree_4",
  "pine_tree_5",
  "normal_tree_5",
  "birch_tree_2",
  "maple_tree_1",
  "maple_tree_5",
] as const;
const DEAD_TREES = ["dead_tree_1", "dead_tree_2", "dead_tree_5", "dead_tree_9"] as const;
const ROCKS = ["rock_1", "rock_2", "rock_3", "rock_4", "rock_5"] as const;
const BUSHES = ["bush", "bush_flowers", "bush_large", "bush_large_flowers", "bush_small", "bush_small_flowers"] as const;
const GRASS = ["grass_large", "grass_small"] as const;
const FLOWERS = ["flower_1_clump", "flower_2_clump", "flower_3_clump", "flower_4_clump", "flower_5_clump"] as const;
const PLANTS = ["plant_1", "plant_2", "plant_flowers"] as const;

// Small, fast, seedable PRNG (mulberry32).
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth curve through the control points, as short straight pieces.
function samplePath(points: ReadonlyArray<readonly [number, number]>, stepsPerSegment = 10): PathPolyline {
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  const line: PathPolyline = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let step = 0; step < stepsPerSegment; step++) {
      const t = step / stepsPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const catmullRom = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      line.push([catmullRom(p0[0], p1[0], p2[0], p3[0]), catmullRom(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  line.push([...points[points.length - 1]]);
  return line;
}

export function generateTerrainLayout() {
  const random = seededRandom(SEED);
  const range = (min: number, max: number) => min + (max - min) * random();
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];

  const paths = PATH_CONTROL_POINTS.map((points) => samplePath(points));
  const segments = paths.flatMap((line) => line.slice(1).map((end, i) => [line[i], end] as const));

  function distanceToPath(x: number, z: number) {
    let best = Infinity;
    for (const [[ax, az], [bx, bz]] of segments) {
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
    }
    return best;
  }

  const placements: Placement[] = [];
  const obstacles: Obstacle[] = [];
  const occupied: Array<{ x: number; z: number; radius: number }> = [];

  function point(area: Scatter["area"], pathClearance: number): [number, number] {
    if (area === "inside") return [range(-INSIDE, INSIDE), range(-INSIDE, INSIDE)];

    if (area === "path_edge") {
      const [[ax, az], [bx, bz]] = pick(segments);
      const t = random();
      const length = Math.hypot(bx - ax, bz - az) || 1;
      const offset = (random() < 0.5 ? -1 : 1) * (pathClearance + range(0, 1.8));
      return [ax + t * (bx - ax) - ((bz - az) / length) * offset, az + t * (bz - az) + ((bx - ax) / length) * offset];
    }

    const depth = range(BORDER_START, BORDER_END);
    const along = range(-BORDER_END, BORDER_END);
    switch (Math.floor(random() * 4)) {
      case 0: return [along, depth];
      case 1: return [along, -depth];
      case 2: return [depth, along];
      default: return [-depth, along];
    }
  }

  function scatter(spec: Scatter) {
    const radius = spec.spacing / 2;
    let placed = 0;
    for (let attempt = 0; placed < spec.count && attempt < spec.count * 40; attempt++) {
      const [x, z] = point(spec.area, spec.pathClearance);
      if (Math.abs(x) > BORDER_END || Math.abs(z) > BORDER_END) continue;
      if (Math.hypot(x, z) < CLEARING_RADIUS) continue;
      if (distanceToPath(x, z) < spec.pathClearance) continue;
      if (radius > 0 && occupied.some((other) => Math.hypot(other.x - x, other.z - z) < other.radius + radius)) continue;

      const scale = range(...spec.scale);
      placements.push({ model: pick(spec.models), x, z, rotation: range(0, Math.PI * 2), scale, castShadow: spec.castShadow });
      if (radius > 0) occupied.push({ x, z, radius });
      if (spec.obstacleRadius) obstacles.push({ x, z, radius: spec.obstacleRadius * scale });
      placed++;
    }
  }

  const edge = PATH_WIDTH / 2;

  // big things first, so the spacing rules work around them.
  // The border sits in the fog, where shadows are not visible but would still cost a lot to render.
  scatter({ models: BORDER_TREES, count: 120, area: "border", scale: [1, 1.6], spacing: 3.2, pathClearance: edge + 2, castShadow: false });
  scatter({ models: ROCKS, count: 20, area: "border", scale: [1.2, 2.2], spacing: 1.5, pathClearance: edge + 1, castShadow: false });
  scatter({ models: TREES, count: 30, area: "inside", scale: [0.9, 1.3], spacing: 5, pathClearance: edge + 2.5, obstacleRadius: 0.35, castShadow: true });
  scatter({ models: DEAD_TREES, count: 3, area: "inside", scale: [0.9, 1.2], spacing: 5, pathClearance: edge + 2.5, obstacleRadius: 0.3, castShadow: true });
  scatter({ models: ROCKS, count: 10, area: "path_edge", scale: [0.8, 1.6], spacing: 2, pathClearance: edge + 0.6, obstacleRadius: 0.45, castShadow: true });
  scatter({ models: ROCKS, count: 12, area: "inside", scale: [1, 2.2], spacing: 2.5, pathClearance: edge + 1.5, obstacleRadius: 0.45, castShadow: true });
  scatter({ models: BUSHES, count: 30, area: "path_edge", scale: [0.9, 1.4], spacing: 1.6, pathClearance: edge + 0.9, castShadow: true });
  scatter({ models: BUSHES, count: 40, area: "inside", scale: [0.9, 1.5], spacing: 2, pathClearance: edge + 1, castShadow: true });
  scatter({ models: BUSHES, count: 50, area: "border", scale: [1, 1.6], spacing: 1.5, pathClearance: edge + 0.5, castShadow: false });
  scatter({ models: PLANTS, count: 30, area: "inside", scale: [0.9, 1.3], spacing: 1, pathClearance: edge + 0.5, castShadow: false });
  // flowers and grass crowd the path edges, then thin out across the meadow
  scatter({ models: FLOWERS, count: 140, area: "path_edge", scale: [0.9, 1.4], spacing: 0, pathClearance: edge + 0.2, castShadow: false });
  scatter({ models: GRASS, count: 260, area: "path_edge", scale: [1, 1.7], spacing: 0, pathClearance: edge, castShadow: false });
  scatter({ models: FLOWERS, count: 90, area: "inside", scale: [0.8, 1.3], spacing: 0, pathClearance: edge, castShadow: false });
  scatter({ models: GRASS, count: 600, area: "inside", scale: [0.9, 1.6], spacing: 0, pathClearance: edge - 0.3, castShadow: false });

  return { placements, obstacles, paths };
}
