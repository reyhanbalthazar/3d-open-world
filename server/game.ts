// Multiplayer relay: every player's position and animation is forwarded to everyone else.
// Attached to the same HTTP server as Next.js, on the GAME_SOCKET_PATH WebSocket endpoint.
//
// New connections only watch (that is what the join screen shows behind it). They become players
// by sending "join" with a name nobody else is using and one of the known characters.

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { MIXAMO_ANIMATIONS } from "../lib/animation-catalog.ts";
import { isCharacterId, type CharacterId } from "../lib/characters.ts";
import {
  GAME_SOCKET_PATH,
  nameKey,
  normalizeName,
  type AnimName,
  type JoinErrorReason,
  type PlayerInfo,
  type PlayerState,
  type ServerMessage,
} from "../lib/protocol.ts";
import { MAP_HALF, PLAYER_RADIUS } from "../lib/world.ts";

const MAX_PLAYERS = 16;
// players plus people still on the join screen
const MAX_CONNECTIONS = 32;
const MAX_PAYLOAD_BYTES = 1024;
// clients send ~15 updates per second; anything far above that is dropped
const MAX_MESSAGES_PER_SECOND = 30;
const HEARTBEAT_MS = 10_000;
const POSITION_LIMIT = MAP_HALF - PLAYER_RADIUS;
const ANIMS = new Set<string>([
  ...(["Idle", "Walk", "Run"] satisfies AnimName[]),
  ...MIXAMO_ANIMATIONS.map((animation) => animation.name),
]);

interface Player {
  name: string;
  character: CharacterId;
  state: PlayerState | null;
}

interface Connection {
  id: string;
  socket: WebSocket;
  // null while the connection is still on the join screen
  player: Player | null;
  alive: boolean;
  windowStart: number;
  messageCount: number;
}

function clamp(value: number) {
  return Math.min(POSITION_LIMIT, Math.max(-POSITION_LIMIT, value));
}

function parseMessage(raw: RawData): Record<string, unknown> | null {
  try {
    const message: unknown = JSON.parse(raw.toString());
    return message && typeof message === "object" ? (message as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseState(message: Record<string, unknown>): PlayerState | null {
  const { x, z, yaw, anim } = message;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof z !== "number" || !Number.isFinite(z)) return null;
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return null;
  if (typeof anim !== "string" || !ANIMS.has(anim)) return null;

  return { x: clamp(x), z: clamp(z), yaw, anim: anim as AnimName };
}

export function attachGameServer(server: Server) {
  const connections = new Map<string, Connection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  function send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  // Everyone gets updates, including connections still choosing their name.
  function broadcast(message: ServerMessage, exceptId?: string) {
    for (const connection of connections.values()) {
      if (connection.id !== exceptId) send(connection.socket, message);
    }
  }

  function players() {
    return [...connections.values()].filter((connection) => connection.player);
  }

  function info(connection: Connection): PlayerInfo {
    const { name, character, state } = connection.player!;
    return { id: connection.id, name, character, state };
  }

  function join(connection: Connection, message: Record<string, unknown>): JoinErrorReason | null {
    const name = normalizeName(message.name);
    if (!name) return "invalid_name";
    if (!isCharacterId(message.character)) return "invalid_character";

    const others = players();
    const key = nameKey(name);
    if (others.some((other) => nameKey(other.player!.name) === key)) return "name_taken";
    if (others.length >= MAX_PLAYERS) return "server_full";

    connection.player = { name, character: message.character, state: null };
    return null;
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

    if (connections.size >= MAX_CONNECTIONS) {
      socket.close(1013, "server full");
      return;
    }

    const connection: Connection = {
      id: randomUUID().slice(0, 8),
      socket,
      player: null,
      alive: true,
      windowStart: Date.now(),
      messageCount: 0,
    };
    connections.set(connection.id, connection);
    send(socket, { type: "welcome", players: players().map(info) });

    socket.on("pong", () => {
      connection.alive = true;
    });

    socket.on("message", (raw) => {
      const now = Date.now();
      if (now - connection.windowStart >= 1000) {
        connection.windowStart = now;
        connection.messageCount = 0;
      }
      if (++connection.messageCount > MAX_MESSAGES_PER_SECOND) return;

      const message = parseMessage(raw);
      if (!message) return;

      if (message.type === "join") {
        if (connection.player) return;
        const error = join(connection, message);
        if (error) {
          send(socket, { type: "join_error", reason: error });
          return;
        }
        send(socket, { type: "joined", id: connection.id });
        broadcast({ type: "player_joined", player: info(connection) }, connection.id);
        console.log(`[game] ${connection.player!.name} joined (${players().length} playing)`);
        return;
      }

      if (message.type === "state" && connection.player) {
        const state = parseState(message);
        if (!state) return;
        connection.player.state = state;
        broadcast({ type: "state", id: connection.id, ...state }, connection.id);
      }
    });

    socket.on("close", () => {
      connections.delete(connection.id);
      if (!connection.player) return;
      broadcast({ type: "leave", id: connection.id });
      console.log(`[game] ${connection.player.name} left (${players().length} playing)`);
    });
  });

  // Drop connections whose laptop went to sleep or lost Wi-Fi without closing the socket.
  // The pings also keep hosting proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, HEARTBEAT_MS);

  server.on("close", () => {
    clearInterval(heartbeat);
    wss.close();
  });
}
