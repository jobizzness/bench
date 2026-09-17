import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devinFamilies } from "../src/daemon/devin-models.js";

/**
 * `devin models list --format json`'s real shape is captured in
 * `fixtures/devin-models.json` (devin 3000.10.23); the inline fakes below
 * exercise the fallbacks and failure modes the fixture cannot.
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
  it("parses the real CLI output - family_label, slug, aliases, and the largest variant context", async () => {
    const fixture = await readFile(new URL("./fixtures/devin-models.json", import.meta.url), "utf8");
    const bin = await fakeDevin(printsAndExits(fixture));
    expect(await devinFamilies(bin)).toEqual([
      { id: "claude-opus-5", label: "Claude Opus 5", aliases: ["opus"], contextWindow: 1000000 },
      { id: "claude-fable-5.1", label: "Claude Fable 5.1", aliases: [], contextWindow: 1000000 },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", aliases: ["claude", "sonnet"], contextWindow: 1000000 },
    ]);
  });

  it("takes the largest max_context_tokens across a family's variants", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify({ families: [{
      family_label: "SWE-2", slug: "swe-2",
      variants: [{ max_context_tokens: 128000 }, { max_context_tokens: 262000 }, { label: "no figure" }],
    }] })));
    expect(await devinFamilies(bin)).toEqual([
      { id: "swe-2", label: "SWE-2", aliases: [], contextWindow: 262000 },
    ]);
  });

  it("reports a null contextWindow when no variant carries one", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify({ families: [
      { family_label: "Adaptive", slug: "adaptive", variants: [] },
    ] })));
    expect(await devinFamilies(bin)).toEqual([
      { id: "adaptive", label: "Adaptive", aliases: [], contextWindow: null },
    ]);
  });

  it("reads a bare top-level array", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([
      { family: "adaptive", label: "Adaptive" },
      { family: "opus", label: "Opus" },
    ])));
    expect(await devinFamilies(bin)).toEqual([
      { id: "adaptive", label: "Adaptive", aliases: [], contextWindow: null },
      { id: "opus", label: "Opus", aliases: [], contextWindow: null },
    ]);
  });

  it("reads a `models` array on the result object", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify({
      models: [{ slug: "adaptive", title: "Adaptive" }],
    })));
    expect(await devinFamilies(bin)).toEqual([
      { id: "adaptive", label: "Adaptive", aliases: [], contextWindow: null },
    ]);
  });

  it("falls back to the slug as its own label when no family_label names it", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([{ id: "adaptive" }])));
    expect(await devinFamilies(bin)).toEqual([
      { id: "adaptive", label: "adaptive", aliases: [], contextWindow: null },
    ]);
  });

  it("keeps only string aliases", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([
      { slug: "opus", family_label: "Opus", aliases: ["o", 5, null, "o5"] },
    ])));
    expect(await devinFamilies(bin)).toEqual([
      { id: "opus", label: "Opus", aliases: ["o", "o5"], contextWindow: null },
    ]);
  });

  it("dedupes families that appear more than once, keeping the first", async () => {
    const bin = await fakeDevin(printsAndExits(JSON.stringify([
      { family: "swe-2", label: "SWE-2 (low)" },
      { family: "swe-2", label: "SWE-2 (high)" },
    ])));
    expect(await devinFamilies(bin)).toEqual([
      { id: "swe-2", label: "SWE-2 (low)", aliases: [], contextWindow: null },
    ]);
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
    expect(await devinFamilies(bin)).toEqual([
      { id: "opus", label: "Opus", aliases: [], contextWindow: null },
    ]);
  });
});
