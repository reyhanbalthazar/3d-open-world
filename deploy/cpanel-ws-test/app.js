// WebSocket test for cPanel shared hosting ("Setup Node.js App").
// Checks that the host passes wss:// upgrades through to Node, keeps connections open,
// and runs the app as a single process (the game keeps its player list in memory).
"use strict";

const http = require("node:http");
const { WebSocketServer } = require("ws");

const PING_MS = 25_000;
const startedAt = Date.now();

const PAGE = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tes WebSocket</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px 16px; background: #141416; color: #e8e8ea; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #9a9aa2; }
  .card { background: #1d1d21; border: 1px solid #2c2c33; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
  .row span:first-child { color: #9a9aa2; }
  .row span:last-child { font-family: ui-monospace, monospace; text-align: right; overflow-wrap: anywhere; }
  .ok { color: #5fd38d; } .bad { color: #ff6b6b; } .wait { color: #f5c451; }
  #status { font-weight: 600; }
  #log { font: 12px/1.6 ui-monospace, monospace; color: #b5b5bd; max-height: 220px; overflow: auto; white-space: pre-wrap; }
  ol { margin: 0; padding-left: 20px; } li { margin: 4px 0; }
</style>
</head>
<body>
<main>
  <h1>Tes WebSocket untuk game</h1>
  <p class="sub">Halaman ini mengecek apakah hosting bisa menjalankan server game multiplayer.</p>

  <div class="card">
    <div class="row"><span>Status</span><span id="status" class="wait">Menghubungkan…</span></div>
    <div class="row"><span>Alamat</span><span id="url"></span></div>
    <div class="row"><span>Latensi</span><span id="latency">–</span></div>
    <div class="row"><span>Tersambung selama</span><span id="duration">–</span></div>
    <div class="row"><span>Jumlah terputus</span><span id="drops">0</span></div>
  </div>

  <div class="card">
    <div class="row"><span>ID proses server (PID)</span><span id="pid">–</span></div>
    <div class="row"><span>Koneksi di proses ini</span><span id="clients">–</span></div>
    <div class="row"><span>Server hidup selama</span><span id="uptime">–</span></div>
    <div class="row"><span>Versi Node</span><span id="node">–</span></div>
  </div>

  <div class="card">
    <ol>
      <li><b>WebSocket tembus:</b> status harus hijau "Tersambung".</li>
      <li><b>Satu proses:</b> buka halaman ini di tab lain atau HP. "Koneksi di proses ini" harus naik jadi 2 dan PID-nya sama di kedua tab.</li>
      <li><b>Koneksi awet:</b> biarkan terbuka 10 menit. "Jumlah terputus" idealnya tetap 0.</li>
    </ol>
  </div>

  <div class="card"><div id="log"></div></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const wsPath = location.pathname.replace(/\\/+$/, "") + "/ws";
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + wsPath;
  $("url").textContent = url;

  let socket, connectedAt = 0, drops = 0, everConnected = false, pingTimer;

  function log(text) {
    const time = new Date().toLocaleTimeString();
    $("log").textContent = time + "  " + text + "\\n" + $("log").textContent;
  }

  function setStatus(text, cls) {
    $("status").textContent = text;
    $("status").className = cls;
  }

  function formatSeconds(s) {
    const m = Math.floor(s / 60);
    return (m ? m + " mnt " : "") + (s % 60) + " dtk";
  }

  function connect() {
    setStatus("Menghubungkan…", "wait");
    socket = new WebSocket(url);

    socket.onopen = () => {
      everConnected = true;
      connectedAt = Date.now();
      setStatus("Tersambung", "ok");
      log("tersambung");
      pingTimer = setInterval(() => socket.send(JSON.stringify({ type: "ping", t: performance.now() })), 2000);
    };

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "pong") {
        $("latency").textContent = Math.round(performance.now() - msg.t) + " ms";
      } else if (msg.type === "info") {
        $("pid").textContent = msg.pid;
        $("clients").textContent = msg.clients;
        $("uptime").textContent = formatSeconds(msg.uptime);
        $("node").textContent = msg.node;
      }
    };

    socket.onclose = (event) => {
      clearInterval(pingTimer);
      if (connectedAt) {
        drops++;
        $("drops").textContent = drops;
        log("terputus setelah " + formatSeconds(Math.round((Date.now() - connectedAt) / 1000)) + " (kode " + event.code + ")");
      } else {
        log("gagal tersambung (kode " + event.code + ")");
      }
      connectedAt = 0;
      setStatus(everConnected ? "Terputus, mencoba lagi…" : "Gagal: hosting kemungkinan tidak meneruskan WebSocket", "bad");
      setTimeout(connect, 3000);
    };
  }

  setInterval(() => {
    $("duration").textContent = connectedAt ? formatSeconds(Math.round((Date.now() - connectedAt) / 1000)) : "–";
  }, 1000);

  connect();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(PAGE);
});

const wss = new WebSocketServer({ noServer: true });

// The app may be mounted under a sub-path (e.g. /wstest), so accept any path ending in /ws.
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (!pathname.endsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function broadcastInfo() {
  const message = JSON.stringify({
    type: "info",
    pid: process.pid,
    node: process.version,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    clients: wss.clients.size,
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // echo pings back so the page can measure round-trip time
  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "ping") ws.send(JSON.stringify({ type: "pong", t: message.t }));
  });

  ws.on("close", broadcastInfo);
  broadcastInfo();
});

// Protocol-level pings keep proxies from closing idle connections and drop dead clients.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  broadcastInfo();
}, PING_MS);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`WebSocket test listening on ${port} (pid ${process.pid}, node ${process.version})`);
});
