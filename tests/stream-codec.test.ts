import { describe, it, expect } from "vitest";
import {
  LineDecoder,
  userMessageLine,
  isResultEvent,
  activityLine,
  fileTouch,
  replyText,
  generationIdFrom,
  answeringModelFrom,
} from "../src/daemon/stream-codec.js";

describe("LineDecoder", () => {
  it("emits one event per complete line", () => {
    const d = new LineDecoder();
    const events = d.push('{"type":"system","subtype":"init"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
  });

  it("reassembles an event split across chunks", () => {
    const d = new LineDecoder();
    expect(d.push('{"type":"resu')).toHaveLength(0);
    const events = d.push('lt","subtype":"success","is_error":false,"session_id":"s1"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("result");
  });

  it("skips blank lines and unparseable lines without throwing", () => {
    const d = new LineDecoder();
    const events = d.push('\n{ not json }\n{"type":"system","subtype":"init"}\n');
    expect(events).toHaveLength(1);
  });

  it("holds a trailing partial line until it completes", () => {
    const d = new LineDecoder();
    d.push('{"type":"system","subtype":"init"}\n{"type":"assis');
    const events = d.push('tant","message":{"content":[]}}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
  });
});

describe("isResultEvent", () => {
  it("recognises the turn-end event", () => {
    expect(isResultEvent({ type: "result", subtype: "success", is_error: false, session_id: "s1" })).toBe(true);
  });

  it("does not treat an assistant message as a turn end", () => {
    expect(isResultEvent({ type: "assistant", message: { content: [] } })).toBe(false);
  });
});

describe("userMessageLine", () => {
  it("produces a single newline-terminated stream-json user message", () => {
    const line = userMessageLine("hello");
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
    });
  });
});

const toolUse = (name: string, input?: Record<string, unknown>) => ({
  type: "assistant" as const,
  message: { content: [{ type: "tool_use", name, input }] },
});

describe("activityLine", () => {
  it("names the tool when there is nothing else to say", () => {
    expect(activityLine(toolUse("Bash"))).toBe("Bash");
  });

  it("shows the command being run, not just that a command is running", () => {
    // "Bash" for twelve minutes is indistinguishable from a hang.
    expect(activityLine(toolUse("Bash", { command: "pnpm test" }))).toBe("Bash pnpm test");
  });

  it("collapses a multi-line command to its first line", () => {
    expect(activityLine(toolUse("Bash", { command: "pnpm build \\\n  && pnpm test" })))
      .toBe("Bash pnpm build");
  });

  it("shows which file is being edited", () => {
    expect(activityLine(toolUse("Edit", { file_path: "/var/www/bench/src/daemon/registry.ts" })))
      .toBe("Edit src/daemon/registry.ts");
  });

  it("keeps a short path whole", () => {
    expect(activityLine(toolUse("Read", { file_path: "README.md" }))).toBe("Read README.md");
  });

  it("shows what is being searched for", () => {
    expect(activityLine(toolUse("Grep", { pattern: "evaluateStop" }))).toBe("Grep evaluateStop");
  });

  it("names the skill being invoked", () => {
    expect(activityLine(toolUse("Skill", { skill: "bench-report" }))).toBe("Skill bench-report");
  });

  /**
   * A phone's roster row holds around 35 characters of status, so a line that
   * opens with an absolute path spends all of them on the path. Photographed
   * on a real phone: "Bash cat > /var/www/bench/.be…" - which tool, and
   * nothing else. The same rule `shortPath` already applies to a file
   * argument, applied inside a command.
   */
  it("shortens an absolute path inside a command, the way it does a file argument", () => {
    expect(activityLine(toolUse("Bash", { command: "cat > /var/www/bench/.bench/reports/abc/1/report.html" })))
      .toBe("Bash cat > abc/1/report.html");
  });

  it("shortens every path in a command, not just the first", () => {
    expect(activityLine(toolUse("Bash", { command: "cp /var/www/bench/a/b/c/one.png /var/www/bench/x/y/z/two.png" })))
      .toBe("Bash cp b/c/one.png y/z/two.png");
  });

  it("leaves a command with no absolute path exactly as it was", () => {
    expect(activityLine(toolUse("Bash", { command: "pnpm test -- --run" })))
      .toBe("Bash pnpm test -- --run");
  });

  it("leaves a relative path alone - it is already short enough to read", () => {
    expect(activityLine(toolUse("Bash", { command: "node scripts/shots.mjs" })))
      .toBe("Bash node scripts/shots.mjs");
  });

  it("keeps a short absolute path whole rather than trimming it to nothing", () => {
    expect(activityLine(toolUse("Bash", { command: "ls /etc/hosts" }))).toBe("Bash ls /etc/hosts");
  });

  it("does not maul a URL, which is not a path into a worktree", () => {
    expect(activityLine(toolUse("Bash", { command: "curl https://bench-cockpit.web.app/a/b/c/d.js" })))
      .toBe("Bash curl https://bench-cockpit.web.app/a/b/c/d.js");
  });

  it("truncates something far too long to read at a glance", () => {
    const line = activityLine(toolUse("Bash", { command: "x".repeat(200) }))!;
    expect(line.length).toBeLessThanOrEqual(72);
    expect(line.endsWith("\u2026")).toBe(true);
  });

  it("returns null for events with nothing worth showing", () => {
    expect(activityLine({ type: "system", subtype: "thinking_tokens" })).toBeNull();
  });
});

describe("fileTouch", () => {
  it("keeps the whole path, where the roster trail keeps only the tail", () => {
    const event = toolUse("Edit", { file_path: "/var/www/bench/src/daemon/registry.ts" });
    // The same event, two readings: one to show a phone, one to open an editor.
    expect(activityLine(event)).toBe("Edit src/daemon/registry.ts");
    expect(fileTouch(event)).toEqual({
      tool: "Edit",
      path: "/var/www/bench/src/daemon/registry.ts",
    });
  });

  /**
   * What the specialist actually wrote, so an editor can scroll to the change
   * rather than opening a 600-line file at line 1 and showing a file the
   * developer already knows. One line is enough to find it again, and keeps
   * the frame small on a socket that carries every tool call.
   */
  it("carries the first line an Edit wrote", () => {
    expect(fileTouch(toolUse("Edit", {
      file_path: "/tmp/a.ts",
      new_string: "  const total = price * quantity;\n  return total;",
    }))).toEqual({
      tool: "Edit",
      path: "/tmp/a.ts",
      wrote: "const total = price * quantity;",
    });
  });

  it("takes a MultiEdit's first edit, which is where to look first", () => {
    expect(fileTouch(toolUse("MultiEdit", {
      file_path: "/tmp/many.ts",
      edits: [{ old_string: "a", new_string: "alpha();" }, { old_string: "b", new_string: "beta();" }],
    }))).toEqual({ tool: "MultiEdit", path: "/tmp/many.ts", wrote: "alpha();" });
  });

  it("skips the blank lines an edit often opens with", () => {
    expect(fileTouch(toolUse("Edit", { file_path: "/tmp/a.ts", new_string: "\n\n  done();\n" })))
      .toMatchObject({ wrote: "done();" });
  });

  /** A whole new file has no region to jump to: the top of it is the change. */
  it("says nothing to scroll to for a Write", () => {
    expect(fileTouch(toolUse("Write", { file_path: "/tmp/new.ts", content: "hello\nworld" })))
      .toEqual({ tool: "Write", path: "/tmp/new.ts" });
  });

  it("keeps a minified line from filling the frame", () => {
    const wrote = fileTouch(toolUse("Edit", { file_path: "/tmp/a.ts", new_string: "x".repeat(400) }))!.wrote!;
    expect(wrote.length).toBeLessThanOrEqual(200);
    // Still a prefix of the real line, so it is still findable in the file.
    expect("x".repeat(400).startsWith(wrote)).toBe(true);
  });

  it("reports a Write", () => {
    expect(fileTouch(toolUse("Write", { file_path: "/tmp/new.ts" })))
      .toEqual({ tool: "Write", path: "/tmp/new.ts" });
  });

  it("reports a MultiEdit", () => {
    expect(fileTouch(toolUse("MultiEdit", { file_path: "/tmp/many.ts" })))
      .toEqual({ tool: "MultiEdit", path: "/tmp/many.ts" });
  });

  it("reads a notebook from its own field", () => {
    expect(fileTouch(toolUse("NotebookEdit", { notebook_path: "/tmp/book.ipynb" })))
      .toEqual({ tool: "NotebookEdit", path: "/tmp/book.ipynb" });
  });

  /**
   * The whole point of the event is "this file changed". A Read that opened
   * an editor would make every grep of the codebase a fight for the screen.
   */
  it("ignores a tool that only looks at a file", () => {
    expect(fileTouch(toolUse("Read", { file_path: "/var/www/bench/README.md" }))).toBeNull();
  });

  it("ignores a search", () => {
    expect(fileTouch(toolUse("Grep", { pattern: "evaluateStop" }))).toBeNull();
    expect(fileTouch(toolUse("Glob", { pattern: "**/*.ts" }))).toBeNull();
  });

  /**
   * `sed -i` and `>` redirects really do change files, and are invisible here.
   * Guessing at a path inside a shell command would open the wrong file more
   * often than the right one - see docs/specs/2026-09-15-editor-follow.md.
   */
  it("ignores a shell command, even one that clearly writes a file", () => {
    expect(fileTouch(toolUse("Bash", { command: "sed -i s/a/b/ /tmp/x.ts" }))).toBeNull();
  });

  it("returns null when an edit carries no path at all", () => {
    expect(fileTouch(toolUse("Edit"))).toBeNull();
  });

  it("returns null for an event that is not a tool call", () => {
    expect(fileTouch({ type: "system", subtype: "thinking_tokens" })).toBeNull();
  });

  /**
   * An assistant turn can narrate before it acts; the tool_use block is not
   * always first.
   */
  it("finds the edit behind a block of text", () => {
    expect(fileTouch({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Fixing the registry now." },
          { type: "tool_use", name: "Edit", input: { file_path: "/tmp/a.ts" } },
        ],
      },
    })).toEqual({ tool: "Edit", path: "/tmp/a.ts" });
  });
});

