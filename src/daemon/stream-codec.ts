import type { Context } from "../shared/context-window.js";
import { turnTokens, type TurnShape } from "../shared/cost.js";
import type { Attachment } from "../shared/types.js";

export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
  total_cost_usd?: number;
  permission_denials?: unknown[];
}

/**
 * One assistant event off the stream.
 *
 * `message` is the raw upstream API message, verbatim - the CLI wraps it in
 * an envelope of its own and changes nothing inside it. This used to declare
 * `content` alone, which is why everything else was silently dropped: a field
 * absent from the type is a field nobody thinks to read, and the one that
 * mattered most - the id the request was billed under - went out with it.
 */
export interface AssistantEvent {
  type: "assistant";
  message: {
    /** The upstream message id. Under OpenRouter this is the generation id. */
    id?: string;
    /**
     * The model that actually answered, which is not always the one asked
     * for: under `openrouter/auto` this reads `deepseek/deepseek-v4-pro`.
     * It is the only place the router's choice is ever visible - the result
     * event's `modelUsage` is keyed by what was requested.
     */
    model?: string;
    content: Array<{ type: string; text?: string; name?: string }>;
  };
  /** The response's `request-id` header. `gen-...` from OpenRouter,
   * `req_...` from Anthropic, absent when the CLI never saw one. */
  request_id?: string;
  session_id?: string;
  uuid?: string;
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

  /** What one request put in front of the model. */
  const inputOf = (entry: Record<string, unknown>) =>
    number(entry.input_tokens)
    + number(entry.cache_creation_input_tokens)
    + number(entry.cache_read_input_tokens);

  // The top-level usage is every request the turn made, added together. A
  // turn with sixty tool calls re-sends the conversation sixty times, so that
  // sum is sixty conversations and pins at the window - which is why this
  // read a hundred per cent on any turn that did real work.
  //
  // What the conversation actually occupies is what the last request carried.
  // `iterations` lists them; the final one is the state the turn ended in.
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const last = iterations.at(-1);
  if (!last || typeof last !== "object") return null;

