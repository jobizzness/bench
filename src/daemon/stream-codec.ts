export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
  total_cost_usd?: number;
  permission_denials?: unknown[];
}

export interface AssistantEvent {
  type: "assistant";
  message: { content: Array<{ type: string; text?: string; name?: string }> };
}

export interface GenericEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export type ClaudeEvent = ResultEvent | AssistantEvent | GenericEvent;

/**
 * Claude writes newline-delimited JSON, but a chunk from the pipe can split a
 * line anywhere. The decoder buffers the tail until its newline arrives.
 */
export class LineDecoder {
  private carry = "";

  push(chunk: string): ClaudeEvent[] {
    this.carry += chunk;
    const lines = this.carry.split("\n");
    this.carry = lines.pop() ?? "";

    const events: ClaudeEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        events.push(JSON.parse(trimmed) as ClaudeEvent);
      } catch {
        // A malformed line is a diagnostic, never a crash. Drop it.
      }
    }
    return events;
  }
}

export function isResultEvent(event: ClaudeEvent): event is ResultEvent {
  return event.type === "result";
}

export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/** A short human-readable line for the roster, or null if not worth showing. */
export function activityLine(event: ClaudeEvent): string | null {
  if (event.type !== "assistant") return null;
  const content = (event as AssistantEvent).message?.content ?? [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) return block.name;
  }
  return null;
}
