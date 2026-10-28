// Serves this folder for local previews: `node dex/site/serve.mjs [port]`, on this machine only (HOST=0.0.0.0 to open
// it to the network). `/x` falls back to `/x.html`, and folders to their index.html. /api/rpc, /api/history and /api/price run the
// same code as on Vercel (../server), with the node's address from the environment or from ../.env.local
// (RPC_URL_DEVNET=…; git ignores it), never sent to the page.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { handleRpc } from "../server/rpc.mjs";
import { handleHistory } from "../server/history.mjs";
import { handlePrice } from "../server/price.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 4900);
const host = process.env.HOST ?? "127.0.0.1";
const env = { ...process.env };
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");   // quotes around a value are not part of it
  }
} catch { /* no local settings: devnet uses the public node */ }
const API = { "/api/rpc": handleRpc, "/api/history": handleHistory, "/api/price": handlePrice };
const MAX_BODY = 64 * 1024;

/** A Node request as a web Request, through one of the API handlers, and back. */
async function api(handler, req, res) {
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(c); }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    // the caller is the one at the other end of the socket, whatever its headers say
    for (const k of ["x-forwarded-for", "x-forwarded-host", "x-real-ip"]) headers.delete(k);
    headers.set("x-real-ip", req.socket.remoteAddress ?? "local");
    const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
    const response = await handler(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not a request this server takes" }));
  }
}
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

async function resolve(path) {
  const candidates = [path, `${path}.html`, join(path, "index.html")];
  for (const file of candidates) {
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {}
  }
  return null;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (API[url.pathname]) { await api(API[url.pathname], req, res); return; }
    const path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const file = await resolve(path);
    if (!file || file.includes(`${root}chain`)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch {
    if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
  }
}).listen(port, host, () => console.log(`dex site on http://localhost:${port}`));
