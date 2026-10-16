// Multiplayer relay: every player's position and animation is forwarded to everyone else.
// Attached to the same HTTP server as Next.js, on the GAME_SOCKET_PATH WebSocket endpoint.

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { GAME_SOCKET_PATH, type AnimName, type PlayerState, type ServerMessage } from "../lib/protocol.ts";
import { MAP_HALF, PLAYER_RADIUS } from "../lib/world.ts";

const MAX_PLAYERS = 16;
const MAX_PAYLOAD_BYTES = 1024;
// clients send ~15 updates per second; anything far above that is dropped
const MAX_MESSAGES_PER_SECOND = 30;
const HEARTBEAT_MS = 10_000;
const POSITION_LIMIT = MAP_HALF - PLAYER_RADIUS;
const ANIMS = new Set<string>(["Idle", "Walk", "Run"] satisfies AnimName[]);

interface Player {
  socket: WebSocket;
  // null until the first update, so others never see a player standing at the origin
  state: PlayerState | null;
  alive: boolean;
  windowStart: number;
  messageCount: number;
}

function clamp(value: number) {
  return Math.min(POSITION_LIMIT, Math.max(-POSITION_LIMIT, value));
}

function parseState(raw: RawData): PlayerState | null {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return null;
  }

  const { type, x, z, yaw, anim } = message;
  if (type !== "state") return null;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof z !== "number" || !Number.isFinite(z)) return null;
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return null;
  if (typeof anim !== "string" || !ANIMS.has(anim)) return null;

  return { x: clamp(x), z: clamp(z), yaw, anim: anim as AnimName };
}

export function attachGameServer(server: Server) {
  const players = new Map<string, Player>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  function send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  function broadcast(message: ServerMessage, exceptId?: string) {
    for (const [id, player] of players) {
      if (id !== exceptId) send(player.socket, message);
    }
  }

  // Only take over our own path; other upgrades (Next.js hot reload in dev) are left to Next.
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== GAME_SOCKET_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket) => {
    // e.g. a message over MAX_PAYLOAD_BYTES; ws closes the socket itself, this keeps it from being uncaught
    socket.on("error", (error) => {
      console.warn(`[game] socket error: ${error.message}`);
    });

    if (players.size >= MAX_PLAYERS) {
      socket.close(1013, "server full");
      return;
    }

    const id = randomUUID().slice(0, 8);
    const player: Player = { socket, state: null, alive: true, windowStart: Date.now(), messageCount: 0 };

    const others: Array<{ id: string } & PlayerState> = [];
    for (const [otherId, other] of players) {
      if (other.state) others.push({ id: otherId, ...other.state });
    }
    send(socket, { type: "welcome", id, players: others });

    players.set(id, player);
    console.log(`[game] ${id} joined (${players.size} online)`);

    socket.on("pong", () => {
      player.alive = true;
    });

    socket.on("message", (raw) => {
      const now = Date.now();
      if (now - player.windowStart >= 1000) {
        player.windowStart = now;
        player.messageCount = 0;
      }
      if (++player.messageCount > MAX_MESSAGES_PER_SECOND) return;

      const state = parseState(raw);
      if (!state) return;
      player.state = state;
      broadcast({ type: "state", id, ...state }, id);
    });

    socket.on("close", () => {
      players.delete(id);
      broadcast({ type: "leave", id });
      console.log(`[game] ${id} left (${players.size} online)`);
    });
  });

  // Drop players whose laptop went to sleep or lost Wi-Fi without closing the socket.
  // The pings also keep hosting proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    for (const player of players.values()) {
      if (!player.alive) {
        player.socket.terminate();
        continue;
      }
      player.alive = false;
      player.socket.ping();
    }
  }, HEARTBEAT_MS);

  server.on("close", () => {
    clearInterval(heartbeat);
    wss.close();
  });
}
