/**
 * Which specialist the URL is pointing at.
 *
 * The cockpit kept the selection in memory only, so a reload landed you back
 * on an empty stage, the back button did nothing, and you could not keep a
 * tab open per specialist. Reports already live under /r/, so sessions get
 * /s/ beside them.
 */
const SESSION_PATH = /^\/s\/([A-Za-z0-9-]+)\/?$/;

export function sessionFromPath(pathname: string): string | null {
  const match = SESSION_PATH.exec(pathname);
  return match ? match[1] : null;
}

/** The token lives in the query string and has to survive navigation. */
export function pathForSession(id: string | null, search: string): string {
  return `${id === null ? "/" : `/s/${id}`}${search}`;
}
