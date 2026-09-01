import { describe, it, expect } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearIdentity, loadIdentity, mintMachineId, saveIdentity,
} from "../src/daemon/remote/identity-file.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bench-remote-"));
}

describe("~/.bench/firebase.json", () => {
  it("is nothing until remote has ever been turned on", async () => {
    expect(loadIdentity(await home())).toBeNull();
  });

  it("round-trips whatever it was given", async () => {
    const dir = await home();
    const identity = { uid: "u1", refreshToken: "rt1", machineId: "m1" };
    saveIdentity(dir, identity);
    expect(loadIdentity(dir)).toEqual(identity);
  });

  it("keeps the email when one was given, and omits it when not", async () => {
    const dir = await home();
    saveIdentity(dir, { uid: "u1", refreshToken: "rt1", machineId: "m1", email: "dev@example.com" });
    expect(loadIdentity(dir)?.email).toBe("dev@example.com");
  });

  it("is written mode 0600, the same treatment as ~/.bench/token", async () => {
    const dir = await home();
    saveIdentity(dir, { uid: "u1", refreshToken: "rt1", machineId: "m1" });
    const mode = (await stat(join(dir, "firebase.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("stays mode 0600 after being overwritten, not just on first write", async () => {
    const dir = await home();
    saveIdentity(dir, { uid: "u1", refreshToken: "rt1", machineId: "m1" });
    saveIdentity(dir, { uid: "u1", refreshToken: "rt2", machineId: "m1" });
    const mode = (await stat(join(dir, "firebase.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates the home directory if remote is turned on before anything else touched it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "bench-remote-fresh-"));
    const dir = join(parent, "not-yet-created");
    saveIdentity(dir, { uid: "u1", refreshToken: "rt1", machineId: "m1" });
    expect(loadIdentity(dir)).not.toBeNull();
  });

  it("is gone after being cleared, and clearing an absent file is not an error", async () => {
    const dir = await home();
    saveIdentity(dir, { uid: "u1", refreshToken: "rt1", machineId: "m1" });
    clearIdentity(dir);
    expect(loadIdentity(dir)).toBeNull();
    expect(() => clearIdentity(dir)).not.toThrow();
  });

  it("reads back nothing from a file that is not the shape it expects", async () => {
    const dir = await home();
    saveIdentity(dir, { uid: "u1", refreshToken: "rt1", machineId: "m1" });
    // Overwrite with something that parses as JSON but is not an identity.
    const fs = await import("node:fs");
    fs.writeFileSync(join(dir, "firebase.json"), JSON.stringify({ uid: "u1" }));
    expect(loadIdentity(dir)).toBeNull();
  });

  it("never returns the same machine id twice", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintMachineId()));
    expect(ids.size).toBe(50);
  });
});
