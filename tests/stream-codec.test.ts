import { describe, it, expect } from "vitest";
import {
  LineDecoder,
  userMessageLine,
  isResultEvent,
  activityLine,
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

describe("activityLine", () => {
  it("describes a tool call for the roster", () => {
    const line = activityLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    expect(line).toBe("Bash");
  });

  it("returns null for events with nothing worth showing", () => {
    expect(activityLine({ type: "system", subtype: "thinking_tokens" })).toBeNull();
  });
});
