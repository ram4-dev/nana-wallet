// Run from the repository: node --import tsx apps/nana-wallet/scripts/dev-proxy-e2e.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { developmentProxies } from "../dev-proxy.ts";

const directory = await mkdtemp(join(tmpdir(), "nana-proxy-e2e-"));
const name = `nana-proxy-check-${process.pid}`;
const origin = `https://${name}.localhost`;
const received = [];
const upstream = httpServer((request, response) => {
  received.push(request.url);
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "authentication_required" }));
});
const sockets = new WebSocketServer({ noServer: true });
upstream.on("upgrade", (request, socket, head) => {
  received.push(request.url);
  sockets.handleUpgrade(request, socket, head, (connection) => {
    connection.send("signaling-proxy-ok");
  });
});
let vite;
let browser;
let registered = false;
try {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  await writeFile(
    join(directory, "index.html"),
    "<html><title>Proxy E2E</title><body>Proxy E2E</body></html>",
  );
  vite = await createServer({
    root: directory,
    configFile: false,
    server: {
      host: "127.0.0.1",
      port: 0,
      allowedHosts: [new URL(origin).hostname],
      proxy: developmentProxies({
        NANA_API_PROXY_TARGET: target,
        NANA_LIVEKIT_PROXY_TARGET: target,
      }),
    },
  });
  await vite.listen();
  execFileSync("portless", ["alias", name, String(vite.httpServer.address().port)], {
    stdio: "pipe",
  });
  registered = true;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const networkErrors = [];
  page.on("requestfailed", (request) => networkErrors.push(request.failure()?.errorText));
  assert.equal((await page.goto(origin)).status(), 200);
  const result = await page.evaluate(async () => {
    const binding = await fetch("/api/v1/live-bindings?probe=1", {
      method: "POST",
      headers: { authorization: "Bearer e2e-invalid-token", "content-type": "application/json" },
      body: "{}",
    });
    const signal = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`wss://${location.host}/livekit/rtc?probe=1`);
      socket.onmessage = (event) => {
        resolve(event.data);
        socket.close();
      };
      socket.onerror = () => reject(new Error("WebSocket proxy failed"));
      setTimeout(() => reject(new Error("WebSocket proxy timed out")), 10000);
    });
    return { status: binding.status, body: await binding.json(), signal };
  });
  assert.equal(result.status, 401);
  assert.equal(result.body.error, "authentication_required");
  assert.equal(result.signal, "signaling-proxy-ok");
  assert.deepEqual(received, ["/v1/live-bindings?probe=1", "/rtc?probe=1"]);
  assert.deepEqual(networkErrors, []);
  console.log(
    "PASS: trusted HTTPS 200, browser binding fetch 401 without CORS, WSS upgrade and prefix/query forwarding.",
  );
} finally {
  await browser?.close();
  await vite?.close();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  await new Promise((resolve) => upstream.close(resolve));
  if (registered) execFileSync("portless", ["alias", "--remove", name], { stdio: "pipe" });
  await rm(directory, { recursive: true, force: true });
}
