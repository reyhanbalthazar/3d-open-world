// One HTTP server for the whole game: Next.js pages plus the multiplayer WebSocket.
//   dev:        node server/index.ts --dev
//   production: next build && node server/index.ts
// Node runs this TypeScript directly (type stripping, Node >= 22.18).

import { createServer } from "node:http";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import next from "next";
import { attachGameServer } from "./game.ts";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 3000);
// Unset means Node's default: every IPv6 and IPv4 address (IPv4 only on machines without IPv6).
// Binding "0.0.0.0" would drop IPv6, and Firefox reaches "localhost" over ::1 first.
const hostname = process.env.HOST;

// a WebSocket upgrade nobody takes over within this long is dropped instead of hanging
const UPGRADE_TIMEOUT_MS = 10_000;

const server = createServer((req, res) => handle(req, res));
const app = next({ dev, port, httpServer: server });
const handle = app.getRequestHandler();

const game = attachGameServer(server);
await app.prepare();

// Every WebSocket upgrade passes through here first. The game's own path goes to the game server;
// the rest (hot reload in dev) is left to the upgrade listener Next.js adds on its first request.
// A request nobody takes over is dropped after a while instead of hanging: hanging hot-reload
// reconnects pile up, and Firefox, which keeps at most six connections per server, is then left
// with none to load the page with.
server.on("upgrade", (req, socket, head) => {
  // ws (used by both the game server and Next.js) clears this timeout when it takes the socket over
  if (socket instanceof Socket) socket.setTimeout(UPGRADE_TIMEOUT_MS, () => socket.destroy());
  game.handleUpgrade(req, socket, head);
});

server.listen(port, hostname, () => {
  console.log(`> Ready on http://localhost:${port} (${dev ? "development" : "production"})`);

  // Next.js only adds its upgrade listener (which answers hot reload) while handling its first
  // request. Make that happen right away: after a restart, open tabs reconnect hot reload before
  // anyone loads a page, and those reconnects would otherwise go unanswered.
  const self = hostname && hostname !== "0.0.0.0" && hostname !== "::" ? hostname : "127.0.0.1";
  fetch(`http://${self.includes(":") ? `[${self}]` : self}:${port}/favicon.ico`).catch((error) => {
    console.warn(`> Warm-up request failed (${error.message}); hot reload connects on the first page load`);
  });

  const lanAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((info) => info && info.family === "IPv4" && !info.internal)
    .map((info) => info!.address);
  for (const address of lanAddresses) {
    console.log(`> Other devices on the network: http://${address}:${port}`);
  }
});
