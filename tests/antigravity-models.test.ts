import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { antigravityModels, parseModels } from "../src/daemon/antigravity-models.js";

async function fakeAgy(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-agy-models-test-"));
  const path = join(dir, "fake-agy.mjs");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

const printsAndExits = (stdout: string, code = 0) => `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${code});
`;

describe("parseModels", () => {
  it("parses CLI table formatted text", () => {
    const table = `
gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
claude-opus-5-5-high      Claude Opus 5.5 (High)
`;
    expect(parseModels(table)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    ]);
  });

  it("ignores headers, flags, and spinners", () => {
    const table = `
Fetching available models...
Usage: agy models [flags]
Flags:
  --help   Show help

gemini-3.8-flash-high     Gemini 3.8 Flash (High)
`;
    expect(parseModels(table)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    ]);
  });

  it("parses a JSON array", () => {
    const json = JSON.stringify([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
    expect(parseModels(json)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
  });

  it("parses an object with a models array", () => {
    const json = JSON.stringify({
      models: [
        { name: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      ],
    });
    expect(parseModels(json)).toEqual([
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ]);
  });

  it("returns empty array on blank or invalid string", () => {
    expect(parseModels("")).toEqual([]);
    expect(parseModels("   \n   ")).toEqual([]);
  });
});

describe("antigravityModels", () => {
  it("reads models from fake agy binary", async () => {
    const bin = await fakeAgy(printsAndExits(`
gemini-3.8-flash-high     Gemini 3.8 Flash (High)
claude-sonnet-5-5-high    Claude Sonnet 5.5 (High)
`));
    expect(await antigravityModels(bin)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
    ]);
  });

  it("returns empty array when agy command exits non-zero", async () => {
    const bin = await fakeAgy(`#!/usr/bin/env node
process.stderr.write("failed to initialize\\n");
process.exit(1);
`);
    expect(await antigravityModels(bin)).toEqual([]);
  });

  it("returns empty array when binary does not exist", async () => {
    expect(await antigravityModels("/nonexistent/agy-bin")).toEqual([]);
  });
});
