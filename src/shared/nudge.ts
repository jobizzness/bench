import { contextTone } from "./context-window.js";
import type { Context, ContextTone } from "./context-window.js";
import type { Spend } from "./types.js";

/**
 * What a specialist has already been told about its own context and spend.
 *
 * Kept so the same crossing is never said twice - a nudge repeated on every
 * turn after the first is a developer-facing feature that has turned into
 * the thing it warns about, spending tokens to report a fact that has not
 * changed. `context` is the worst tone already reported, not a boolean,
 * because "high" and "full" are two different things worth saying once each.
 */
export interface NudgeState {
  context?: ContextTone;
  spend?: boolean;
}

/** Dollars a specialist has to run up before it is told, once, that a
 * self-contained remainder is cheaper as a fresh tab than carried on here. */
export const NUDGE_SPEND_THRESHOLD = 5;

const TONE_RANK: Record<ContextTone, number> = { ok: 0, high: 1, full: 2 };

/**
 * What to say to a specialist about its own context and spend this turn, and
 * what to remember so it is not said again.
 *
 * Null on almost every turn: this is the case that costs nothing. Non-null
 * only the turn a session first crosses into a context tone it has not
 * already been told about, or first crosses the spend threshold - each of
 * those happens at most twice and once respectively over a specialist's
 * whole life.
 */
export function nudgeFor(
  context: Context | null,
  spend: Spend | null,
  state: NudgeState,
): { text: string; state: NudgeState } | null {
  const lines: string[] = [];
  const next: NudgeState = { ...state };

  const tone = contextTone(context);
  if (TONE_RANK[tone] > TONE_RANK[state.context ?? "ok"]) {
    const percent = Math.floor(Math.min(1, (context?.used ?? 0) / (context?.window ?? 1)) * 100);
    lines.push(
      tone === "full"
        ? `[bench] Your context is ${percent}% full. If the rest of this needs `
          + `everything already on this thread, carry on - but if it does not, `
          + `say so and suggest the developer clear your context rather than let `
          + `it start dropping the beginning of the conversation.`
        : `[bench] Your context is ${percent}% full and climbing. Worth flagging `
          + `now if this looks like it will run out before the work is done.`,
    );
    next.context = tone;
  }

  if (!state.spend && spend && spend.dollars >= NUDGE_SPEND_THRESHOLD) {
    lines.push(
      `[bench] This specialist has cost $${spend.dollars.toFixed(2)} so far. If `
      + `what is left is its own separable piece of work, it is cheaper as a `
      + `fresh tab than carried on this one.`,
    );
    next.spend = true;
  }

  if (lines.length === 0) return null;
  return { text: lines.join("\n"), state: next };
}
