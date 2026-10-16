import { GAME_SERVER_PORT, type ClientMessage, type PlayerState, type ServerMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "online" | "offline";

interface MultiplayerHandlers {
  onWelcome(id: string, players: Array<{ id: string } & PlayerState>): void;
  onState(id: string, state: PlayerState): void;
  onLeave(id: string): void;
  onStatus(status: ConnectionStatus): void;
}

const SEND_INTERVAL_MS = 66; // ~15 updates per second
const IDLE_RESEND_MS = 1000;
const RECONNECT_MS = 2000;

function sameState(a: PlayerState, b: PlayerState) {
  return a.x === b.x && a.z === b.z && a.yaw === b.yaw && a.anim === b.anim;
}

// Connects to the game server on the same host that served the page, reconnecting until closed.
export function connectMultiplayer(handlers: MultiplayerHandlers) {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let lastSent: PlayerState | undefined;
  let lastSentAt = 0;

  function open() {
    handlers.onStatus("connecting");

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.hostname}:${GAME_SERVER_PORT}`);
    socket = ws;

    ws.onopen = () => {
      lastSent = undefined;
      handlers.onStatus("online");
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      switch (message.type) {
        case "welcome":
          handlers.onWelcome(message.id, message.players);
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
      if (socket !== ws || closed) return;
      handlers.onStatus("offline");
      reconnectTimer = setTimeout(open, RECONNECT_MS);
    };
  }

  open();

  return {
    // Safe to call every frame: throttled, and skipped while nothing changes.
    sendState(state: PlayerState) {
      if (socket?.readyState !== WebSocket.OPEN) return;

      const now = performance.now();
      if (now - lastSentAt < SEND_INTERVAL_MS) return;
      if (lastSent && sameState(lastSent, state) && now - lastSentAt < IDLE_RESEND_MS) return;

      const message: ClientMessage = { type: "state", ...state };
      socket.send(JSON.stringify(message));
      lastSent = { ...state };
      lastSentAt = now;
    },

    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
