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
  // everyone already playing, sent on every (re)connect
  onWelcome(players: PlayerInfo[]): void;
  onJoined(id: string): void;
  onJoinError(reason: JoinErrorReason): void;
  onPlayerJoined(player: PlayerInfo): void;
  onState(id: string, state: PlayerState): void;
  onLeave(id: string): void;
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
  return a.x === b.x && a.z === b.z && a.yaw === b.yaw && a.anim === b.anim;
}

// Connects to the game server on the same host and port that served the page, reconnecting until closed.
export function connectMultiplayer(handlers: MultiplayerHandlers) {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let identity: { name: string; character: CharacterId } | undefined;
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
          handlers.onWelcome(message.players);
          break;
        case "joined":
          joined = true;
          everJoined = true;
          handlers.onJoined(message.id);
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
          const { id, x, z, yaw, anim } = message;
          handlers.onState(id, { x, z, yaw, anim });
          break;
        }
        case "leave":
          handlers.onLeave(message.id);
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
    join(name: string, character: CharacterId) {
      identity = { name, character };
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

    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(rejoinTimer);
      socket?.close();
    },
  };
}