describe("replyText", () => {
  it("returns the final text of a result event", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false,
      session_id: "s1", result: "Because zod validates at the boundary.",
    })).toBe("Because zod validates at the boundary.");
  });

  it("trims surrounding whitespace", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false, session_id: "s1",
      result: "  spaced  ",
    })).toBe("spaced");
  });

  it("returns null for an empty result", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false, session_id: "s1", result: "   ",
    })).toBeNull();
  });

  it("returns null for a result with no text at all", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false, session_id: "s1",
    })).toBeNull();
  });

  it("returns null for events that are not results", () => {
    expect(replyText({ type: "assistant", message: { content: [] } })).toBeNull();
  });
});

/** An assistant event shaped as the CLI emits it, envelope and all. */
const answer = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
  type: "assistant" as const,
  message: {
    id: "gen-1787789159-g6lOnmHVsCllObXdrDId",
    model: "deepseek/deepseek-v4-pro",
    content: [{ type: "text", text: "hello" }],
    ...message,
  },
  request_id: "gen-1787789159-g6lOnmHVsCllObXdrDId",
  session_id: "s1",
  ...over,
});

describe("generationIdFrom", () => {
  it("reads the generation id off the request-id header", () => {
    // The header is what OpenRouter bills against, and the only way to ask it
    // afterwards what the request actually cost.
    expect(generationIdFrom(answer())).toBe("gen-1787789159-g6lOnmHVsCllObXdrDId");
  });

  it("falls back to the id on the message when there is no header", () => {
    // Same value by a different route. Losing the id because one of the two
    // places it appears was missing would lose the whole turn's true cost.
    expect(generationIdFrom(answer({ request_id: undefined })))
      .toBe("gen-1787789159-g6lOnmHVsCllObXdrDId");
  });

  it("ignores an Anthropic request id", () => {
    // `req_...` is Anthropic answering directly. The CLI already prices that
    // turn correctly, and OpenRouter has never heard of the id.
    expect(generationIdFrom(answer(
      { request_id: "req_011CeTPX6jvfZbhJJLsPmEbs" },
      { id: "msg_011CeTPX94L5HsA8N7XGU51X", model: "claude-opus-5" },
    ))).toBeNull();
  });

  it("ignores a synthetic message even when it carries a real generation id", () => {
    // Seen in a real transcript: the CLI's own "API Error: 402" message,
    // stamped with the generation id of the request that was refused. That
    // request was never served and never billed.
    expect(generationIdFrom(answer(
      { request_id: "gen-1787794347-HAy1IlfaE4QXhwyiN6TZ" },
      { id: "2d6b8cd1-77ff-44c4-9d36-4e698116769a", model: "<synthetic>" },
    ))).toBeNull();
  });

  it("returns null when there is no id at all", () => {
    expect(generationIdFrom(answer({ request_id: undefined }, { id: undefined }))).toBeNull();
  });

  it("returns null for events that are not assistant messages", () => {
    expect(generationIdFrom({ type: "system", subtype: "init" })).toBeNull();
    expect(generationIdFrom({
      type: "result", subtype: "success", is_error: false, session_id: "s1",
    })).toBeNull();
  });
});

