// LAN game server: relays every player's position and animation to everyone else.
// Run with `node server/game-server.mts` (Node strips the types natively).

import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { AnimName, PlayerState, ServerMessage } from "../lib/protocol";

// Keep in sync with GAME_SERVER_PORT in lib/protocol.ts.
const GAME_PORT = Number(process.env.GAME_PORT ?? 3001);
const HEARTBEAT_MS = 10_000;
const ANIMS = new Set<string>(["Idle", "Walk", "Run"] satisfies AnimName[]);

interface Player {
  socket: WebSocket;
  state: PlayerState;
  alive: boolean;
}

const players = new Map<string, Player>();

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage, exceptId?: string) {
  for (const [id, player] of players) {
    if (id !== exceptId) send(player.socket, message);
  }
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

  return { x, z, yaw, anim: anim as AnimName };
}

const wss = new WebSocketServer({ port: GAME_PORT });

wss.on("connection", (socket) => {
  const id = randomUUID().slice(0, 8);
  const player: Player = { socket, state: { x: 0, z: 0, yaw: Math.PI, anim: "Idle" }, alive: true };

  send(socket, {
    type: "welcome",
    id,
    players: [...players].map(([otherId, other]) => ({ id: otherId, ...other.state })),
  });

  players.set(id, player);
  console.log(`${id} joined (${players.size} online)`);

  socket.on("pong", () => {
    player.alive = true;
  });

  socket.on("message", (raw) => {
    const state = parseState(raw);
    if (!state) return;
    player.state = state;
    broadcast({ type: "state", id, ...state }, id);
  });

  socket.on("close", () => {
    players.delete(id);
    broadcast({ type: "leave", id });
    console.log(`${id} left (${players.size} online)`);
  });
});

// Drop players whose laptop went to sleep or lost Wi-Fi without closing the socket.
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

wss.on("close", () => clearInterval(heartbeat));

wss.on("listening", () => {
  const lanAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((info) => info && info.family === "IPv4" && !info.internal)
    .map((info) => info!.address);

  console.log(`WebSocket server listening on port ${GAME_PORT}`);
  for (const address of lanAddresses) {
    console.log(`other laptops on the LAN open http://${address}:3000`);
  }
});
