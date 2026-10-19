import type { Obstacle } from "./terrain-layout";
import { MAP_HALF, MAP_SIZE } from "./world";

export interface RadarMarker {
  x: number;
  z: number;
  yaw: number;
  color: string;
}

const PADDING = 10;
const GRID_STEP = 10;
const VIEW_CONE_ANGLE = 0.9;
const VIEW_CONE_LENGTH = 34;

// Top-down minimap of the whole square map. Oriented like the spawn camera:
// +Z (straight ahead at spawn) is up on the radar and +X is to the left.
export class Radar {
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private scale: number;
  // trees and rocks, drawn as small dots
  private obstacles: readonly Obstacle[];
  // the monument, drawn as a glowing diamond
  private landmark: { x: number; z: number } | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    size: number,
    obstacles: readonly Obstacle[] = [],
    landmark?: { x: number; z: number },
  ) {
    this.obstacles = obstacles;
    this.landmark = landmark;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(size * dpr);

    this.ctx = canvas.getContext("2d")!;
    this.ctx.scale(dpr, dpr);
    this.size = size;
    this.scale = (size - PADDING * 2) / MAP_SIZE;
  }

  draw(self: RadarMarker, viewX: number, viewZ: number, others: Iterable<RadarMarker>) {
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);

    // grid and map border
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.beginPath();
    for (let d = -MAP_HALF + GRID_STEP; d < MAP_HALF; d += GRID_STEP) {
      const [a] = this.toRadar(d, 0);
      const [, b] = this.toRadar(0, d);
      ctx.moveTo(a, PADDING);
      ctx.lineTo(a, size - PADDING);
      ctx.moveTo(PADDING, b);
      ctx.lineTo(size - PADDING, b);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(PADDING, PADDING, size - PADDING * 2, size - PADDING * 2);

    ctx.fillStyle = "rgba(140, 200, 120, 0.55)";
    ctx.beginPath();
    for (const obstacle of this.obstacles) {
      const [ox, oy] = this.toRadar(obstacle.x, obstacle.z);
      ctx.moveTo(ox + 1.6, oy);
      ctx.arc(ox, oy, 1.6, 0, Math.PI * 2);
    }
    ctx.fill();

    if (this.landmark) {
      const [lx, ly] = this.toRadar(this.landmark.x, this.landmark.z);
      ctx.beginPath();
      ctx.moveTo(lx, ly - 6);
      ctx.lineTo(lx + 4.5, ly);
      ctx.lineTo(lx, ly + 6);
      ctx.lineTo(lx - 4.5, ly);
      ctx.closePath();
      ctx.fillStyle = "#6fe3ff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.stroke();
    }

    // what the camera is looking at
    const [sx, sy] = this.toRadar(self.x, self.z);
    const viewAngle = Math.atan2(-viewZ, -viewX);
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, VIEW_CONE_LENGTH, viewAngle - VIEW_CONE_ANGLE / 2, viewAngle + VIEW_CONE_ANGLE / 2);
    ctx.closePath();
    ctx.fill();

    for (const other of others) this.drawArrow(other, 5);
    this.drawArrow(self, 6.5);
  }

  private toRadar(x: number, z: number): [number, number] {
    const c = this.size / 2;
    return [c - x * this.scale, c - z * this.scale];
  }

  private drawArrow(marker: RadarMarker, radius: number) {
    const { ctx } = this;
    const [x, y] = this.toRadar(marker.x, marker.z);

    ctx.save();
    ctx.translate(x, y);
    // the arrow is drawn pointing up, which is +Z at yaw 0
    ctx.rotate(-marker.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(radius * 0.8, radius);
    ctx.lineTo(0, radius * 0.45);
    ctx.lineTo(-radius * 0.8, radius);
    ctx.closePath();
    ctx.fillStyle = marker.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.stroke();
    ctx.restore();
  }
}
