// Multiplayer relay: every player's position and animation is forwarded to everyone else.
// Attached to the same HTTP server as Next.js, on the GAME_SOCKET_PATH WebSocket endpoint.
//
// New connections only watch (that is what the join screen shows behind it). They become players
// by sending "join" with a name nobody else is using and one of the known characters.
//
// The server also owns what is broken in the world: a player holding a tool asks to break rocks
// (hammer), trees (axe) or plants (sickle); the server checks the tool fits and they are close
// enough, tells everyone, and grows each thing back after a while.
//
// Everything a player breaks adds to their Hunting Score, counted here. When they leave, their score
// is kept (until the server restarts) for when they come back with their token and the same name.

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { MIXAMO_ANIMATIONS } from "../lib/animation-catalog.ts";
import { isCharacterId, type CharacterId } from "../lib/characters.ts";
import {
  GAME_SOCKET_PATH,
  isToolName,
  MAX_BREAKS_PER_SWING,
  nameKey,
  normalizeName,
  POINTS,
  RESPAWN_MS,
  TOOLS,
  type AnimName,
  type JoinErrorReason,
  type PlayerInfo,
  type PlayerState,
  type ServerMessage,
} from "../lib/protocol.ts";
import { generateTerrainLayout } from "../lib/terrain-layout.ts";
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
// the player's position reaches the server ~15 times a second and may lag a step behind the swing
const REACH_TOLERANCE = 1.5;
const MIN_BREAK_INTERVAL_MS = 500;
// scores of players who left, kept for their return; past this many the longest gone are forgotten
const MAX_SAVED_SCORES = 256;

// the same breakable things, with the same ids, as every client's world
const BREAKABLES = new Map(generateTerrainLayout().breakables.map((breakable) => [breakable.id, breakable]));

interface Player {
  name: string;
  character: CharacterId;
  state: PlayerState | null;
  lastBreakAt: number;
  // Hunting Score
  score: number;
  // a secret only this player was given; coming back with it (and the same name) gets the score back
  token: string;
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
  const { x, z, yaw, anim, tool } = message;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof z !== "number" || !Number.isFinite(z)) return null;
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return null;
  if (typeof anim !== "string" || !ANIMS.has(anim)) return null;
  if (tool !== null && !isToolName(tool)) return null;

  return { x: clamp(x), z: clamp(z), yaw, anim: anim as AnimName, tool };
}

export function attachGameServer(server: Server) {
  const connections = new Map<string, Connection>();
  // broken thing id -> the timer that grows it back
  const broken = new Map<number, ReturnType<typeof setTimeout>>();
  // token of a player who left -> their score, and their name in nameKey() form
  const savedScores = new Map<string, { name: string; score: number }>();
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
    const { name, character, state, score } = connection.player!;
    return { id: connection.id, name, character, state, score };
  }

  function saveScore(player: Player) {
    savedScores.set(player.token, { name: nameKey(player.name), score: player.score });
    // a Map iterates in insertion order, so the first key is the longest gone
    if (savedScores.size > MAX_SAVED_SCORES) savedScores.delete(savedScores.keys().next().value!);
  }

  function join(connection: Connection, message: Record<string, unknown>): JoinErrorReason | null {
    const name = normalizeName(message.name);
    if (!name) return "invalid_name";
    if (!isCharacterId(message.character)) return "invalid_character";

    const others = players();
    const key = nameKey(name);
    if (others.some((other) => nameKey(other.player!.name) === key)) return "name_taken";
    if (others.length >= MAX_PLAYERS) return "server_full";

    // someone coming back (after a dropped connection or a page reload) gets their score back
    const token = typeof message.token === "string" ? message.token : "";
    const saved = savedScores.get(token);
    const returning = saved !== undefined && saved.name === key;
    if (returning) savedScores.delete(token);

    connection.player = {
      name,
      character: message.character,
      state: null,
      lastBreakAt: 0,
      score: returning ? saved.score : 0,
      token: returning ? token : randomBytes(16).toString("hex"),
    };
    return null;
  }

  // Breaks what this player could really have hit with the tool in their hand; whatever they
  // could not have hit is put back on their screen.
  function breakThings(connection: Connection, rawIds: unknown) {
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_BREAKS_PER_SWING) return;
    const player = connection.player!;
    const state = player.state;
    const tool = state?.tool ? TOOLS[state.tool] : undefined;
    const now = Date.now();
    const tooSoon = now - player.lastBreakAt < MIN_BREAK_INTERVAL_MS;

    const accepted: number[] = [];
    const refused: number[] = [];
    for (const rawId of new Set(rawIds)) {
      const target = typeof rawId === "number" ? BREAKABLES.get(rawId) : undefined;
      if (!target || broken.has(target.id)) continue;
      const fits =
        !tooSoon &&
        tool?.breaks === target.kind &&
        Math.hypot(state!.x - target.x, state!.z - target.z) - target.radius <= tool.reach + REACH_TOLERANCE;
      (fits ? accepted : refused).push(target.id);
    }

    if (refused.length > 0) send(connection.socket, { type: "restored", ids: refused });
    if (accepted.length === 0) return;

    player.lastBreakAt = now;
    for (const id of accepted) {
      const { kind } = BREAKABLES.get(id)!;
      player.score += POINTS[kind];
      const grow = () => {
        broken.delete(id);
        broadcast({ type: "restored", ids: [id] });
      };
      broken.set(id, setTimeout(grow, RESPAWN_MS[kind]));
    }
    broadcast({ type: "broken", ids: accepted, by: connection.id, score: player.score });
  }

  // Takes over WebSocket upgrades on our own path; server/index.ts hands everything else to Next.js.
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== GAME_SOCKET_PATH) return false;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return true;
  }

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
    send(socket, { type: "welcome", players: players().map(info), broken: [...broken.keys()] });

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
        const { name, score, token } = connection.player!;
        send(socket, { type: "joined", id: connection.id, score, token });
        broadcast({ type: "player_joined", player: info(connection) }, connection.id);
        console.log(`[game] ${name} joined (${players().length} playing)${score > 0 ? `, back with ${score} points` : ""}`);
        return;
      }

      if (message.type === "state" && connection.player) {
        const state = parseState(message);
        if (!state) return;
        connection.player.state = state;
        broadcast({ type: "state", id: connection.id, ...state }, connection.id);
        return;
      }

      if (message.type === "break" && connection.player) breakThings(connection, message.ids);
    });

    socket.on("close", () => {
      connections.delete(connection.id);
      const player = connection.player;
      if (!player) return;
      if (player.score > 0) saveScore(player);
      broadcast({ type: "leave", id: connection.id });
      console.log(`[game] ${player.name} left (${players().length} playing)`);
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
    for (const timer of broken.values()) clearTimeout(timer);
    wss.close();
  });

  return { handleUpgrade };
}
