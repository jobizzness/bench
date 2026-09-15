import { insideWorkspace } from "./inside.js";

/**
 * Whether this window is the one a target was meant for, and what it narrows
 * to.
 *
 * The daemon sends a target to every connected editor, because it has no way
 * to tell which window the developer was looking at. A window that does not
 * have that project open is simply not the one being talked to, and says so
 * by ignoring it.
 *
 * Accepted either way round: the project may be a folder this window has
 * open, or it may contain one - a window opened on `bench/src` still serves
 * specialists working on `bench`.
 */
export function targetFolder(project: string, open: string[]): string | null {
  const serves = open.some(
    (folder) => insideWorkspace(project, [folder]) || insideWorkspace(folder, [project]),
  );
  return serves ? project : null;
}

/**
 * The folders this window currently speaks for.
 *
 * Untargeted, that is everything it has open - which is the behaviour before
 * anyone presses the button, and the right default for the common case of one
 * window on one project. Targeted, it is that project alone.
 */
export function effectiveFolders(bound: string | null, open: string[]): string[] {
  return bound === null ? open : [bound];
}
