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
const MAX_ACTIVITY = 72;

/** The last three segments are enough to recognise a file without the noise
 * of an absolute path into a worktree nobody navigates by hand. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : parts.slice(-3).join("/");
}

/**
 * What the tool is doing, not merely which tool it is. A roster that says
 * "Bash" for twelve minutes looks exactly like one that has wedged.
 */
function target(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";

  const command = input.command;
  // A trailing backslash is a line continuation, not part of the command.
  if (typeof command === "string") return command.split("\n")[0].replace(/\\$/, "").trim();

  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof file === "string") return shortPath(file);

  const pattern = input.pattern ?? input.query;
  if (typeof pattern === "string") return pattern;

  const named = input.skill ?? input.subagent_type ?? input.description;
  if (typeof named === "string") return named;

  return "";
}

export function activityLine(event: ClaudeEvent): string | null {
  if (event.type !== "assistant") return null;
  const content = (event as AssistantEvent).message?.content ?? [];
  for (const block of content) {
    if (block.type !== "tool_use" || !block.name) continue;

    const detail = target(block.name, (block as { input?: Record<string, unknown> }).input);
    const line = detail === "" ? block.name : `${block.name} ${detail}`;
    return line.length > MAX_ACTIVITY ? `${line.slice(0, MAX_ACTIVITY - 1)}\u2026` : line;
  }
  return null;
}

/**
 * The turn's final assistant text. Taken from the result event rather than
 * accumulated from streamed blocks: the thread only shows a reply once the
 * turn ends, so streaming buys nothing.
 */
export function replyText(event: ClaudeEvent): string | null {
  if (!isResultEvent(event)) return null;
  const text = event.result?.trim();
  return text ? text : null;
}
