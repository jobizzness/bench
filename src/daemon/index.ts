import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { HomeInUse, takeHomeLock } from "./lock.js";
import { SessionRegistry } from "./registry.js";
import { CorruptIndex } from "./store.js";
import { cockpitUrls, isLoopback } from "./urls.js";

const config = loadConfig();

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
const server = createServer({ config, registry });

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
});

// Children are killed deliberately so no orphaned claude processes survive
// the daemon.
const shutdown = () => {
  for (const row of registry.list()) registry.stop(row.id);
  releaseHome();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
