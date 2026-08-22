import { useEffect, useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { STATE_EVENT, bridge } from "../bench.js";

export interface BenchState {
  rows: RosterRow[];
  selectedId: string | null;
}

const EMPTY: BenchState = { rows: [], selectedId: null };

/**
 * Subscribes to the state the vanilla cockpit still owns. A snapshot is
 * copied on every notification rather than held by reference, so React sees
 * a new object and re-renders - the mutable `state` object it is reading
 * would otherwise look unchanged.
 */
export function useBenchState(): BenchState {
  const [snapshot, setSnapshot] = useState<BenchState>(EMPTY);

  useEffect(() => {
    const read = () => {
      const current = bridge();
      setSnapshot(current
        ? { rows: [...current.state.rows], selectedId: current.state.selectedId }
        : EMPTY);
    };

    read();
    document.addEventListener(STATE_EVENT, read);
    return () => document.removeEventListener(STATE_EVENT, read);
  }, []);

  return snapshot;
}
