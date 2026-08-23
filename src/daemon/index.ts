import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SessionRegistry } from "./registry.js";
import { cockpitUrls, isLoopback } from "./urls.js";

const config = loadConfig();
const registry = new SessionRegistry(config);
const server = createServer({ config, registry });

// Specialists outlive the daemon: the roster comes back from disk before
// anyone can ask for it.
await registry.restore();

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
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
