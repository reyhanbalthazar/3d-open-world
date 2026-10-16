// Messages exchanged between the browser and server/game.ts over WebSocket.

// Served by the same host and port as the game page.
export const GAME_SOCKET_PATH = "/ws";

export type AnimName = "Idle" | "Walk" | "Run";

export interface PlayerState {
  x: number;
  z: number;
  yaw: number;
  anim: AnimName;
}

export type ClientMessage = { type: "state" } & PlayerState;

export type ServerMessage =
  | { type: "welcome"; id: string; players: Array<{ id: string } & PlayerState> }
  | ({ type: "state"; id: string } & PlayerState)
  | { type: "leave"; id: string };
