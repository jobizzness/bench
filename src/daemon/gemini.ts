import type { IncomingMessage, ServerResponse } from "node:http";
import type { Balance, Credit } from "../shared/credit.js";
import type { Price, Rate, Tier } from "../shared/cost.js";

/**
 * Replaced OpenRouter with Google Gemini.
 * Maps Anthropic Messages API requests (which the Claude CLI sends) to OpenAI Chat Completions payloads,
 * forwards them to Gemini's official OpenAI-compatible endpoint,
 * and streams/returns the translated response back to the CLI on-the-fly.
 */

export const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Local base URL for the CLI. Pointing ANTHROPIC_BASE_URL here routes messages
 * through our in-process translation proxy.
 */
export const CLI_BASE_URL = "http://127.0.0.1:7420/api/openrouter";

export interface Listed {
  id: string;
  name: string;
  vendor: string;
  contextLength: number | null;
  price: Price;
}

export interface SettledTotal {
  dollars: number;
  priced: number;
  unpriced: number;
}

export const GEMINI_MODELS: Listed[] = [
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Google: Gemini 3.1 Pro Preview",
    vendor: "google",
    contextLength: 2097152,
    price: {
      fresh: 1.25,
      cacheWrite: 0.3125,
      cacheRead: 0.3125,
      out: 5.00,
    }
  },
  {
    id: "google/gemini-3.7-pro",
    name: "Google: Gemini 3.7 Pro",
    vendor: "google",
    contextLength: 2097152,
    price: {
      fresh: 1.25,
      cacheWrite: 0.3125,
      cacheRead: 0.3125,
      out: 5.00,
    }
  },
  {
    id: "google/gemini-3.7-flash",
    name: "Google: Gemini 3.7 Flash",
    vendor: "google",
    contextLength: 1048576,
    price: {
      fresh: 0.75,
      cacheWrite: 0.1875,
      cacheRead: 0.1875,
      out: 3.75,
    }
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Google: Gemini 3.5 Flash",
    vendor: "google",
    contextLength: 1048576,
    price: {
      fresh: 1.50,
      cacheWrite: 0.375,
      cacheRead: 0.375,
      out: 9.00,
    }
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Google: Gemini 2.5 Pro",
    vendor: "google",
    contextLength: 2097152,
    price: {
      fresh: 1.25,
      cacheWrite: 0.3125,
      cacheRead: 0.3125,
      out: 5.00,
    }
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Google: Gemini 2.5 Flash",
    vendor: "google",
    contextLength: 1048576,
    price: {
      fresh: 0.30,
      cacheWrite: 0.075,
      cacheRead: 0.075,
      out: 2.50,
    }
  },
  {
    id: "google/gemini-1.5-pro",
    name: "Google: Gemini 1.5 Pro",
    vendor: "google",
    contextLength: 2097152,
    price: {
      fresh: 1.25,
      cacheWrite: 0.3125,
      cacheRead: 0.3125,
      out: 5.00,
    }
  },
  {
    id: "google/gemini-1.5-flash",
    name: "Google: Gemini 1.5 Flash",
    vendor: "google",
    contextLength: 1048576,
    price: {
      fresh: 0.075,
      cacheWrite: 0.01875,
      cacheRead: 0.01875,
      out: 0.30,
    }
  }
];

export type KeyCheck = "ok" | "refused" | "unreachable";

