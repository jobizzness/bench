import { useSyncExternalStore } from "react";
import { recall, remember } from "./remembered.js";

/** Hidden projects, by path. Named once so reader and writer cannot drift. */
const HIDDEN = "hidden-projects";

/**
 * Which projects this browser keeps out of the roster.
 *
 * A bench collects projects. Most of them are finished, or someone else's, or
 * a repo you opened once - and every one of them costs a heading in a column
 * you read twenty times an hour. Hiding is not archiving: nothing is closed,
 * nothing stops running, and a hidden project's specialists still answer,
 * still write reports, and still turn up in the queue when they want you.
 * It is only the list that gets shorter.
 *
 * Kept in the browser rather than on the daemon, because it is an arrangement
 * of one person's view. The same bench read from a phone is a different view
 * of the same work, and hiding a project on the laptop should not empty it.
 *
 * One store rather than a piece of state per component: the roster and the
 * settings sheet are both looking at this list at the same moment, and a copy
 * each is a copy each that can be wrong.
 */
let hidden: ReadonlySet<string> = new Set(recall<string[]>(HIDDEN, []));

const listeners = new Set<() => void>();

function commit(next: ReadonlySet<string>): void {
  hidden = next;
  remember(HIDDEN, [...next]);
  for (const listener of listeners) listener();
}

export function hideProject(project: string): void {
  if (hidden.has(project)) return;
  commit(new Set(hidden).add(project));
}

export function showProject(project: string): void {
  if (!hidden.has(project)) return;
  const next = new Set(hidden);
  next.delete(project);
  commit(next);
}

export function useHiddenProjects(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => hidden,
    () => hidden,
  );
}
