import { useEffect, useState } from "react";
import type { RosterRow } from "../../shared/types.js";

/**
 * The hand-off waiting on the developer, if the thread they are reading is
 * part of one.
 *
 * Found from the thread you are on rather than only from the tab being handed
 * work, because that is where you are when it happens: a specialist spins a
 * tab up and tells it something mid-turn, while you are watching that turn.
 * A modal that only appears once you go and click the new row is a modal
 * nobody sees until they next read the roster - by which time the point of
 * holding the message has gone.
 *
 * The tab itself still counts, so a hand-off you walked away from can be come
 * back to by opening it. A hand-off between two specialists you are not
 * reading is neither: it is a row on the roster, not an interruption.
 */
export function useHandoff(rows: RosterRow[], selectedId: string | null): {
  held: RosterRow | null;
  open: boolean;
  close: () => void;
} {
  const [open, setOpen] = useState(false);

  const held = selectedId === null ? null : rows.find((row) =>
    row.status === "awaiting_dispatch"
    && (row.id === selectedId || row.createdBy === selectedId)) ?? null;

  // Keyed on which tab is being handed work, not on a click: dismissing it
  // stays dismissed until you leave this thread and come back to it.
  useEffect(() => { if (held !== null) setOpen(true); }, [held?.id]);

  return { held, open: open && held !== null, close: () => setOpen(false) };
}
