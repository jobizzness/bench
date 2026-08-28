import { describe, it, expect } from "vitest";
import {
  LineDecoder,
  userMessageLine,
  isResultEvent,
  activityLine,
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
