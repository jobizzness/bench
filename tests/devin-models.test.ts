import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devinFamilies } from "../src/daemon/devin-models.js";

/**
 * `devin models list --format json`'s real shape has not been observed
 * directly (#114 - `server.codeium.com` refused every attempt made while
 * building this), so these fakes stand in for it and exercise the tolerant
 * parser rather than one fixed schema.
 */
async function fakeDevin(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-devin-models-test-"));
  const path = join(dir, "fake-devin.mjs");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

const printsAndExits = (stdout: string, code = 0) => `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${code});
`;

describe("devinFamilies", () => {
  it("reads a bare top-level array", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([
      { family: "adaptive", label: "Adaptive" },
      { family: "opus", label: "Opus" },
    ])));
    expect(await devinFamilies(bin)).toEqual([
      { id: "adaptive", label: "Adaptive" },
      { id: "opus", label: "Opus" },
    ]);
  });

  it("reads a `families` array on the result object", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify({
      families: [{ id: "swe-2", name: "SWE-2" }],
    })));
    expect(await devinFamilies(bin)).toEqual([{ id: "swe-2", label: "SWE-2" }]);
  });

  it("reads a `models` array on the result object", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify({
      models: [{ slug: "adaptive", title: "Adaptive" }],
    })));
    expect(await devinFamilies(bin)).toEqual([{ id: "adaptive", label: "Adaptive" }]);
  });

  it("falls back to the id as its own label when nothing names it", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([{ id: "adaptive" }])));
    expect(await devinFamilies(bin)).toEqual([{ id: "adaptive", label: "adaptive" }]);
  });

  it("dedupes families that appear more than once, keeping the first", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([
      { family: "swe-2", label: "SWE-2 (low)" },
      { family: "swe-2", label: "SWE-2 (high)" },
    ])));
    expect(await devinFamilies(bin)).toEqual([{ id: "swe-2", label: "SWE-2 (low)" }]);
  });

  it("is empty, not thrown, when the CLI exits non-zero", async () => {
    // The condition this is built for (#114): server.codeium.com refusing
    // the request on this exact machine, observed live while building it.
    const bin = await fakeDevin(`#!/usr/bin/env node
process.stderr.write("Error: Connection failed\\n");
process.exit(1);
`);
    expect(await devinFamilies(bin)).toEqual([]);
  });

  it("is empty when the binary does not exist at all", async () => {
    expect(await devinFamilies("/nonexistent/devin-binary-xyz")).toEqual([]);
  });

  it("is empty when the output is not JSON", async () => {
    const bin = await fakeDevin(printsAndExits("not json at all"));
    expect(await devinFamilies(bin)).toEqual([]);
  });

  it("is empty when the JSON has no array this can find", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify({ ok: true })));
    expect(await devinFamilies(bin)).toEqual([]);
  });

  it("skips entries with no usable id", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([
      { label: "no id here" },
      { family: "opus", label: "Opus" },
    ])));
    expect(await devinFamilies(bin)).toEqual([{ id: "opus", label: "Opus" }]);
  });
});
