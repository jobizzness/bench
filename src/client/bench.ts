import type { RosterRow } from "../shared/types.js";

/**
 * The bridge between the vanilla cockpit and the React islands replacing it,
 * one screen at a time. It exists so both renderers can be on screen at once
 * during the port and is deleted with the last island.
 */
export interface BenchBridge {
  state: { rows: RosterRow[]; selectedId: string | null };
  select(id: string): void;
  closeSpecialist(row: RosterRow): void;
}

declare global {
  interface Window {
    bench?: BenchBridge;
    /** Vanilla fires this whenever the state it owns has changed. */
  }
}

export const STATE_EVENT = "bench:state";

export function bridge(): BenchBridge | null {
  return window.bench ?? null;
}
