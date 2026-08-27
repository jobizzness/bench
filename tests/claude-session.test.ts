import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod, mkdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ClaudeSession } from "../src/daemon/claude-session.js";

/** A stand-in for the claude CLI that speaks stream-json over stdio. */
const FAKE_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const text = JSON.parse(line).message.content;
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "echo:" + text,
    }) + "\\n");
  }
});
`;

/**
 * A CLI that takes its time. Each result reports how many stdin lines had
 * arrived by the moment it was produced, which is how a test can see whether
 * a queued prompt reached the CLI while a turn was still running.
 */
const SLOW_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let received = 0;
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    received += 1;
    const text = JSON.parse(line).message.content;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        session_id: "fake",
        result: "echo:" + text + "|received=" + received,
      }) + "\\n");
    }, 250);
  }
});
`;

/** Echoes the argv it was launched with, so a test can assert on flags. */
const ARGS_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "argv:" + process.argv.slice(2).join(" "),
    }) + "\\n");
  }
});
`;

/** Echoes the API key it was launched with, so a test can assert on auth. */
const ENV_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "key:" + (process.env.ANTHROPIC_API_KEY ?? "none"),
    }) + "\\n");
  }
});
`;

/** Echoes the model the session was told it is running on. */
const SELF_MODEL_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "self:" + (process.env.BENCH_SELF_MODEL ?? "none"),
    }) + "\\n");
  }
});
`;

/** Echoes both credential variables, so a test can assert which one a
 * setup-token lands in. */
const OAUTH_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake",
      result: "oat:" + (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "none")
        + " key:" + (process.env.ANTHROPIC_API_KEY ?? "none"),
    }) + "\\n");
  }
});
`;

/**
 * A CLI answered by OpenRouter, shaped as a real proxied transcript is.
 *
 * Two API requests per turn, each spread over several assistant events that
 * all repeat its generation id, then the CLI's own synthetic message, then a
 * result whose `usage.iterations` has one entry per request - the count the
 * collected ids must agree with. The ids carry the turn number so a test can
 * tell one turn's bill from the next's. Each turn takes 200ms, which leaves a
 * window in which a queued turn is running but has not yet finished.
 */
const ROUTED_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let turn = 0;
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    turn += 1;
    const n = turn;
    const say = (id, model) => process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { id, model, content: [{ type: "text", text: "working" }] },
      request_id: id, session_id: "fake",
    }) + "\\n");
    setTimeout(() => {
      for (let i = 0; i < 3; i++) say("gen-turn" + n + "-aaa", "deepseek/deepseek-v4-pro");
      for (let i = 0; i < 2; i++) say("gen-turn" + n + "-bbb", "deepseek/deepseek-v4-pro");
      say("gen-turn" + n + "-refused", "<synthetic>");
      process.stdout.write(JSON.stringify({
        type: "result", subtype: "success", is_error: false, session_id: "fake",
        result: "echo:turn" + n,
        usage: { iterations: [{ input_tokens: 1 }, { input_tokens: 2 }] },
        modelUsage: { "openrouter/auto": { inputTokens: 3, contextWindow: 200000 } },
      }) + "\\n");
    }, 200);
  }
});
`;

/** The same, answered by Anthropic directly: `req_...` and `msg_...`. */
const DIRECT_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_011CeTPX94L5HsA8N7XGU51X", model: "claude-opus-5",
        content: [{ type: "text", text: "working" }],
      },
      request_id: "req_011CeTPX6jvfZbhJJLsPmEbs", session_id: "fake",
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "done",
    }) + "\\n");
  }
});
`;

/** Dies the way the real CLI does when asked to resume a session that is
 * not there: one line on stderr, exit 1, nothing on stdout. */
const DYING_CLI = `#!/usr/bin/env node
process.stderr.write("No conversation found with session ID: sess-1\\n");
process.exit(1);
`;