  const used = inputOf(last as Record<string, unknown>);

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

/**
 * What the whole turn put through the model, off the same result event.
 *
 * The opposite reading to `contextFrom`, and deliberately so. The context
 * meter wants the last request - what the conversation now occupies. A bill
 * wants every request the turn made: a turn with sixty tool calls re-sent the
 * conversation sixty times and was charged sixty times for it.
 *
 * The CLI's top-level `usage` is already that sum. Iterations are added up
 * only when it is missing, which is a shape of event we have not seen but
 * would rather survive than drop.
 */
export function shapeFrom(event: ClaudeEvent): TurnShape | null {
  if (!isResultEvent(event)) return null;
  const usage = (event as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;

  // How many requests the three input figures were summed over.
  //
  // Carried because a price can depend on the size of a prompt, and the sum
  // over a turn is not a prompt: a twenty-request turn of six thousand tokens
  // each would look like one request of a hundred and twenty thousand and be
  // charged at a tier it never reached. With the count, the mean prompt is
  // recoverable; without it, `costOfTurn` charges the base rate, which is what
  // it did before tiers existed.
  //
  // Absent rather than one when the CLI does not list them. A shape that says
  // "one request" when it does not know is a shape that has invented the
  // number the tier is chosen by.
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const requests = iterations.length > 0 ? { requests: iterations.length } : {};

  const total = readShape(usage);
  if (turnTokens(total) > 0) return { ...total, ...requests };

  const summed = iterations.reduce<TurnShape>((sum, entry) => {
    const one = readShape(entry as Record<string, unknown>);
    return {
      freshIn: sum.freshIn + one.freshIn,
      cacheWrite: sum.cacheWrite + one.cacheWrite,
      cacheRead: sum.cacheRead + one.cacheRead,
      out: sum.out + one.out,
    };
  }, { freshIn: 0, cacheWrite: 0, cacheRead: 0, out: 0 });

  return turnTokens(summed) > 0 ? { ...summed, ...requests } : null;
}

function readShape(from: Record<string, unknown>): TurnShape {
  const number = (value: unknown) =>
    (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

  return {
    freshIn: number(from.input_tokens),
    cacheWrite: number(from.cache_creation_input_tokens),
    cacheRead: number(from.cache_read_input_tokens),
    out: number(from.output_tokens),
  };
}

/**
 * What the CLI says the turn cost, in dollars.
 *
 * Its own arithmetic against its own price table, which is Anthropic's. A
 * turn answered by OpenRouter is not in that table, so this is trusted only
 * for a turn that went to Anthropic - see registry.ts, which is the only
 * place that knows which of the two happened.
 */
export function costFrom(event: ClaudeEvent): number | null {
  if (!isResultEvent(event)) return null;
  const cost = (event as ResultEvent).total_cost_usd;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * OpenRouter mints every generation id with this prefix. Anthropic's request
 * ids begin `req_` instead, so the prefix on its own says which endpoint
 * answered - see `generationIdFrom` for why that is the test used.
 */
const OPENROUTER_ID = /^gen-/;

/** The CLI writes its own messages under this model name. */
const SYNTHETIC = "<synthetic>";

/**
 * The OpenRouter generation id one assistant event was answered under, or
 * null when there is none.
 *
 * This is the only handle Bench will ever have on what a turn really cost.
 * The estimate it falls back on prices a catalogue that quotes one provider,
 * while OpenRouter bills whichever provider actually served the request: over
 * five hundred of this developer's requests that estimate came to $7.02
 * against $10.24 charged. The true figure is fetchable per request, but only
 * against this id, and until now the parser threw it away.
 *
 * The id arrives twice - as `request_id`, taken from the response's
 * `request-id` header, and as `message.id` on the upstream message itself.
 * Under OpenRouter both carry the same value, so either will do; the header
 * is preferred only because it is the CLI's own reading of the response
 * rather than the body's account of itself.
 *
 * The `gen-` prefix is what scopes this to OpenRouter, deliberately in place
 * of looking at the model id. The id says which endpoint answered as a matter
 * of fact; a model name only implies it, and Bench rewrites model names
 * itself, so inferring from one would be believing our own paperwork.
 *
 * A synthetic message is skipped whole. It is written by the CLI rather than
 * by any endpoint, and while its `message.id` is a bare uuid that fails the
 * prefix test anyway, its `request_id` can still be a real `gen-` id: the one
 * in a real transcript belonged to an `API Error: 402` - a request that was
 * refused and so never billed at all. Charging for it would be a fabrication.
 */
export function generationIdFrom(event: ClaudeEvent): string | null {
  if (event.type !== "assistant") return null;
  const message = (event as AssistantEvent).message;
  if (!message || message.model === SYNTHETIC) return null;

  const id = (event as AssistantEvent).request_id ?? message.id;
  return typeof id === "string" && OPENROUTER_ID.test(id) ? id : null;
}

/**
 * Which model actually answered this event, or null.
 *
 * Worth having on its own, quite apart from the id. `modelUsage` on the
 * result event is keyed by the model that was *requested*, so under an auto
 * router it says `openrouter/auto` and nothing else ever says otherwise -
 * this is the single place the router's actual choice surfaces. It is also
 * what gives the fallback estimate a real model to price against on a turn
 * whose cost cannot be fetched.
 *
 * Not filtered to OpenRouter: on an Anthropic turn this is the alias the CLI
 * resolved, which is a fact worth the same as the other one.
 */
export function answeringModelFrom(event: ClaudeEvent): string | null {
  if (event.type !== "assistant") return null;
  const model = (event as AssistantEvent).message?.model;
  if (typeof model !== "string") return null;

  const named = model.trim();
  return named === "" || named === SYNTHETIC ? null : named;
}

export function isResultEvent(event: ClaudeEvent): event is ResultEvent {
  return event.type === "result";
}

/**
 * One prompt, encoded for the CLI's stdin.
 *
 * A text-only prompt stays a bare string, which is what it has always been -
 * the content array is only reached for when there is something in it that a
 * string cannot hold. Images go before the text because that is the order the
 * API reads them best in: the picture, then the question about it.
 */
export function userMessageLine(text: string, images: Attachment[] = []): string {
  const content = images.length === 0
    ? text
    : [
      ...images.map((image) => ({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      })),
      { type: "text", text },
    ];
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
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
