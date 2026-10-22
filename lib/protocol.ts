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

export type ToolName = "hammer" | "axe" | "sickle";
// what the world has that tools can break: rocks, trees, and bushes and smaller plants
export type BreakableKind = "rock" | "tree" | "plant";

export interface PlayerState {
  x: number;
  z: number;
  yaw: number;
  anim: AnimName;
  // the tool in hand, if any (keys 1-3)
  tool: ToolName | null;
}

// What each tool breaks, and how far its swing reaches from the player to the near edge of a target (m).
export const TOOLS: Record<ToolName, { breaks: BreakableKind; reach: number }> = {
  hammer: { breaks: "rock", reach: 1.8 },
  axe: { breaks: "tree", reach: 1.6 },
  sickle: { breaks: "plant", reach: 1.8 },
};
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && value in TOOLS;
}

// Broken things grow back after this long, so the world never runs out.
export const RESPAWN_MS: Record<BreakableKind, number> = { rock: 90_000, tree: 120_000, plant: 45_000 };
// Hunting Score: what each thing broken adds to the breaker's score. About the same points a
// minute with every tool: a sickle swing cuts ~4 plants, a tree takes 3 blows, and rocks and
// trees are few and ~6 m apart.
export const POINTS: Record<BreakableKind, number> = { rock: 10, tree: 20, plant: 1 };
// A sickle swing cuts every plant in front of it; a message breaking more than this is refused.
export const MAX_BREAKS_PER_SWING = 24;

export interface PlayerInfo {
  id: string;
  name: string;
  character: CharacterId;
  // null until the player has sent their first position
  state: PlayerState | null;
  // Hunting Score
  score: number;
}

export type JoinErrorReason = "invalid_name" | "invalid_character" | "name_taken" | "server_full";

export type ClientMessage =
  // token: from an earlier "joined"; coming back with it under the same name (after a dropped
  // connection or a page reload) gives back the score
  | { type: "join"; name: string; character: CharacterId; token?: string }
  | ({ type: "state" } & PlayerState)
  // ids come from generateTerrainLayout(), which every client and the server share
  | { type: "break"; ids: number[] };

export type ServerMessage =
  | { type: "welcome"; players: PlayerInfo[]; broken: number[] }
  // score: carried over when the join brought back a token; token: keep it for next time
  | { type: "joined"; id: string; score: number; token: string }
  | { type: "join_error"; reason: JoinErrorReason }
  | { type: "player_joined"; player: PlayerInfo }
  | ({ type: "state"; id: string } & PlayerState)
  | { type: "leave"; id: string }
  // by: the player who broke them, so a tree can fall away from them; score: their score now
  | { type: "broken"; ids: number[]; by: string; score: number }
  // grown back; also sent to a player whose break was refused, to put things back on their screen
  | { type: "restored"; ids: number[] };

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
