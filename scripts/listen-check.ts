/**
 * Does production Firestore accept this daemon's Firebase ID token on the
 * gRPC `Listen` endpoint? The emulator test cannot answer that - it takes an
 * unsigned token - so this is the one-shot check, run by hand on a machine
 * where `bench remote` is already on:
 *
 *   npx tsx scripts/listen-check.ts
 *
 * Read-only: it opens a listener on this machine's own presence document and
 * `commands` collection, waits for the stream to become consistent, and
 * exits. Nothing is written to Firestore. If the refresh token rotates during
 * the exchange the new one is saved, exactly as the daemon would.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { loadIdentity, saveIdentity } from "../src/daemon/remote/identity-file.js";
import { exchangeRefreshToken } from "../src/daemon/remote/token-refresh.js";
import { FirestoreListener } from "../src/daemon/remote/firestore-listen.js";
import { FIREBASE_WEB_CONFIG } from "../src/shared/firebase-config.js";

const home = process.env.BENCH_HOME ?? join(homedir(), ".bench");
const identity = loadIdentity(home);
if (!identity) {
  console.error(`no identity in ${home}/firebase.json - turn remote on first (bench remote on)`);
  process.exit(2);
}

const exchanged = await exchangeRefreshToken(FIREBASE_WEB_CONFIG.apiKey, identity.refreshToken);
if (exchanged.refreshToken !== identity.refreshToken) saveIdentity(home, { ...identity, refreshToken: exchanged.refreshToken });

const base = `users/${identity.uid}/machines/${identity.machineId}`;
const started = Date.now();
let changes = 0;
const listener = new FirestoreListener({
  projectId: FIREBASE_WEB_CONFIG.projectId,
  idToken: () => exchanged.idToken,
  targets: [
    { key: "presence", kind: "document", path: `${base}/presence/state` },
    { key: "commands", kind: "collection", path: `${base}/commands` },
  ],
  onChange: () => { changes++; },
  warn: (message) => { process.stderr.write(message); },
});
listener.start();

const deadline = Date.now() + 15_000;
while (!listener.healthy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

if (listener.healthy()) {
  console.log(`OK: Listen stream consistent in ${Date.now() - started}ms `
    + `(presence ${listener.docs("presence").length ? "present" : "absent"}, `
    + `${listener.docs("commands").length} pending commands, ${changes} change events)`);
  listener.stop();
  process.exit(0);
}
console.error("FAIL: the Listen stream did not become consistent within 15s - see the warning above. "
  + "The daemon will keep polling; BENCH_REMOTE_LISTEN=0 silences the attempt.");
listener.stop();
process.exit(1);
