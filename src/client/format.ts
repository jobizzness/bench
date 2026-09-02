/** Pure formatting shared by the roster, the working indicator and the trail. */

export function hashOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function elapsedSince(iso: string, now = Date.now()): string {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "";
  const total = Math.max(0, Math.round((now - started) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatTokens(n: number): string | null {
  if (!n) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/** How long ago, in the shortest form that is still honest. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

/** Relative time for a thread entry, which can be days old. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The repo name out of an absolute path: what a project is called, rather
 * than where it happens to live. */
export function projectName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * A tool name, as it heads a live activity string - see
 * `stream-codec.ts#activityLine`. Read off the first word rather than
 * carried separately, since the daemon only ever sends the one merged
 * string.
 */
const TOOL_VERB: Record<string, string> = {
  Bash: "Running a command",
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  NotebookEdit: "Editing",
  Grep: "Searching",
  Glob: "Searching",
  WebFetch: "Looking something up",
  WebSearch: "Looking something up",
  TodoWrite: "Updating its plan",
};

/**
 * The header's phone-only rendering of a live activity string - see
 * `Meta.tsx`. Desktop keeps the raw string verbatim (there is room for it,
 * and the trail below already shows it in full); a phone gets a human
 * phrase instead, since a shell command is the least useful thing on a
 * screen this narrow.
 *
 * A `Bash` command drops its argument entirely - shell syntax reads as
 * noise, not information, at this width. Every other tool keeps its target
 * (already a short path or pattern, from `shortenPaths`), since "Editing
 * styles.css" is worth the extra word. A tool this map does not know about
 * falls back to a generic verb in front of whatever target it carries,
 * which is usually a name (a skill or subagent) rather than a path - "Using
 * bench-report" reads as a sentence the way every other status on this line
 * does; the bare name it fell back to before did not. With no target at all
 * there is nothing to put after a verb, so the tool name stands alone.
 */
export function phoneActivity(raw: string): string {
  const space = raw.indexOf(" ");
  const tool = space === -1 ? raw : raw.slice(0, space);
  const target = space === -1 ? "" : raw.slice(space + 1);
  const verb = TOOL_VERB[tool];
  if (verb === undefined) return target ? `Using ${target}` : tool;
  if (tool === "Bash") return verb;
  return target ? `${verb} ${target}` : verb;
}
