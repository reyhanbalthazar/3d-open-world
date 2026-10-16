// Messages exchanged between the browser and server/game-server.mts over WebSocket.

// Keep in sync with GAME_PORT in server/game-server.mts.
export const GAME_SERVER_PORT = 3001;

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
