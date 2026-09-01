import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { HomeInUse, takeHomeLock } from "./lock.js";
import { SessionRegistry } from "./registry.js";
import { usageSource } from "./usage.js";
import { creditSource } from "./gemini.js";
import { CorruptIndex } from "./store.js";
import { onStopKey } from "./stop-key.js";
import { cockpitUrls, isLoopback } from "./urls.js";
import { RemoteController } from "./remote/controller.js";
import { FIREBASE_WEB_CONFIG } from "../shared/firebase-config.js";

const config = loadConfig();

// Bench's own version, for the machine document - best effort, since a
// daemon run from somewhere unusual (no package.json beside it) should still
// start rather than fail here.
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(config.installRoot, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Exists whether or not remote has ever been turned on - it is only a file
// read away from doing anything, and `resume()` below is that read. A daemon
// with no `~/.bench/firebase.json` behaves exactly as if this were absent.
const remote = new RemoteController({
  home: config.home,
  apiKey: FIREBASE_WEB_CONFIG.apiKey,
  projectId: FIREBASE_WEB_CONFIG.projectId,
  version,
});

// Before anything reads or writes this home. A second daemon on one home is
// two rosters and two writers, and it is how an index got corrupted and a
// cockpit came up empty.
let releaseHome: () => void;
try {
  releaseHome = takeHomeLock(config.home);
} catch (error) {
  if (!(error instanceof HomeInUse)) throw error;
  process.stderr.write(`bench: ${error.message}\n`);
  process.exit(1);
}

const registry = new SessionRegistry(config);
// The registry holds the key; the server may not read it. Composed here,
// where both are in scope, so the usage panel can be asked as that key
// without the key itself ever crossing into the server.
const server = createServer({
  config,
  registry,
  usage: usageSource({ benchKey: () => registry.getApiKey() }),
  credit: creditSource({ key: () => registry.getRouterKey() }),
  remote,
});

// Resumes a Google identity from `~/.bench/firebase.json` if remote was ever
// turned on. Never throws - a dead or missing credential just leaves remote
// off, the same as a fresh install.
await remote.resume();

// Specialists outlive the daemon: the roster comes back from disk before
// anyone can ask for it.
try {
  await registry.restore();
} catch (error) {
  if (!(error instanceof CorruptIndex)) throw error;
  // Starting anyway would show an empty cockpit and then write that emptiness
  // over the file on the first new specialist. Every specialist in there is
  // still recoverable while nothing has written to it, so nothing does.
  releaseHome();
  process.stderr.write(
    `bench: ${error.message}\n`
    + "  Your specialists are still on disk. Bench will not start rather than\n"
    + "  write over an index it could not read.\n"
    + `  Move ${error.path} aside to start with an empty bench.\n`,
  );
  process.exit(1);
}

server.listen(config.port, config.host, () => {
  const urls = cockpitUrls({ host: config.host, port: config.port, token: config.token });
  for (const url of urls) process.stdout.write(`bench: ${url}\n`);

  if (!isLoopback(config.host)) {
    // Said plainly and once. The token is the whole of the authentication,
    // it travels in the URL over plain HTTP, and a specialist has a full
    // shell - so anyone on this network holding it can run anything here.
    process.stdout.write(
      "bench: reachable on this network. The token in that URL is the only thing"
      + " standing in front of a shell on this machine.\n",
    );
  }

  // Last, because it is the only line here that is an instruction rather
  // than a fact - and because it is the one you look for when you are done.
  process.stdout.write("bench: press q or ctrl-c to stop.\n");
});

// Children are killed deliberately so no orphaned claude processes survive
// the daemon.
let stopping = false;

const shutdown = () => {
  // A second press means the first one did not work, and arguing about it is
  // how a daemon ends up killed with -9 while it still holds the port.
  if (stopping) { releaseHome(); process.exit(1); }
  stopping = true;
  process.stdout.write("bench: stopping.\n");

  restoreTerminal();
  for (const row of registry.list()) registry.stop(row.id);
  server.closeSockets();

  // The sockets are gone by here in every case we know of. The timer is
  // because stopping is not a negotiation: a daemon that will not stop is
  // one that gets killed, and a killed daemon is how two of them ended up
  // writing one index.
  const giveUp = setTimeout(done, 2000);
  giveUp.unref();
  server.close(done);
};

/**
 * The lock goes last, at the moment of exit.
 *
 * Released at the top of a shutdown that then hung, it was worse than no
 * lock at all: the daemon was still there, still holding a roster, and had
 * already told the next one the home was free. Two processes, one index.
 */
function done(): void {
  releaseHome();
  process.exit(0);
}

const restoreTerminal = onStopKey(shutdown);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
