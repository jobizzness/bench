import type { EventEmitter } from "node:events";
import type { Context } from "../shared/context-window.js";
import { DEVIN_MODEL } from "../shared/models.js";
import type { Attachment } from "../shared/types.js";
import type { ResultEvent } from "./stream-codec.js";

/**
 * The whole surface `registry.ts` uses of a specialist runtime, carved out so
 * a second runtime can satisfy it without importing `ClaudeSession`.
 */
export interface Session extends EventEmitter {
  open(): void;
  send(text: string, images?: Attachment[]): void;
  stop(): void;

  readonly turnStartedAt: string | null;
  readonly turnTokens: number;
  readonly turn: number;
  readonly contextUsed: Context | null;
  readonly turnAnsweredBy: string[];
  readonly turnGenerationIds: string[];
  readonly runningTurn: { ids: string[]; answeredBy: string[] } | null;

  on(event: "progress", listener: () => void): this;
  on(event: "activity", listener: (line: string) => void): this;
  on(event: "exit", listener: (code: number | null, stderr: string) => void): this;
  on(event: "reply", listener: (text: string) => void): this;
  on(event: "turn-end", listener: (result: ResultEvent) => void): this;

  emit(event: "progress"): boolean;
  emit(event: "activity", line: string): boolean;
  emit(event: "exit", code: number | null, stderr: string): boolean;
  emit(event: "reply", text: string): boolean;
  emit(event: "turn-end", result: ResultEvent): boolean;
}

/**
 * Which session runtime a model id requires.
 *
 * Exactly one caller: `attach` in `registry.ts`, which constructs the right
 * Session implementation based on the return value. Keeping the choice here
 * means `registry.ts` never has to import both runtimes and compare ids.
 */
export function runtimeFor(model: string): "claude" | "devin" {
  return model === DEVIN_MODEL ? "devin" : "claude";
}
