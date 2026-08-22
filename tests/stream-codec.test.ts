import { describe, it, expect } from "vitest";
import {
  LineDecoder,
  userMessageLine,
  isResultEvent,
  activityLine,
  replyText,
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

  it("truncates something far too long to read at a glance", () => {
    const line = activityLine(toolUse("Bash", { command: "x".repeat(200) }))!;
    expect(line.length).toBeLessThanOrEqual(72);
    expect(line.endsWith("\u2026")).toBe(true);
  });

  it("returns null for events with nothing worth showing", () => {
    expect(activityLine({ type: "system", subtype: "thinking_tokens" })).toBeNull();
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
