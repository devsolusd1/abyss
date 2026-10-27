// Screenshots of site pages through Edge's DevTools protocol, no dependencies:
//
//   node shoot.mjs <out-folder> <width>x<height> <url> [<url> ...]
//
// Each URL becomes <out-folder>/<n>.png, taken after the page has loaded and a settle time
// (SETTLE_MS, default 5000) so WebGL has drawn. Set MOBILE=1 to emulate a touch phone at the
// given size (headless Edge will not open a window narrower than 500 px on its own). BEFORE=<js>
// runs in the page after the settle time (say, to scroll to a section), then waits AFTER_MS (800).
// ANGLE picks how WebGL is drawn: d3d11 (the graphics card, the default) or swiftshader (the CPU).
//
// Screenshots weigh on the machine they run on, which is someone's working PC: this process, and
// the Edge it starts (which inherits it), run at low priority, and runs started at the same time
// wait for each other, so only one Edge renders at a time.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, openSync, closeSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { tmpdir, setPriority, constants } from "node:os";
import { join } from "node:path";

const [out, size, ...urls] = process.argv.slice(2);
if (!out || !size || !urls.length) {
  console.error("usage: node shoot.mjs <out> <w>x<h> <url>...");
  process.exit(2);
}
const [width, height] = size.split("x").map(Number);
const settle = Number(process.env.SETTLE_MS ?? 5000);
const mobile = process.env.MOBILE === "1";
const EDGE = process.env.EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ANGLE = process.env.ANGLE ?? "d3d11";
const port = 9300 + Math.floor(Math.random() * 500);
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { setPriority(constants.priority.PRIORITY_LOW); } catch {}

// one run at a time: a lock file holding the owner's pid; a lock whose owner is gone is stale
const LOCK = join(tmpdir(), "brasa-shoot.lock");
function owner() { try { return Number(readFileSync(LOCK, "utf8")) || 0; } catch { return 0; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
async function lock() {
  for (let waited = 0; ; waited += 500) {
    try { const fd = openSync(LOCK, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd); return; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    const pid = owner();
    let age = 0; try { age = Date.now() - statSync(LOCK).mtimeMs; } catch { continue; }
    if (pid ? !alive(pid) : age > 10000) { try { unlinkSync(LOCK); } catch {} continue; }
    if (waited && waited % 30000 === 0) console.error(`waiting for another screenshot run (pid ${pid})...`);
    await sleep(500);
  }
}
await lock();
process.on("exit", () => { if (owner() === process.pid) { try { unlinkSync(LOCK); } catch {} } });

const profile = mkdtempSync(join(tmpdir(), "shoot-"));
const gl = ANGLE === "swiftshader" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [`--use-angle=${ANGLE}`];
const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars",
  ...gl, `--window-size=${Math.max(width, 500)},${height}`, "about:blank",
], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Edge did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const waiters = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) waiters.splice(0).forEach((w) => w(msg));
});
const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const event = (name, ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  const check = (msg) => { if (msg.method === name) { clearTimeout(t); resolve(msg); } else waiters.push(check); };
  waiters.push(check);
});

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

let n = 0;
for (const url of urls) {
  n++;
  const loaded = event("Page.loadEventFired", 20000);
  await send("Page.navigate", { url });
  await loaded;
  await sleep(settle);
  if (process.env.BEFORE) {
    await send("Runtime.evaluate", { expression: process.env.BEFORE, awaitPromise: true });
    await sleep(Number(process.env.AFTER_MS ?? 800));
  }
  const errors = await send("Runtime.evaluate", { expression: "window.__errors ? JSON.stringify(window.__errors) : ''", returnByValue: true });
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const file = join(out, `${String(n).padStart(2, "0")}.png`);
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log(`${file}  ${url}${errors.result?.result?.value ? "  errors: " + errors.result.result.value : ""}`);
}
ws.close();
edge.kill();
process.exit(0);