async function makeFakeCli(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-fakecli-"));
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

async function makeSession(cli: string = FAKE_CLI, over: Record<string, unknown> = {}) {
  const claudeBin = await makeFakeCli(cli);
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

describe("ClaudeSession", () => {
  it("opens without starting a turn", async () => {
    // A specialist is created before anyone has said what it is for. It must
    // sit there costing nothing until it is prompted.
    const session = await makeSession();
    const opts = (session as any).opts;

    session.open();
    await new Promise((r) => setTimeout(r, 150));

    expect(session.turn).toBe(0);
    await expect(access(join(opts.reportsDir, ".turn"))).rejects.toThrow();
    session.stop();
  });

  it("emits turn-end when the result event arrives", async () => {
    const session = await makeSession();
    const ended = once(session, "turn-end");
    session.open();
    session.send("do the thing");

    const [result] = await ended;
    expect(result.type).toBe("result");
    // The message is framed with a turn header, so match on the payload.
    expect(result.result).toContain("do the thing");
    session.stop();
  });

  it("carries the developer's house rules into every turn", async () => {
    // Read per turn, not captured at spawn: a rule saved while a specialist
    // is running has to reach it without a restart.
    let rules = "";
    const session = await makeSession(FAKE_CLI, { rules: () => rules });
    session.open();

    session.send("first");
    const [before] = await once(session, "turn-end");
    expect(before.result).not.toContain("House rules");

    rules = "[bench] House rules. Comments say why.";
    session.send("second");
    const [after] = await once(session, "turn-end");

    expect(after.result).toContain("Comments say why");
    // Standing instructions first, the ask last - the nearest thing to the
    // prompt should be the prompt.
    expect(after.result.indexOf("House rules")).toBeLessThan(after.result.indexOf("second"));
    session.stop();
  });

  it("carries a context/spend nudge into the turn it is given for", async () => {
    // Read per turn, the same as rules - the fact it reports only exists
    // once the specialist is already running.
    let nudge = "";
    const session = await makeSession(FAKE_CLI, { nudge: () => nudge });
    session.open();

    session.send("first");
    const [before] = await once(session, "turn-end");
    expect(before.result).not.toContain("context is");

    nudge = "[bench] Your context is 90% full.";
    session.send("second");
    const [after] = await once(session, "turn-end");

    expect(after.result).toContain("context is 90% full");
    expect(after.result.indexOf("context is 90%")).toBeLessThan(after.result.indexOf("second"));
    session.stop();
  });

  it("increments the turn counter across turns", async () => {
    const session = await makeSession();
    session.open();

    session.send("first");
    await once(session, "turn-end");
    expect(session.turn).toBe(1);

    session.send("second");
    await once(session, "turn-end");
    expect(session.turn).toBe(2);

    session.stop();
  });

  it("delivers a later prompt as the next user message", async () => {
    const session = await makeSession();
    session.open();
    session.send("first");
    await once(session, "turn-end");

    const ended = once(session, "turn-end");
    session.send("chose option A");
    const [result] = await ended;

    expect(result.result).toContain("chose option A");
    expect(result.result).toContain("Turn 2");
    session.stop();
  });

  it("leaves the choice of report or reply to the agent", async () => {
    const session = await makeSession();
    const ended = once(session, "turn-end");
    session.open();
    session.send("do it");
    const [result] = await ended;

    // The framing names the directory and the four cases, and says the call
    // is the agent's. It must never declare the turn's kind for it.
    expect(result.result).toMatch(/is your call/i);
    expect(result.result).toMatch(/stuck/i);
    expect(result.result).not.toMatch(/no report is required/i);
    session.stop();
  });

  it("emits activity lines for tool calls", async () => {
    const session = await makeSession();
    const seen: string[] = [];
    session.on("activity", (line: string) => seen.push(line));

    session.open();
    session.send("work");
    await once(session, "turn-end");

    expect(seen).toContain("Bash");
    session.stop();
  });

  it("emits exit when the process ends", async () => {
    const session = await makeSession();
    session.open();
    session.send("work");
    await once(session, "turn-end");

    const exited = once(session, "exit");
    session.stop();
    await exited;
  });

  it("writes a turn marker naming the current turn", async () => {
    const session = await makeSession();
    session.open();
    session.send("work");
    await once(session, "turn-end");

    const opts = (session as any).opts;
    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("1");

    session.send("next");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("2");

    session.stop();
  });

  it("holds a mid-turn prompt until the running turn has ended", async () => {
    const session = await makeSession(SLOW_CLI);
    const results: string[] = [];
    session.on("turn-end", (ev: any) => results.push(String(ev.result)));

    session.open();
    session.send("do the work");
    // Arrives while turn 1 is still running.
    session.send("what directory are you in?");

    await once(session, "turn-end");
    // Turn 1 must have been the only thing the CLI had received.
    expect(results[0]).toContain("received=1");
    expect(results[0]).toContain("do the work");

    await once(session, "turn-end");
    expect(results).toHaveLength(2);
    expect(results[1]).toContain("what directory are you in?");
    expect(results[1]).toContain("Turn 2");

    session.stop();
  });

  it("folds several mid-turn prompts into one turn instead of one each", async () => {
    // Three quick follow-ups typed while turn 1 was still running used to
    // cost three resends of the whole conversation - one per queued turn.
    // They should land as a single turn 2 instead.
    const session = await makeSession(SLOW_CLI);
    const results: string[] = [];
    session.on("turn-end", (ev: any) => results.push(String(ev.result)));

    session.open();
    session.send("do the work");
    session.send("quick question one");
    session.send("quick question two");

    await once(session, "turn-end");
    expect(results[0]).toContain("received=1");

    await once(session, "turn-end");
    // Only turn 2 - a third queued turn would mean a third resend.
    expect(results).toHaveLength(2);
    expect(results[1]).toContain("received=2");
    expect(results[1]).toContain("quick question one");
    expect(results[1]).toContain("quick question two");

    session.stop();
  });

  it("advances the marker to the queued turn once the running turn ends", async () => {
    const session = await makeSession();
    const opts = (session as any).opts;

    // Both results can arrive in one chunk, so count from a listener
    // attached up front rather than awaiting once() twice in sequence.
    let ends = 0;
    const twoTurns = new Promise<void>((resolve) => {
      session.on("turn-end", () => { ends += 1; if (ends === 2) resolve(); });
    });

    session.open();
    session.send("do the work");
    session.send("quick question");
    await twoTurns;

    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("2");
    session.stop();
  });

  it("starts a new session by id", async () => {
    const session = await makeSession(ARGS_CLI);
    const ended = once(session, "turn-end");
    session.open();
    session.send("hello");
    const [result] = await ended;

    expect(result.result).toContain("--session-id sess-1");
    expect(result.result).not.toContain("--resume");
    session.stop();
  });

  it("hands the exit code and the child's last words to whoever is listening", async () => {
    // Without this the daemon can only say "process exited", and the one line
    // that explains why - which the CLI does print - is thrown away.
    const session = await makeSession(DYING_CLI);
    const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      session.on("exit", (code, stderr) => resolve({ code, stderr }));
    });

    session.open();
    const { code, stderr } = await exited;

    expect(code).toBe(1);
    expect(stderr).toContain("No conversation found with session ID: sess-1");
  });

  it("resumes an existing session instead of starting a new one", async () => {
    // After a daemon restart the CLI transcript is still on disk, so a
    // specialist can come back knowing what it was doing.
    const session = await makeSession(ARGS_CLI, { resume: true });
    const ended = once(session, "turn-end");
    session.open();
    session.send("hello");
    const [result] = await ended;

    expect(result.result).toContain("--resume sess-1");
    expect(result.result).not.toContain("--session-id");
    session.stop();
  });

  it("carries on numbering from the turns it already took", async () => {
    // A revived specialist that starts at one again writes over its own
    // earlier reports, and leaves the roster pointing at a stale directory.
    const session = await makeSession(FAKE_CLI, { startTurn: 3 });
    const opts = (session as any).opts;

    const ended = once(session, "turn-end");
    session.open();
    session.send("carry on");
    const [result] = await ended;

    expect(result.result).toContain("Turn 4");
    expect(session.turn).toBe(4);
    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("4");
    session.stop();
  });

  it("refuses to send before it has been opened", async () => {
    const session = await makeSession();
    expect(() => session.send("hi")).toThrow(/not started/i);
  });

  it("emits a reply for every turn", async () => {
    const session = await makeSession();
    const seen: string[] = [];
    session.on("reply", (text: string) => seen.push(text));

    session.open();
    session.send("do it");
    await once(session, "turn-end");
    expect(seen[0]).toContain("do it");

    session.send("why?");
    await once(session, "turn-end");
    expect(seen[1]).toContain("why?");

    session.stop();
  });
  it("carries the developer's key to the CLI as the API key", async () => {
    // The one thing a key in the cockpit has to do: be the key the CLI
    // authenticates with. Passed in the environment rather than on the
    // command line, where ps would show it to everything on the machine.
    const session = await makeSession(ENV_CLI, { apiKey: () => "sk-ant-from-settings" });
    const replied = once(session, "reply");
    session.open();
    session.send("go");

    expect((await replied)[0]).toBe("key:sk-ant-from-settings");
    session.stop();
  });

  it("leaves the environment as it found it when no key is set", async () => {
    // A bench with nothing set is a bench that changes nothing: a daemon
    // started with a key already in its environment keeps using it.
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-shell";
    try {
      const session = await makeSession(ENV_CLI, { apiKey: () => null });
      const replied = once(session, "reply");
      session.open();
      session.send("go");

      expect((await replied)[0]).toBe("key:sk-ant-from-the-shell");
      session.stop();
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });
  it("carries a setup-token to the CLI as an oauth token, not as an API key", async () => {
    // `claude setup-token` mints an OAuth token. The CLI reads those from
    // CLAUDE_CODE_OAUTH_TOKEN; handed over as ANTHROPIC_API_KEY it is a key
    // the API has never issued, and every turn fails to authenticate.
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const session = await makeSession(OAUTH_CLI, { apiKey: () => "sk-ant-oat01-from-settings" });
      const replied = once(session, "reply");
      session.open();
      session.send("go");

      expect((await replied)[0]).toBe("oat:sk-ant-oat01-from-settings key:none");
      session.stop();
    } finally {
      if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
    }
  });
  it("tells a specialist its own model, so a child it opens can inherit it", async () => {
    // `bench new` only forwards a model when the parent is on an auto
    // router; it can only make that call if it can see what it is running.
    const session = await makeSession(SELF_MODEL_CLI, { model: "openrouter/auto" });
    const replied = once(session, "reply");
    session.open();
    session.send("go");

    expect((await replied)[0]).toBe("self:openrouter/auto");
    session.stop();
  });

  it("collects one generation id per API request, not one per message", async () => {
    // Five assistant events, two requests. Counting the events would bill the
    // developer once per paragraph the model wrote.
    const session = await makeSession(ROUTED_CLI, { model: "openrouter/auto" });
    session.open();
    session.send("do the work");
    const [result] = await once(session, "turn-end");

    expect(session.turnGenerationIds).toEqual(["gen-turn1-aaa", "gen-turn1-bbb"]);
    // The cross-check worth having: the CLI counts the turn's requests too,
    // and if the two ever disagree the parser has started missing ids.
    expect(session.turnGenerationIds).toHaveLength(result.usage.iterations.length);
    session.stop();
  });

  it("records which model actually answered, not the one that was asked for", async () => {
    // The session was started on `openrouter/auto`. Only the assistant events
    // ever say what the router picked.
    const session = await makeSession(ROUTED_CLI, { model: "openrouter/auto" });
    session.open();
    session.send("do the work");
    await once(session, "turn-end");

    expect(session.turnAnsweredBy).toEqual(["deepseek/deepseek-v4-pro"]);
    session.stop();
  });

  it("ignores a turn Anthropic answered directly", async () => {
    // `req_...` is not a generation id and OpenRouter has never heard of it.
    // The CLI already prices this turn itself.
    const session = await makeSession(DIRECT_CLI);
    session.open();
    session.send("do the work");
    await once(session, "turn-end");

    expect(session.turnGenerationIds).toEqual([]);
    expect(session.turnAnsweredBy).toEqual(["claude-opus-5"]);
    session.stop();
  });

  it("starts each turn's bill from nothing", async () => {
    // Carried over, turn two would be charged for turn one as well - and the
    // total would grow without bound over a long-lived specialist.
    const session = await makeSession(ROUTED_CLI, { model: "openrouter/auto" });
    session.open();

    session.send("first");
    await once(session, "turn-end");
    expect(session.turnGenerationIds).toEqual(["gen-turn1-aaa", "gen-turn1-bbb"]);

    session.send("second");
    await once(session, "turn-end");
    expect(session.turnGenerationIds).toEqual(["gen-turn2-aaa", "gen-turn2-bbb"]);

    session.stop();
  });

  it("still has the finished turn's ids when a queued turn has already begun", async () => {
    // consume() dispatches the next queued turn before it emits turn-end, and
    // dispatching clears the running turn's ids. Read live rather than frozen
    // at the result event, the getter would be empty exactly here - so the
    // busiest specialist, the one with prompts stacked up behind it, would be
    // the one that appeared to cost nothing.
    const session = await makeSession(ROUTED_CLI, { model: "openrouter/auto" });

    const seen: string[][] = [];
    const later: string[][] = [];
    let ends = 0;
    const twoTurns = new Promise<void>((resolve) => {
      session.on("turn-end", async () => {
        // What a listener reading synchronously sees...
        seen.push([...session.turnGenerationIds]);
        // ...and what one that does a little work first sees. The registry's
        // listener awaits several times before it reads this.
        const mine = ends;
        await new Promise((r) => setTimeout(r, 0));
        later[mine] = [...session.turnGenerationIds];
        ends += 1;
        if (ends === 2) resolve();
      });
    });

    session.open();
    session.send("do the work");
    // Arrives while turn 1 is running, so turn 2 is dispatched inside the
    // same result event that ends turn 1.
    session.send("and the next thing");
    await twoTurns;

    expect(seen[0]).toEqual(["gen-turn1-aaa", "gen-turn1-bbb"]);
    expect(later[0]).toEqual(["gen-turn1-aaa", "gen-turn1-bbb"]);
    expect(seen[1]).toEqual(["gen-turn2-aaa", "gen-turn2-bbb"]);
    session.stop();
  });
});
