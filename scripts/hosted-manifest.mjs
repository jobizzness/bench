/**
 * The manifest for a copy of the cockpit that no daemon is serving.
 *
 * The daemon builds its own per request, because its start_url carries the
 * token. Static hosting has no token to carry - the installed app asks for a
 * cockpit link on first run and remembers it - so that one manifest is a
 * file, written here from the same source as the other.
 *
 * Usage: node scripts/hosted-manifest.mjs <out-dir>
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { benchManifest } from "../dist/daemon/manifest.js";

const out = join(process.argv[2] ?? "dist/client", "manifest.webmanifest");
await writeFile(out, JSON.stringify(benchManifest(""), null, 2) + "\n");
process.stdout.write(`bench: ${out}\n`);
