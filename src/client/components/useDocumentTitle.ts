import { useEffect } from "react";
import type { RosterRow } from "../../shared/types.js";
import { isWaiting } from "../waiting.js";

/**
 * What a tab in the strip is called.
 *
 * A specialist has its own URL and the developer keeps a tab per specialist,
 * so "Bench" on all of them is the one name that cannot tell them apart. The
 * count comes first because it is the thing worth seeing without switching:
 * a tab that has started wanting you says so from the strip.
 */
export function benchTitle(rows: RosterRow[], selectedId: string | null): string {
  const waiting = rows.filter(isWaiting).length;
  const here = rows.find((r) => r.id === selectedId);

  const name = here ? `${here.label} · Bench` : "Bench";
  return waiting > 0 ? `(${waiting}) ${name}` : name;
}

export function useDocumentTitle(rows: RosterRow[], selectedId: string | null): void {
  const title = benchTitle(rows, selectedId);
  useEffect(() => { document.title = title; }, [title]);
}
