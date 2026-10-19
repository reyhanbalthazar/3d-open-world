// Messages exchanged between the browser and server/game.ts over WebSocket.
//
// A connection first only watches the world (it gets "welcome" and everyone's updates).
// It becomes a player after sending "join" with a unique name and a character.

import type { MixamoAnimationName } from "./animation-catalog";
import type { CharacterId } from "./characters";

// Served by the same host and port as the game page.
export const GAME_SOCKET_PATH = "/ws";

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 16;
// letters and digits in any script, plus space, underscore, dot and dash
const NAME_PATTERN = new RegExp("^[\\p{L}\\p{N} _.-]+$", "u");

// standing, walking or running; a Mixamo move (e.g. "Slash") plays once on top and hands back
export type LocomotionName = "Idle" | "Walk" | "Run";
export type AnimName = LocomotionName | MixamoAnimationName;

export interface PlayerState {
  x: number;
  z: number;
  yaw: number;
  anim: AnimName;
}

export interface PlayerInfo {
  id: string;
  name: string;
  character: CharacterId;
  // null until the player has sent their first position
  state: PlayerState | null;
}

export type JoinErrorReason = "invalid_name" | "invalid_character" | "name_taken" | "server_full";

export type ClientMessage =
  | { type: "join"; name: string; character: CharacterId }
  | ({ type: "state" } & PlayerState);

export type ServerMessage =
  | { type: "welcome"; players: PlayerInfo[] }
  | { type: "joined"; id: string }
  | { type: "join_error"; reason: JoinErrorReason }
  | { type: "player_joined"; player: PlayerInfo }
  | ({ type: "state"; id: string } & PlayerState)
  | { type: "leave"; id: string };

// Trims and collapses spaces; returns null when the name is not allowed.
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) return null;
  return NAME_PATTERN.test(name) ? name : null;
}

// Names must be unique regardless of letter case.
export function nameKey(name: string) {
  return name.toLocaleLowerCase();
}
