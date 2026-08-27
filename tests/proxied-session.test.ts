import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ClaudeSession } from "../src/daemon/claude-session.js";

/**
 * Echoes everything that decides who answers a specialist: where its requests
 * go, which credential goes with them, what window it was told to assume, and
 * the model name that reached the CLI.
 */
const PROXY_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const argv = process.argv.slice(2);
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake",
      result: "base:" + (process.env.ANTHROPIC_BASE_URL ?? "none")
        // What the real CLI would go on to ask for. It appends the version
        // itself, so the base alone does not say whether a turn will land -
        // and asserting the base alone is what let a base that resolves to a
        // 404 sit here looking correct.
        + " url:" + (process.env.ANTHROPIC_BASE_URL
          ? process.env.ANTHROPIC_BASE_URL.replace(/\\/+$/, "") + "/v1/messages"
          : "none")
        + " key:" + (process.env.ANTHROPIC_API_KEY ?? "none")
        + " oat:" + (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "none")
        + " ctx:" + (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "none")
        + " model:" + (argv[argv.indexOf("--model") + 1] ?? "none"),
    }) + "\\n");
  }
});
`;

async function makeFakeCli(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-fakecli-"));
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

async function makeSession(over: Record<string, unknown> = {}) {
  const claudeBin = await makeFakeCli(PROXY_CLI);
  const worktree = await mkdtemp(join(tmpdir(), "bench-wt-"));
  const reportsDir = join(worktree, ".bench", "reports", "sess-1");
  await mkdir(reportsDir, { recursive: true });

  return new ClaudeSession({
    id: "sess-1",
    label: "tester",
    worktree,
    reportsDir,
    hookCommand: "node /nonexistent/hook.js",
    pluginDir: join(process.cwd(), "plugin"),
    model: "opus",
    port: 3100,
    claudeBin,
    ...over,
  });
}

/** Run one turn and read what the fake CLI saw. */
async function ask(over: Record<string, unknown>): Promise<string> {
  const session = await makeSession(over);
  const replied = once(session, "reply");
  session.open();
  session.send("go");
  const reply = (await replied)[0] as string;
  session.stop();
  return reply;
}

describe("a specialist answered by OpenRouter", () => {
  it("sends its requests there instead of to Anthropic", async () => {
    const reply = await ask({
      model: "google/gemini-3.7-flash",
      via: { key: "sk-or-v1-abc", contextLength: 1_048_576 },
    });
    // The address the turn actually goes to, not the base it was built from.
    // Pointed to our local loopback proxy.
    expect(reply).toContain("url:http://127.0.0.1:7420/api/openrouter/v1/messages");
  });

  it("passes the OpenRouter id to the CLI untouched", async () => {
    // Verified against the real CLI: it does not recognise the name, warns
    // about the context window, and puts the string on the wire as given -
    // which is exactly what OpenRouter needs in order to route it.
    const reply = await ask({
      model: "google/gemini-3.7-flash",
      via: { key: "sk-or-v1-abc" },
    });
    expect(reply).toContain("model:google/gemini-3.7-flash");
  });

  it("authenticates as the OpenRouter key", async () => {
    // OpenRouter takes a key on x-api-key, which is the header the CLI puts
    // ANTHROPIC_API_KEY on.
    const reply = await ask({
      model: "openai/gpt-5.6-luna",
      via: { key: "sk-or-v1-abc" },
    });
    expect(reply).toContain("key:sk-or-v1-abc");
  });

  it("is told how much the model actually holds", async () => {
    // Otherwise the CLI assumes 200k for a model it has never heard of and
    // auto-compacts there, throwing away most of a million-token window.
    const reply = await ask({
      model: "google/gemini-3.7-flash",
      via: { key: "sk-or-v1-abc", contextLength: 1_048_576 },
    });
    expect(reply).toContain("ctx:1048576");
  });

  it("is told nothing about the window when OpenRouter did not say", async () => {
    // A wrong window is worse than the CLI's own honest default.
    const before = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    try {
      const reply = await ask({
        model: "weird/no-context",
        via: { key: "sk-or-v1-abc", contextLength: null },
      });
      expect(reply).toContain("ctx:none");
    } finally {
      if (before !== undefined) process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = before;
    }
  });

  it("is not given the developer's Anthropic credential", async () => {
    // It buys the specialist nothing - OpenRouter would not accept it - and
    // it costs something: a Claude key in ANTHROPIC_API_KEY makes the CLI
    // drop the claude.ai login, which turns off connectors.
    const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const reply = await ask({
        model: "google/gemini-3.7-flash",
        via: { key: "sk-or-v1-abc" },
        apiKey: () => "sk-ant-oat01-from-settings",
      });
      expect(reply).toContain("oat:none");
      expect(reply).toContain("key:sk-or-v1-abc");
    } finally {
      if (before !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
    }
  });
});

describe("a specialist on Anthropic", () => {
  it("is left pointed where it already pointed", async () => {
    // A bench that changes nothing for the models that never needed routing.
    const before = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const reply = await ask({ model: "opus" });
      expect(reply).toContain("base:none");
      expect(reply).toContain("model:opus");
    } finally {
      if (before !== undefined) process.env.ANTHROPIC_BASE_URL = before;
    }
  });

  it("still gets the developer's key", async () => {
    const reply = await ask({ model: "opus", apiKey: () => "sk-ant-from-settings" });
    expect(reply).toContain("key:sk-ant-from-settings");
  });

  it("is not told a context window, which the CLI already knows", async () => {
    const before = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    try {
      expect(await ask({ model: "sonnet" })).toContain("ctx:none");
    } finally {
      if (before !== undefined) process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = before;
    }
  });
});
