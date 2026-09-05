import { createContext, useContext, type ReactNode } from "react";
import type { RosterRow } from "../../shared/types.js";

export interface BenchState {
  rows: RosterRow[];
  selectedId: string | null;
  /** Whether the socket that would fill `rows` is up - `null` until it has
   * settled either way. Read by `Roster.tsx` to tell an empty-but-live
   * roster (draw the skeleton) from an empty-and-offline one (the offline
   * banner already says so; a skeleton there would promise a roster that is
   * not coming). See `useRoster.ts`'s own comment on `live`. */
  live: boolean | null;
}

export interface BenchActions {
  /** null deselects - the stage's own way back to the roster below the
   * width breakpoint. See `#stage-back` in StageHead.tsx. */
  select: (id: string | null) => void;
  closeSpecialist: (row: RosterRow) => void;
}

const StateContext = createContext<BenchState>({ rows: [], selectedId: null, live: null });
const ActionsContext = createContext<BenchActions>({ select: () => {}, closeSpecialist: () => {} });

/**
 * The roster and the stage both need to know who is selected, and they sit on
 * opposite sides of the tree. Passing it through every level in between is
 * how a component ends up with props it never reads.
 */
export function BenchProvider({ state, actions, children }: {
  state: BenchState;
  actions: BenchActions;
  children: ReactNode;
}) {
  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  );
}

export const useBenchState = (): BenchState => useContext(StateContext);
export const useBenchActions = (): BenchActions => useContext(ActionsContext);
