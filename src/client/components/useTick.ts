import { useEffect, useState } from "react";

/**
 * A clock, not a render loop. The elapsed and "ago" labels have to move on
 * their own; everything else re-renders when its data changes. The vanilla
 * cockpit rebuilt every plan step and trail row four times a second whether
 * anything had changed or not, which is the thing this port exists to stop.
 */
export function useTick(intervalMs = 250): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}
