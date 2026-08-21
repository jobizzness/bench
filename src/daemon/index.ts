import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SessionRegistry } from "./registry.js";

const config = loadConfig();
const registry = new SessionRegistry(config);
const server = createServer({ config, registry });


server.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`bench: http://127.0.0.1:${config.port}/?token=${config.token}\n`);
});

// Children are killed deliberately so no orphaned claude processes survive
// the daemon.
const shutdown = () => {
  for (const row of registry.list()) registry.stop(row.id);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
