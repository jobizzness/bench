/**
 * Screenshots of the real cockpit, driven through Chrome's debugging
 * protocol. jsdom cannot tell you what a layout looks like, and a README
 * that shows the product should show the product, not a mock of it.
 *
 * Usage: node scripts/shots.mjs <cockpit-url> [outDir]
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

const url = process.argv[2];
const outDir = process.argv[3] ?? "docs/screenshots";
if (!url) { console.error("usage: node scripts/shots.mjs <url> [outDir]"); process.exit(1); }

const PORT = 9333;
const chrome = spawn("google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--window-size=1600,1000", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await res.json()).filter((t) => t.type === "page");
      if (pages[0]?.webSocketDebuggerUrl) return pages[0].webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome never came up");
}

const socket = new WebSocket(await target());
await new Promise((r) => socket.once("open", r));

let nextId = 1;
const pending = new Map();
socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); waiter(message.result ?? {}); }
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId += 1;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    ?.result?.value;

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`  wrote ${name}.png`);
}

await mkdir(outDir, { recursive: true });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });
await sleep(2500);

console.log("capturing:");
await shot("01-roster");

// Select the first specialist and let its thread load.
const picked = await evaluate(`(() => {
  const row = document.querySelector("#roster-list .row");
  if (!row) return null;
  row.click();
  return row.querySelector(".label")?.textContent ?? "";
})()`);
if (picked === null) { console.log("  no specialist on the roster - stopping"); }
else {
  await sleep(2500);
  await shot("02-thread");

  // Open the most recent report, which is the page the whole design is for.
  const opened = await evaluate(`(() => {
    // The door is the button inside the card, not the card.
    const card = document.querySelector(".card-open, .artifact, [data-artifact]");
    if (!card) return false;
    card.click();
    return true;
  })()`);
  if (opened) { await sleep(2500); await shot("03-report"); }
  else console.log("  no report card found - skipped");
}

socket.close();
chrome.kill("SIGTERM");
process.exit(0);
