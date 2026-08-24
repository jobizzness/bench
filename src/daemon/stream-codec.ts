import type { Context } from "../shared/context-window.js";

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

/**
 * How full the conversation is, off the result event.
 *
 * The used figure is what the last request actually sent - fresh input, plus
 * the cache it wrote and the cache it read. Cached tokens still occupy the
 * window, and counting `input_tokens` alone reports a long conversation as
 * two tokens.
 *
 * The window comes from the CLI rather than from a table of ours: it differs
 * per model and changes without us. Where several models appear - a subagent
 * on a cheaper one - the conversation belongs to whichever did the most work.
 */
export function contextFrom(event: ClaudeEvent): Context | null {
  if (!isResultEvent(event)) return null;

  const usage = (event as { usage?: Record<string, unknown> }).usage;
  const models = (event as { modelUsage?: Record<string, Record<string, unknown>> }).modelUsage;
  if (!usage || !models) return null;

  const number = (value: unknown) =>
    (typeof value === "number" && Number.isFinite(value) ? value : 0);

  const used = number(usage.input_tokens)
    + number(usage.cache_creation_input_tokens)
    + number(usage.cache_read_input_tokens);

  let window = 0;
  let most = -1;
  for (const entry of Object.values(models)) {
    const worked = number(entry.inputTokens)
      + number(entry.cacheCreationInputTokens)
      + number(entry.cacheReadInputTokens);
    if (worked > most) { most = worked; window = number(entry.contextWindow); }
  }

  return used > 0 && window > 0 ? { used, window } : null;
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
