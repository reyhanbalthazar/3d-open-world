// One HTTP server for the whole game: Next.js pages plus the multiplayer WebSocket.
//   dev:        node server/index.ts --dev
//   production: next build && node server/index.ts
// Node runs this TypeScript directly (type stripping, Node >= 22.18).

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import next from "next";
import { attachGameServer } from "./game.ts";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 3000);
// Unset means Node's default: every IPv6 and IPv4 address (IPv4 only on machines without IPv6).
// Binding "0.0.0.0" would drop IPv6, and Firefox reaches "localhost" over ::1 first.
const hostname = process.env.HOST;

const server = createServer((req, res) => handle(req, res));
const app = next({ dev, port, httpServer: server });
const handle = app.getRequestHandler();

attachGameServer(server);
await app.prepare();

server.listen(port, hostname, () => {
  console.log(`> Ready on http://localhost:${port} (${dev ? "development" : "production"})`);

  const lanAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((info) => info && info.family === "IPv4" && !info.internal)
    .map((info) => info!.address);
  for (const address of lanAddresses) {
    console.log(`> Other devices on the network: http://${address}:${port}`);
  }
});
