import * as THREE from "three";
import type { Debris } from "./effects";
import type { addNature } from "./nature";
import type { BreakableKind } from "./protocol";
import type { Breakable, Obstacle } from "./terrain-layout";

// Everything tools can break, as this client sees it: which things are broken, the animations
// (a tree shaking under the axe, falling, sinking away; anything growing back), the stumps felled
// trees leave, and the bits that fly off. The server decides what is broken; this only shows it.

type Nature = ReturnType<typeof addNature>;

// a tree falls with gravity, lies a moment, then sinks into the ground
const FALL_TIME = 1.1;
const LIE_TIME = 0.8;
const SINK_TIME = 0.9;
const SINK_DEPTH = 1.5;
const SHAKE_TIME = 0.45;
const SHAKE_ANGLE = 0.07;
const GROW_TIME = 0.8;
// where on the trunk the axe bites, for the wood chips
const TRUNK_HIT_HEIGHT = 1;
const STUMP_HEIGHT = 0.28;
const STUMP_COLOR = 0x6e4a2c;

interface Animation {
  type: "shake" | "fall" | "grow";
  time: number;
  // shake and fall turn about this horizontal axis through the base
  axis?: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

export class BreakableWorld {
  private scene: THREE.Scene;
  private nature: Nature;
  private debris: Debris;
  private byId: Map<number, Breakable>;
  private byKind: Record<BreakableKind, Breakable[]> = { rock: [], tree: [], plant: [] };
  private obstacles: Map<number, Obstacle>;
  private broken = new Set<number>();
  private hits = new Map<number, number>();
  private animations = new Map<number, Animation>();
  private stumps = new Map<number, THREE.Mesh>();
  private stumpGeometry = new THREE.CylinderGeometry(1, 1.18, 1, 8);
  private stumpMaterial = new THREE.MeshStandardMaterial({ color: STUMP_COLOR, roughness: 1, flatShading: true });
  private matrix = new THREE.Matrix4();
  private step = new THREE.Matrix4();

  constructor(scene: THREE.Scene, nature: Nature, breakables: Breakable[], obstacles: Obstacle[], debris: Debris) {
    this.scene = scene;
    this.nature = nature;
    this.debris = debris;
    this.byId = new Map(breakables.map((breakable) => [breakable.id, breakable]));
    for (const breakable of breakables) this.byKind[breakable.kind].push(breakable);
    this.obstacles = new Map(obstacles.flatMap((o) => (o.breakableId === undefined ? [] : [[o.breakableId, o] as const])));
  }

  get(id: number) {
    return this.byId.get(id);
  }

  // Unbroken things of a kind whose near edge is within reach, inside an arc either side of the
  // facing direction (yaw 0 faces +Z), nearest first.
  inFront(kind: BreakableKind, x: number, z: number, yaw: number, reach: number, arcCos: number) {
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const found: Array<{ target: Breakable; gap: number }> = [];
    for (const target of this.byKind[kind]) {
      if (this.broken.has(target.id)) continue;
      const dx = target.x - x;
      const dz = target.z - z;
      const distance = Math.hypot(dx, dz);
      const gap = distance - target.radius;
      if (gap > reach) continue;
      // standing right on top of something counts as facing it
      if (distance > target.radius && (dx * forwardX + dz * forwardZ) / distance < arcCos) continue;
      found.push({ target, gap });
    }
    return found.sort((a, b) => a.gap - b.gap).map(({ target }) => target);
  }

  // An axe blow that has not felled the tree yet: it shakes and throws chips. Returns the blows so far.
  hit(id: number, fromX: number, fromZ: number) {
    const target = this.byId.get(id);
    if (!target || this.broken.has(id)) return 0;
    const blows = (this.hits.get(id) ?? 0) + 1;
    this.hits.set(id, blows);
    this.animations.set(id, { type: "shake", time: 0, axis: this.tipAxis(target, fromX, fromZ) });
    this.debris.burst("wood", target.x, TRUNK_HIT_HEIGHT, target.z, target.radius * 1.5);
    return blows;
  }

  // from: where the breaker stood, so a tree falls away from them; effects: false when only
  // catching up with the server (joining, reconnecting), so nothing flies or falls.
  break(id: number, from: { x: number; z: number } | undefined, effects: boolean) {
    const target = this.byId.get(id);
    if (!target || this.broken.has(id)) return;
    this.broken.add(id);
    this.hits.delete(id);
    const obstacle = this.obstacles.get(id);
    // no collision and no radar dot while broken
    if (obstacle) obstacle.disabled = true;

    if (target.kind === "tree") {
      this.addStump(target);
      if (effects) {
        const fromX = from?.x ?? target.x + THREE.MathUtils.randFloatSpread(1);
        const fromZ = from?.z ?? target.z + THREE.MathUtils.randFloatSpread(1);
        this.animations.set(id, { type: "fall", time: 0, axis: this.tipAxis(target, fromX, fromZ) });
        this.debris.burst("wood", target.x, TRUNK_HIT_HEIGHT, target.z, target.radius * 2);
        return;
      }
    } else if (effects) {
      if (target.kind === "rock") this.debris.burst("stone", target.x, target.radius * 0.6, target.z, target.radius);
      else this.debris.burst("leaves", target.x, target.radius * 0.6, target.z, target.radius);
    }
    this.animations.delete(id);
    this.nature.setTransform(id, null);
    this.nature.setHidden(id, true);
  }

