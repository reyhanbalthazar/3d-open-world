import type * as THREE from "three";

// The playable area is a square centred on the origin, MAP_SIZE metres per side.
export const MAP_SIZE = 40;
export const MAP_HALF = MAP_SIZE / 2;
export const PLAYER_RADIUS = 0.4;

// Characters only ever rotate around Y, so their quaternion is (0, sin(yaw/2), 0, cos(yaw/2)).
// A yaw of 0 faces +Z; the facing direction is (sin(yaw), 0, cos(yaw)).
export function yawFromQuaternion(q: THREE.Quaternion) {
  return 2 * Math.atan2(q.y, q.w);
}
