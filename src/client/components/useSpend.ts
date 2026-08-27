import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../api.js";
import { useBenchState } from "./context.js";
import type { Total } from "../../daemon/ledger.js";

/**
 * What this project has cost, and what the whole bench has, as the daemon
 * last answered.
 *
 * Deliberately not on a clock, which is where this departs from useUsage and
 * useCredit sitting beside it. Those two ask a remote API about an account
 * that moves without us - a window refills on Anthropic's schedule, another
 * machine spends the same OpenRouter key - so a minute really is the soonest
 * a poll can learn anything, and a poll is the only way to learn it. This
 * number is different in kind. It is a local file that changes exactly when a
 * turn on this bench finishes, and the cockpit is already told when that
 * happens: the roster arrives over the socket on that very event. Putting it
 * on a timer would be asking the daemon to re-read an unchanged file sixty
 * times an hour for the life of the tab, and would still be slower to notice
 * a finished turn than the push we already have.
 *
 * So it is asked three times: on mount, whenever the billed-turn count on the
 * roster moves, and when the panel is opened.
 *
 * The third is not belt-and-braces. The daemon emits the roster without
 * waiting for the ledger append to settle - `bill` is deliberately not
 * awaited in the turn-end handler - so a fetch fired the instant the push
 * lands is racing the line it was fired about, and can read a ledger one turn
 * short. In practice the append is a local write already in flight and the
 * fetch is an HTTP round trip, so the append wins; but "usually wins" is not
 * a thing to build a money figure on. Opening the panel asks again, which
 * makes the number you actually stop and read a fresh one rather than a
 * remembered one, and leaves the mark as the only thing that can briefly
 * trail by a turn.
 *
 * Null is "not asked yet", which is not the same as "nothing to report" and
 * must not draw a mark.
 */

export type Spending =
  /** `project` is null when no specialist is selected, so there is no project
   * to be narrower than the bench - not when the project has spent nothing. */
  | { known: true; project: Total | null; bench: Total }
  /** The daemon could not be asked, or answered with something that is not a
   * total. Drawn as a caveat, never as zeroes: a ledger that renders a failed
   * request as "nothing spent" is the one lie this feature exists to remove. */
  | { known: false };

export function useSpend(project?: string): {
  spending: Spending | null;
  refresh: () => Promise<void>;
} {
  const [spending, setSpending] = useState<Spending | null>(null);
  const { rows } = useBenchState();

  // Every specialist and what it has billed so far, as one string to compare.
  // A finished turn moves somebody's count; a closed tab drops out of the
  // roster entirely and shortens it. Either way this changes, which is the
  // whole of what we need to know - and it stays put through the roster
  // pushes that carry only a status or an activity line, so the ordinary
  // chatter of a working bench does not refetch anything.
  const billed = rows.map((r) => `${r.id}:${r.spend?.turns ?? 0}`).join(",");

  const load = useCallback(async (): Promise<Spending> => {
    // Both at once. The whole-bench figure has to be reachable from here and
    // the daemon totals a filtered set and an unfiltered one from the same
    // file, so asking for both costs one extra round trip to localhost rather
    // than a second view for the developer to go and find.
    const [forProject, forBench] = await Promise.all([
      project === undefined ? Promise.resolve(null) : ask(project),
      ask(),
    ]);

    // A missing project total is a failure even though null is also how "no
    // project selected" is spelled below, which is why it is decided here
    // where the difference is still known.
    if (forBench === null || (project !== undefined && forProject === null)) {
      return { known: false };
    }
    return { known: true, project: forProject, bench: forBench };
  }, [project]);

  const refresh = useCallback(async () => { setSpending(await load()); }, [load]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const next = await load();
      if (live) setSpending(next);
    })();
    return () => { live = false; };
  }, [load, billed]);

  return { spending, refresh };
}

/** One total, or null for a daemon that would not answer. */
async function ask(project?: string): Promise<Total | null> {
  const res = await authFetch(
    project === undefined ? "/api/spend" : `/api/spend?project=${encodeURIComponent(project)}`,
  );
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return isTotal(body) ? body : null;
}

/**
 * Whether the daemon really sent a total.
 *
 * Checked rather than assumed, for the same reason the ledger checks every
 * line it reads back: this is the one screen whose whole job is to be trusted
 * about money, and an older daemon - or any answer that is merely shaped like
 * JSON - would otherwise reach the panel as `undefined` dollars and be drawn
 * as a figure. Better to say nothing was learned.
 */
function isTotal(value: unknown): value is Total {
  const total = value as Total;
  return (
    typeof total === "object" && total !== null
    && money(total.plan) && money(total.account) && money(total.estimated)
    && typeof total.turns === "number" && Number.isFinite(total.turns)
  );
}

const money = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n);