  // grow: false when only catching up with the server
  restore(id: number, grow: boolean) {
    if (!this.broken.delete(id)) return;
    this.hits.delete(id);
    const obstacle = this.obstacles.get(id);
    if (obstacle) obstacle.disabled = false;
    const stump = this.stumps.get(id);
    if (stump) {
      this.scene.remove(stump);
      this.stumps.delete(id);
    }
    this.nature.setHidden(id, false);
    if (grow) {
      this.animations.set(id, { type: "grow", time: 0 });
      this.update(0);
    } else {
      this.animations.delete(id);
      this.nature.setTransform(id, null);
    }
  }

  // Matches the server's list of broken things, e.g. after joining or reconnecting.
  sync(brokenIds: number[]) {
    const stillBroken = new Set(brokenIds);
    for (const id of [...this.broken]) if (!stillBroken.has(id)) this.restore(id, false);
    for (const id of brokenIds) this.break(id, undefined, false);
  }

  update(delta: number) {
    for (const [id, animation] of this.animations) {
      const target = this.byId.get(id)!;
      animation.time += delta;
      const t = animation.time;

      if (animation.type === "shake") {
        if (t >= SHAKE_TIME) {
          this.animations.delete(id);
          this.nature.setTransform(id, null);
          continue;
        }
        const angle = SHAKE_ANGLE * Math.sin(t * 38) * (1 - t / SHAKE_TIME);
        this.nature.setTransform(id, this.aroundBase(target, this.step.makeRotationAxis(animation.axis!, angle)));
      } else if (animation.type === "fall") {
        if (t >= FALL_TIME + LIE_TIME + SINK_TIME) {
          this.animations.delete(id);
          this.nature.setTransform(id, null);
          this.nature.setHidden(id, true);
          continue;
        }
        // accelerating like a real fall, then a little bounce as it hits the ground
        const fall = Math.min(1, t / FALL_TIME);
        const settle = t > FALL_TIME ? Math.sin(Math.min(1, (t - FALL_TIME) / 0.25) * Math.PI) * 0.04 : 0;
        const angle = (Math.PI / 2) * fall * fall - settle;
        const sink = t > FALL_TIME + LIE_TIME ? ((t - FALL_TIME - LIE_TIME) / SINK_TIME) * SINK_DEPTH : 0;
        this.aroundBase(target, this.step.makeRotationAxis(animation.axis!, angle));
        this.matrix.premultiply(this.step.makeTranslation(0, -sink, 0));
        this.nature.setTransform(id, this.matrix);
      } else {
        if (t >= GROW_TIME) {
          this.animations.delete(id);
          this.nature.setTransform(id, null);
          continue;
        }
        // pops up from nothing with a slight overshoot
        const x = t / GROW_TIME;
        const s = 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
        this.nature.setTransform(id, this.aroundBase(target, this.step.makeScale(s, s, s)));
      }
    }
  }

  dispose() {
    for (const stump of this.stumps.values()) this.scene.remove(stump);
    this.stumps.clear();
    this.stumpGeometry.dispose();
    this.stumpMaterial.dispose();
  }

  // the horizontal axis that tips a tree's top away from (fromX, fromZ)
  private tipAxis(target: Breakable, fromX: number, fromZ: number) {
    const away = new THREE.Vector3(target.x - fromX, 0, target.z - fromZ);
    if (away.lengthSq() < 1e-6) away.set(1, 0, 0);
    away.normalize();
    return new THREE.Vector3().crossVectors(UP, away).normalize();
  }

  // transform about the target's base: move there, apply, move back
  private aroundBase(target: Breakable, transform: THREE.Matrix4) {
    return this.matrix
      .makeTranslation(target.x, 0, target.z)
      .multiply(transform)
      .multiply(new THREE.Matrix4().makeTranslation(-target.x, 0, -target.z));
  }

  private addStump(target: Breakable) {
    const stump = new THREE.Mesh(this.stumpGeometry, this.stumpMaterial);
    // the collision radius is generous; the trunk itself is slimmer
    const radius = target.radius * 0.75;
    stump.scale.set(radius, STUMP_HEIGHT, radius);
    stump.position.set(target.x, STUMP_HEIGHT / 2, target.z);
    stump.castShadow = true;
    stump.receiveShadow = true;
    this.scene.add(stump);
    this.stumps.set(target.id, stump);
  }
}
