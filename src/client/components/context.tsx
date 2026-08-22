import { createContext, useContext, type ReactNode } from "react";
import type { RosterRow } from "../../shared/types.js";

export interface BenchState {
  rows: RosterRow[];
  selectedId: string | null;
}

export interface BenchActions {
  select: (id: string) => void;
  closeSpecialist: (row: RosterRow) => void;
}

const StateContext = createContext<BenchState>({ rows: [], selectedId: null });
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
