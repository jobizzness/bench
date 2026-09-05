/**
 * Screenshot the cockpit at a genuine phone viewport.
 *
 * `--window-size` does not do this: headless Chrome clamps the layout
 * viewport to a 500px minimum and crops the PNG, which is what sank #84.
 * Device metrics have to be overridden over CDP instead. The token goes
 * through the debugging socket rather than argv, so it never reaches `ps`.
 *
 * Usage: node shot390.mjs <path> <out.png> [width] [height]
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const path = process.argv[2] ?? "/";
const out = process.argv[3] ?? "/tmp/shot390.png";
const width = Number(process.argv[4] ?? 390);
const height = Number(process.argv[5] ?? 844);

const token = readFileSync(join(homedir(), ".bench", "token"), "utf8").trim();
const url = `http://127.0.0.1:7420${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

const PORT = 9333;
const profile = "/tmp/cdp-profile";
rmSync(profile, { recursive: true, force: true });

const chrome = spawn("google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome never exposed a page target");
}

const ws = new WebSocket(await targets());
await new Promise((r) => ws.on("open", r));

let next = 1;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = next++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send("Emulation.setDeviceMetricsOverride", {
  width, height, deviceScaleFactor: 2, mobile: true,
});
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(5000);

// Prove the viewport is what was asked for, rather than assuming it.
const measured = await send("Runtime.evaluate", {
  expression: `JSON.stringify({inner: innerWidth, client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth, pane: document.querySelector("#app")?.dataset.pane ?? null,
    sheet: !!document.querySelector("dialog[open]")})`,
  returnByValue: true,
});
console.log("measured:", measured.result.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("wrote", out);

ws.close();
chrome.kill();