/** Check key validity by querying Gemini's models endpoint. */
export async function checkKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const res = await fetchImpl(`${BASE_URL}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "refused" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function catalogue(fetchImpl: typeof fetch = fetch): Promise<Listed[]> {
  return GEMINI_MODELS;
}

export function sessionEnv(opts: { key: string; contextLength?: number | null; id?: string; cockpitUrl?: string }): Record<string, string> {
  const localBase = opts.cockpitUrl
    ? `${opts.cockpitUrl.replace(/\/+$/, "")}/api/openrouter${opts.id ? `/${opts.id}` : ""}`
    : opts.id ? `${CLI_BASE_URL}/${opts.id}` : CLI_BASE_URL;
  return {
    ANTHROPIC_BASE_URL: localBase,
    ANTHROPIC_API_KEY: opts.key,
    ...(opts.contextLength ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(opts.contextLength) } : {}),
  };
}

export async function credit(key: string, fetchImpl: typeof fetch = fetch): Promise<Credit> {
  return {
    available: true,
    spent: 0,
    limit: null,
    balance: null,
  };
}

export const RECENT_COSTS = new Map<string, number>();
export const THOUGHT_SIGNATURES = new Map<string, string>();

export async function settledCost(
  id: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  return RECENT_COSTS.get(id) ?? null;
}

export async function settledCostOfTurn(
  ids: readonly string[],
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SettledTotal> {
  const total: SettledTotal = { dollars: 0, priced: 0, unpriced: 0 };
  for (const id of ids) {
    const cost = RECENT_COSTS.get(id);
    if (cost === undefined) {
      total.unpriced += 1;
    } else {
      total.dollars += cost;
      total.priced += 1;
    }
  }
  return total;
}

const FRESH_FOR = 60_000;

export function creditSource(deps: {
  key: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): () => Promise<Credit> {
  const clock = deps.now ?? Date.now;
  let held: { key: string; at: number; credit: Credit } | null = null;

  return async () => {
    const key = deps.key();
    if (key === null) return { available: false, reason: "none" };

    const at = clock();
    if (held !== null && held.key === key && at - held.at < FRESH_FOR) return held.credit;

    const answer = await credit(key, deps.fetchImpl);
    if (answer.available) held = { key, at, credit: answer };
    return answer;
  };
}

export function isOpenRouterModel(id: string): boolean {
  return id.includes("/");
}

export function vendorOf(id: string): string {
  return id.split("/")[0] ?? "";
}

export function messagesUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/messages`;
}

// Format translation helpers

function translateMessagesToOpenAI(anthropicMessages: any[], system?: string): any[] {
  const openaiMessages: any[] = [];

  if (system) {
    openaiMessages.push({ role: "system", content: system });
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === "string") {
      openaiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (Array.isArray(msg.content)) {
      const textBlocks = msg.content.filter((b: any) => b.type === "text");
      const toolUseBlocks = msg.content.filter((b: any) => b.type === "tool_use");
      const toolResultBlocks = msg.content.filter((b: any) => b.type === "tool_result");

      const textContent = textBlocks.map((b: any) => b.text).join("\n").trim();

      if (msg.role === "assistant") {
        const outMsg: any = { role: "assistant" };
        if (textContent) {
          outMsg.content = textContent;
        }
        if (toolUseBlocks.length > 0) {
          outMsg.tool_calls = toolUseBlocks.map((b: any) => {
            const sig = THOUGHT_SIGNATURES.get(b.id) || "skip_thought_signature_validator";
            return {
              id: b.id,
              type: "function",
              function: {
                name: b.name,
                arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
              },
              extra_content: {
                google: {
                  thought_signature: sig
                }
              }
            };
          });

          const firstId = toolUseBlocks[0].id;
          const msgSig = THOUGHT_SIGNATURES.get(firstId) || "skip_thought_signature_validator";
          outMsg.extra_content = {
            google: {
              thought_signature: msgSig
            }
          };
        }
        openaiMessages.push(outMsg);
      } else if (msg.role === "user") {
        if (toolResultBlocks.length > 0) {
          for (const b of toolResultBlocks) {
            openaiMessages.push({
              role: "tool",
              tool_call_id: b.tool_use_id,
              content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
            });
          }
        }
        if (textContent) {
          openaiMessages.push({ role: "user", content: textContent });
        }
      }
    }
  }

  return openaiMessages;
}

function translateToolToOpenAI(tool: any): any {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function translateResponseToAnthropic(openAIResponse: any, model: string, responseId: string): any {
  const choice = openAIResponse.choices?.[0];
  const message = choice?.message;
  const content: any[] = [];

  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }

  if (message?.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        // Fallback
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name || "",
        input,
      });
    }
  }

  const stop_reason = choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
  const usage = openAIResponse.usage || { prompt_tokens: 0, completion_tokens: 0 };

  return {
    id: responseId,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
    },
  };
}

