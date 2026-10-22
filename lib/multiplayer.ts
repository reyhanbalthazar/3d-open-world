import type { CharacterId } from "./characters";
import {
  GAME_SOCKET_PATH,
  type ClientMessage,
  type JoinErrorReason,
  type PlayerInfo,
  type PlayerState,
  type ServerMessage,
} from "./protocol";

export type ConnectionStatus = "connecting" | "online" | "offline";

interface MultiplayerHandlers {
  // everyone already playing and everything broken right now, sent on every (re)connect
  onWelcome(players: PlayerInfo[], broken: number[]): void;
  // score: our Hunting Score, carried over if we came back; token: what brings it back next time
  onJoined(id: string, score: number, token: string): void;
  onJoinError(reason: JoinErrorReason): void;
  onPlayerJoined(player: PlayerInfo): void;
  onState(id: string, state: PlayerState): void;
  onLeave(id: string): void;
  // by: who broke them; score: their Hunting Score now
  onBroken(ids: number[], by: string, score: number): void;
  onRestored(ids: number[]): void;
  onStatus(status: ConnectionStatus): void;
}

const SEND_INTERVAL_MS = 66; // ~15 updates per second
const IDLE_RESEND_MS = 1000;
const RECONNECT_MS = 2000;
// a handshake that hangs (e.g. sent while the server restarts) is abandoned and retried
const CONNECT_TIMEOUT_MS = 10_000;
// after a reconnect our old connection can still hold the name until the server notices it is gone
const REJOIN_RETRY_MS = 3000;

function sameState(a: PlayerState, b: PlayerState) {
  return a.x === b.x && a.z === b.z && a.yaw === b.yaw && a.anim === b.anim && a.tool === b.tool;
}

// Connects to the game server on the same host and port that served the page, reconnecting until closed.
export function connectMultiplayer(handlers: MultiplayerHandlers) {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let identity: { name: string; character: CharacterId; token?: string } | undefined;
  let joined = false;
  let everJoined = false;
  let lastSent: PlayerState | undefined;
  let lastSentAt = 0;

  function send(message: ClientMessage) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function sendJoin() {
    if (identity) send({ type: "join", ...identity });
  }

  function open() {
    handlers.onStatus("connecting");

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}${GAME_SOCKET_PATH}`);
    socket = ws;

    const connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      joined = false;
      lastSent = undefined;
      handlers.onStatus("online");
      sendJoin();
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      switch (message.type) {
        case "welcome":
          handlers.onWelcome(message.players, message.broken);
          break;
        case "joined":
          joined = true;
          everJoined = true;
          // rejoining after a dropped connection shows it, so we keep our score
          if (identity) identity.token = message.token;
          handlers.onJoined(message.id, message.score, message.token);
          break;
        case "join_error":
          if (everJoined) {
            // rejoining after a dropped connection: keep trying with the same name
            rejoinTimer = setTimeout(sendJoin, REJOIN_RETRY_MS);
          } else {
            identity = undefined;
            handlers.onJoinError(message.reason);
          }
          break;
        case "player_joined":
          handlers.onPlayerJoined(message.player);
          break;
        case "state": {
          const { id, x, z, yaw, anim, tool } = message;
          handlers.onState(id, { x, z, yaw, anim, tool });
          break;
        }
        case "leave":
          handlers.onLeave(message.id);
          break;
        case "broken":
          handlers.onBroken(message.ids, message.by, message.score);
          break;
        case "restored":
          handlers.onRestored(message.ids);
          break;
      }
    };

    ws.onclose = () => {
      clearTimeout(connectTimer);
      if (socket !== ws || closed) return;
      joined = false;
      clearTimeout(rejoinTimer);
      handlers.onStatus("offline");
      reconnectTimer = setTimeout(open, RECONNECT_MS);
    };
  }

  open();

  return {
    // Answered by onJoined or onJoinError. Reconnects re-send it automatically.
    // token: from an earlier onJoined (e.g. before a page reload), to get that score back
    join(name: string, character: CharacterId, token?: string) {
      identity = { name, character, token };
      sendJoin();
    },

    // Safe to call every frame: throttled, skipped while nothing changes, and only sent once joined.
    sendState(state: PlayerState) {
      if (!joined) return;

      const now = performance.now();
      if (now - lastSentAt < SEND_INTERVAL_MS) return;
      if (lastSent && sameState(lastSent, state) && now - lastSentAt < IDLE_RESEND_MS) return;

      send({ type: "state", ...state });
      lastSent = { ...state };
      lastSentAt = now;
    },

    // The server answers with "broken" for everyone, and "restored" to us for whatever it refuses.
    breakThings(ids: number[], current: PlayerState) {
      if (!joined) return;
      // the server judges the hit from our position, so make sure it has the latest one
      send({ type: "state", ...current });
      lastSent = { ...current };
      lastSentAt = performance.now();
      send({ type: "break", ids });
    },

    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(rejoinTimer);
      socket?.close();
    },
  };
}
