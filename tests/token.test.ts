import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken } from "../src/daemon/token.js";

afterEach(() => { delete process.env.BENCH_TOKEN; });

describe("loadToken", () => {
  it("mints a token on first run", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-token-"));
    const token = loadToken(home);

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect((await readFile(join(home, "token"), "utf8")).trim()).toBe(token);
  });

  it("keeps the same token across restarts", async () => {
    // A restart that changes the token silently breaks whatever the
    // developer had open.
    const home = await mkdtemp(join(tmpdir(), "bench-token-"));
    expect(loadToken(home)).toBe(loadToken(home));
  });

  it("writes it readable only by its owner", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-token-"));
    loadToken(home);

    const mode = (await stat(join(home, "token"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("lets the environment override the file", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-token-"));
    process.env.BENCH_TOKEN = "supplied-from-outside";
    expect(loadToken(home)).toBe("supplied-from-outside");
  });

  it("mints a fresh one when the file is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-token-"));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "token"), "   \n");

    expect(loadToken(home)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("creates the home directory rather than failing", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "bench-token-")), "nested", "bench");
    expect(loadToken(home)).toMatch(/^[0-9a-f]{48}$/);
  });
});