function sendEvent(res: ServerResponse, event: string, data: any): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Express/Server HTTP Handler to translate and proxy requests */
export async function handleGeminiProxy(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId?: string,
  registry?: any,
): Promise<void> {
  const key = req.headers["x-api-key"]?.toString() || req.headers["authorization"]?.toString().replace(/^Bearer /, "");
  if (!key) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No API key provided in x-api-key or Authorization headers." } }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Malformed JSON body." } }));
    return;
  }

  const { model, messages, system, max_tokens, stream, tools } = body;

  let geminiModel = model;
  if (geminiModel.startsWith("google/")) {
    geminiModel = geminiModel.slice("google/".length);
  }

  const matchedModel = GEMINI_MODELS.find(m => m.id === model || m.id.endsWith(geminiModel));
  const price = matchedModel?.price ?? { fresh: 0.075, out: 0.30 };

  const openaiMessages = translateMessagesToOpenAI(messages, system);
  const openaiTools = tools ? tools.map(translateToolToOpenAI) : undefined;

  // Resolve reasoning effort
  let reasoningEffort = "medium";
  if (sessionId && registry) {
    const session = registry.get(sessionId);
    // registry.get returns { reportsDir, threadPath, alive, revivable } but we can find the full Entry inside registry's entries
    // Since registry.ts entries is a private map, let's check: does registry have an list() method that returns RosterRow[]?
    // Yes! list() returns all RosterRows!
    const rows = typeof registry.list === "function" ? registry.list() : [];
    const row = rows.find((r: any) => r.id === sessionId);
    if (row && row.reasoningEffort) {
      reasoningEffort = row.reasoningEffort;
    } else {
      const settings = typeof registry.getSettings === "function" ? registry.getSettings() : undefined;
      if (settings && settings.reasoningEffort) {
        reasoningEffort = settings.reasoningEffort;
      }
    }
  } else if (registry) {
    const settings = typeof registry.getSettings === "function" ? registry.getSettings() : undefined;
    if (settings && settings.reasoningEffort) {
      reasoningEffort = settings.reasoningEffort;
    }
  }

  const openaiPayload: any = {
    model: geminiModel,
    messages: openaiMessages,
    stream: stream ?? false,
  };
  if (max_tokens) openaiPayload.max_tokens = max_tokens;
  if (openaiTools) {
    openaiPayload.tools = openaiTools;
  }

  // Inject reasoning effort config for supporting models. Gemini's
  // OpenAI-compatible endpoint refuses a request that sets both
  // `reasoning_effort` and a custom `thinking_config` at once - "Expected
  // one of either reasoning_effort or custom thinking_config; found both" -
  // so only `thinking_config` is sent, never both.
  const isReasoningModel = geminiModel.includes("pro-preview") || geminiModel.includes("3.1") || geminiModel.includes("3.7");
  if (isReasoningModel) {
    openaiPayload.extra_body = {
      google: {
        thinking_config: {
          thinking_level: reasoningEffort === "none" ? "minimal" : reasoningEffort,
        }
      }
    };
  }

  const upstreamUrl = `${BASE_URL}/v1/chat/completions`;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(openaiPayload),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      res.writeHead(upstreamRes.status, { "content-type": "application/json" });
      res.end(errText);
      return;
    }

    if (!stream) {
      const openAIResponse = await upstreamRes.json() as any;
      const responseId = `gen-${openAIResponse.id || Math.random().toString(36).slice(2)}`;
      
      const usage = openAIResponse.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = ((usage.prompt_tokens * (price.fresh ?? 0)) + (usage.completion_tokens * (price.out ?? 0))) / 1_000_000;
      RECENT_COSTS.set(responseId, cost);

      // Capture thought_signatures
      const message = openAIResponse.choices?.[0]?.message;
      const sig = message?.extra_content?.google?.thought_signature
        || message?.google?.thought_signature;
      if (sig && message?.tool_calls) {
        for (const tc of message.tool_calls) {
          if (tc.id) {
            THOUGHT_SIGNATURES.set(tc.id, sig);
          }
        }
      }
      if (message?.tool_calls) {
        for (const tc of message.tool_calls) {
          const tcSig = tc.extra_content?.google?.thought_signature || tc.google?.thought_signature;
          if (tc.id && tcSig) {
            THOUGHT_SIGNATURES.set(tc.id, tcSig);
          }
        }
      }

      const anthropicResponse = translateResponseToAnthropic(openAIResponse, model, responseId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(anthropicResponse));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const responseId = `gen-${Math.random().toString(36).slice(2)}`;
    let activeBlockIndex = -1;
    let activeBlockType: "text" | "tool_use" | null = null;
    let toolCallId = "";
    let toolCallName = "";
    let toolCallArgs = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let lastThoughtSignature = "";

    sendEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: responseId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    });

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          if (trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              const chunk = JSON.parse(trimmed.slice(6));
              const choice = chunk.choices?.[0];
              if (!choice) {
                if (chunk.usage) {
                  promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
                  completionTokens = chunk.usage.completion_tokens ?? completionTokens;
                }
                continue;
              }

              const delta = choice.delta;

              const sig = delta?.extra_content?.google?.thought_signature
                || delta?.google?.thought_signature
                || chunk.choices?.[0]?.google?.thought_signature
                || chunk.choices?.[0]?.extra_content?.google?.thought_signature;
              if (sig) {
                lastThoughtSignature = sig;
                if (toolCallId) {
                  THOUGHT_SIGNATURES.set(toolCallId, sig);
                }
              }
              
              if (delta?.content !== undefined && delta.content !== null) {
                if (activeBlockType !== "text") {
                  if (activeBlockType === "tool_use") {
                    sendEvent(res, "content_block_stop", { type: "content_block_stop", index: activeBlockIndex });
                  }
                  activeBlockIndex += 1;
                  activeBlockType = "text";
                  sendEvent(res, "content_block_start", {
                    type: "content_block_start",
                    index: activeBlockIndex,
                    content_block: { type: "text", text: "" }
                  });
                }
                sendEvent(res, "content_block_delta", {
                  type: "content_block_delta",
                  index: activeBlockIndex,
                  delta: { type: "text_delta", text: delta.content }
                });
              }

              if (delta?.tool_calls && delta.tool_calls.length > 0) {
                const tc = delta.tool_calls[0];
                if (tc.id) {
                  if (activeBlockType === "text" || activeBlockType === "tool_use") {
                    sendEvent(res, "content_block_stop", { type: "content_block_stop", index: activeBlockIndex });
                  }
                  activeBlockIndex += 1;
                  activeBlockType = "tool_use";
                  toolCallId = tc.id;
                  toolCallName = tc.function?.name || "";
                  toolCallArgs = "";
                  
                  if (lastThoughtSignature) {
                    THOUGHT_SIGNATURES.set(toolCallId, lastThoughtSignature);
                  }
                  
                  sendEvent(res, "content_block_start", {
                    type: "content_block_start",
                    index: activeBlockIndex,
                    content_block: {
                      type: "tool_use",
                      id: toolCallId,
                      name: toolCallName,
                      input: {}
                    }
                  });
                }

                if (tc.function?.arguments) {
                  toolCallArgs += tc.function.arguments;
                  sendEvent(res, "content_block_delta", {
                    type: "content_block_delta",
                    index: activeBlockIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments
                    }
                  });
                }
              }

              if (choice.finish_reason) {
                if (activeBlockType !== null) {
                  sendEvent(res, "content_block_stop", { type: "content_block_stop", index: activeBlockIndex });
                  activeBlockType = null;
                }

                const stop_reason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
                
                if (chunk.usage) {
                  promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
                  completionTokens = chunk.usage.completion_tokens ?? completionTokens;
                }

                if (promptTokens === 0) {
                  promptTokens = 150;
                  completionTokens = 50;
                }

                const cost = ((promptTokens * (price.fresh ?? 0)) + (completionTokens * (price.out ?? 0))) / 1_000_000;
                RECENT_COSTS.set(responseId, cost);

                sendEvent(res, "message_delta", {
                  type: "message_delta",
                  delta: { stop_reason, stop_sequence: null },
                  usage: { output_tokens: completionTokens }
                });
              }
            } catch (err) {
              // Ignore
            }
          }
        }
      }
    }

    sendEvent(res, "message_stop", { type: "message_stop" });
    res.end();
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
}
