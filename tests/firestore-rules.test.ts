import { describe, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

/**
 * Proves the one rule in `firestore.rules` against the real Firestore
 * emulator - `run test:rules` starts it and runs only this file. Gated the
 * same way `tests/e2e.test.ts` gates against the real `claude` CLI: skipped
 * by default so `pnpm test` needs neither Java nor the emulator, run by hand
 * (or in CI with the emulator available) when the rule itself changes.
 */
const run = process.env.BENCH_RULES_TEST === "1" ? describe : describe.skip;

let testEnv: RulesTestEnvironment;

run("firestore.rules", () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "bench-cockpit-rules-test",
      firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
    });
  });

  afterAll(async () => { await testEnv?.cleanup(); });

  it("lets the owner read and write under their own uid", async () => {
    const owner = testEnv.authenticatedContext("owner-uid").firestore();
    await assertSucceeds(owner.doc("users/owner-uid/x").set({ a: 1 }));
    await assertSucceeds(owner.doc("users/owner-uid/x").get());
  });

  it("denies a different signed-in uid on the same path", async () => {
    const stranger = testEnv.authenticatedContext("stranger-uid").firestore();
    await assertFails(stranger.doc("users/owner-uid/x").set({ a: 1 }));
    await assertFails(stranger.doc("users/owner-uid/x").get());
  });

  it("denies a request with no signed-in user at all", async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(anon.doc("users/owner-uid/x").get());
  });

  it("admits a machine document under the owner's own path, same rule as anything else they own", async () => {
    const owner = testEnv.authenticatedContext("owner-uid").firestore();
    await assertSucceeds(owner.doc("users/owner-uid/machines/m1").set({ name: "laptop" }));
  });
});