describe("answeringModelFrom", () => {
  it("names the model that actually answered, not the one asked for", () => {
    // Under `openrouter/auto` this is the only place the router's choice is
    // ever visible: modelUsage on the result event says `openrouter/auto`.
    expect(answeringModelFrom(answer())).toBe("deepseek/deepseek-v4-pro");
  });

  it("names the resolved model on an Anthropic turn too", () => {
    expect(answeringModelFrom(answer({}, { model: "claude-opus-5" }))).toBe("claude-opus-5");
  });

  it("returns null for a synthetic message", () => {
    // The CLI wrote it. Nothing answered.
    expect(answeringModelFrom(answer({}, { model: "<synthetic>" }))).toBeNull();
  });

  it("returns null when no model is named", () => {
    expect(answeringModelFrom(answer({}, { model: undefined }))).toBeNull();
    expect(answeringModelFrom({ type: "assistant", message: { content: [] } })).toBeNull();
  });
});

describe("userMessageLine with images", () => {
  it("leaves a text-only prompt as the bare string it has always been", () => {
    const line = JSON.parse(userMessageLine("just words"));

    expect(line.message.content).toBe("just words");
  });

  it("puts the picture before the question about it", () => {
    const line = JSON.parse(userMessageLine("what is this", [
      { mediaType: "image/png", data: "AAAA" },
    ]));

    expect(line.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this" },
    ]);
  });

  it("keeps several images in the order they were attached", () => {
    const line = JSON.parse(userMessageLine("these two", [
      { mediaType: "image/png", data: "first" },
      { mediaType: "image/jpeg", data: "second" },
    ]));

    expect(line.message.content.map((b: any) => b.source?.data ?? b.text))
      .toEqual(["first", "second", "these two"]);
  });
});
