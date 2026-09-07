import { useCallback, useRef, useState } from "react";

/** A gap this short or less keeps the burst going; anything longer starts it
 * over at 1. Matches the window the composer's own glow decays on - one
 * number, not two to keep in step. */
const WINDOW_MS = 6000;

/** The composer has three things to say, not a running tally - a fourth
 * send inside the window keeps it at its loudest rather than running out of
 * states to be in. */
const MAX_LEVEL = 3;

export interface SendBurstRecord {
  /** The level right after this send - 1 through `MAX_LEVEL`. */
  level: number;
  /** True exactly once per burst: the send that first pushed the level to
   * `MAX_LEVEL`, not any send after it that merely stays there. The caller
   * decides what to do with that - a haptic, here, is not this hook's job. */
  justReachedMax: boolean;
}

/**
 * Tracks how many sends have landed close together, for the composer's own
 * "you are on a roll" feedback (#103). Timestamps and a level, nothing else
 * - the plane that flies and the glow that escalates both live elsewhere and
 * only ever read `level`.
 *
 * A send within `WINDOW_MS` of the previous one continues the burst; a
 * longer gap starts over at 1. The level decays to 0 `WINDOW_MS` after the
 * *last* send, not on a fixed schedule from the first, so five sends a
 * second apart read as one long burst rather than five separate blips.
 */
export function useSendBurst(): { level: number; record: () => SendBurstRecord } {
  const [level, setLevel] = useState(0);
  // The authoritative value: `level` is only for rendering, and reading it
  // back inside `record()` would see whatever the last render committed,
  // which can be stale if two sends land before React re-renders.
  const current = useRef(0);
  const lastAt = useRef<number | null>(null);
  const decayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const record = useCallback((): SendBurstRecord => {
    const now = Date.now();
    const continues = lastAt.current !== null && now - lastAt.current < WINDOW_MS;
    lastAt.current = now;

    const before = current.current;
    const next = Math.min(MAX_LEVEL, continues ? before + 1 : 1);
    current.current = next;
    setLevel(next);

    if (decayTimer.current !== null) clearTimeout(decayTimer.current);
    decayTimer.current = setTimeout(() => {
      lastAt.current = null;
      current.current = 0;
      decayTimer.current = null;
      setLevel(0);
    }, WINDOW_MS);

    return { level: next, justReachedMax: before !== MAX_LEVEL && next === MAX_LEVEL };
  }, []);

  return { level, record };
}
