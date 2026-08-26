/**
 * Credentials Bench finds for itself, rather than waiting to be told.
 *
 * Both keys are otherwise typed into Settings and held in memory, which is
 * the right default for an override you set once and forget - but it means a
 * daemon restart is a daemon with no keys, and the developer typing the same
 * two secrets in again. A `.env` they wrote and own is not a forgotten
 * override; it is configuration, and Bench should read it.
 *
 * Two rules run through everything here.
 *
 * The first is that the file is *read*, never merged into `process.env`. A
 * `.env` usually holds more than Bench understands - the one that prompted
 * this carried an OpenAI key and a Gemini key alongside the two that matter -
 * and the daemon spreads its own environment into every specialist it spawns.
 * Merging would hand every secret in the file to every agent on the bench,
 * to no purpose. Only the two keys Bench actually authenticates with are
 * taken out.
 *
 * The second is that where a key came from is reported, not just that there
 * is one. A key that appears by itself is a key nobody can account for, and
 * "using the key ending …4f2a" is not an answer to "which key is that".
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isOauthToken } from "./anthropic-key.js";

/**
 * The names each key may go by.
 *
 * More than one apiece because these files are written by hand and there is
 * no single convention. OpenRouter is the worse of the two: its own docs say
 * `OPENROUTER_API_KEY`, but `OPEN_ROUTER_KEY` is what turned up in the file
 * that prompted this, and a reader that refuses the developer's own spelling
 * has not done the thing they asked for.
 */
const ANTHROPIC_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const ROUTER_NAMES = ["OPENROUTER_API_KEY", "OPEN_ROUTER_KEY", "OPENROUTER_KEY"] as const;

/** Where a key was found, so the cockpit can say. */
export type Origin =
  /** Typed into Settings. Beats everything, for as long as the daemon runs. */
  | { from: "settings" }
  /** Exported in the shell the daemon was started from. */
  | { from: "environment"; name: string }
  /** Read out of a file, which is named because there may be several. */
  | { from: "file"; name: string; path: string };

export interface Found {
  key: string;
  origin: Origin;
}

/**
 * Parse a `.env`.
 *
 * Hand-rolled rather than a dependency, because the format Bench needs is the
 * intersection everybody agrees on - `KEY=value`, comments, blank lines,
 * optional quotes, an optional `export` - and the parts people disagree about
 * (interpolation, multi-line values, escapes) have no business holding an API
 * key. A wrong answer here is a credential, so the narrow reading is the safe
 * one.
 *
 * A line that does not parse is skipped rather than thrown over. This file
 * belongs to the developer and may hold anything; refusing to start over a
 * line Bench does not care about would be Bench making its problem theirs.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const found: Record<string, string> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const at = line.indexOf("=");
    if (at <= 0) continue;

    // `export FOO=bar` is a .env people can also `source`, and it is common
    // enough that not reading it would look like the file was ignored.
    const name = line.slice(0, at).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    let value = line.slice(at + 1).trim();
    // A quoted value keeps whatever is inside it, including a `#` that would
    // otherwise read as a comment. An unquoted one stops at the first ` #`.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    if (value !== "") found[name] = value;
  }

  return found;
}

/** Read a `.env`, or nothing at all if it is not there or cannot be read. */
function readIfThere(path: string): Record<string, string> | null {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    // Missing is the ordinary case and says nothing. Unreadable is unusual
    // but is still not a reason to refuse to start: the developer can always
    // type the key in, which is what they were doing before this existed.
    return null;
  }
}

/**
 * Every place a `.env` is looked for, nearest first.
 *
 * `$BENCH_HOME` before the working directory because it is the daemon's own
 * home and saying something there is unambiguous, where a `.env` in whatever
 * directory you happened to launch from may belong to the project rather than
 * to Bench. The install root last, so a checkout's own file still works when
 * the daemon is started from somewhere else.
 */
export function envFilePaths(opts: {
  home: string;
  cwd?: string;
  installRoot?: string;
}): string[] {
  const dirs = [opts.home, opts.cwd ?? process.cwd(), opts.installRoot].filter(
    (dir): dir is string => typeof dir === "string" && dir !== "",
  );
  // The same directory reached two ways is one file, and reporting it twice
  // would make the precedence list look longer than it is.
  return [...new Set(dirs)].map((dir) => join(dir, ".env"));
}

/**
 * The two keys Bench can authenticate with, wherever they turn out to be.
 *
 * The real environment is consulted before any file, which is how every other
 * tool that reads a `.env` behaves: a variable someone exported deliberately
 * in this shell outranks one written down months ago. What is different here
 * is that the loser is not silently discarded - the winner says where it came
 * from, so a key nobody remembers setting can be traced rather than guessed
 * at.
 */
export function findCredentials(opts: {
  home: string;
  cwd?: string;
  installRoot?: string;
  /** The real environment. Injected so a test is not at the mercy of the
   * machine it runs on. */
  env?: NodeJS.ProcessEnv;
  /** Read a file, for the same reason. */
  read?: (path: string) => Record<string, string> | null;
}): { anthropic: Found | null; router: Found | null; searched: string[] } {
  const env = opts.env ?? process.env;
  const read = opts.read ?? readIfThere;
  const searched = envFilePaths(opts);

  const fromEnvironment = (names: readonly string[]): Found | null => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) return { key: value, origin: { from: "environment", name } };
    }
    return null;
  };

  const fromFiles = (names: readonly string[]): Found | null => {
    for (const path of searched) {
      const contents = read(path);
      if (contents === null) continue;
      for (const name of names) {
        const value = contents[name]?.trim();
        if (value) return { key: value, origin: { from: "file", name, path } };
      }
    }
    return null;
  };

  const pick = (names: readonly string[]) => fromEnvironment(names) ?? fromFiles(names);

  return { anthropic: pick(ANTHROPIC_NAMES), router: pick(ROUTER_NAMES), searched };
}

/**
 * How to say where a key came from, in one clause that finishes the sentence
 * "using the key ending …4f2a".
 *
 * The path is shortened against home because the full one is usually longer
 * than the rest of the sentence and the part that identifies it is the end.
 */
export function describeOrigin(origin: Origin): string {
  if (origin.from === "settings") return "typed here";
  if (origin.from === "environment") return `from ${origin.name} in this daemon's environment`;
  const home = homedir();
  const path = origin.path.startsWith(home + "/")
    ? "~" + origin.path.slice(home.length)
    : origin.path;
  return `from ${origin.name} in ${path}`;
}

/**
 * Whether an Anthropic credential found this way is safe to hand a specialist
 * as an API key rather than as an OAuth token.
 *
 * Re-exported here so callers reading a file do not have to know the rule,
 * which is that the two go on different headers and either one sent the wrong
 * way round comes back 401 - indistinguishable from a typo.
 */
export { isOauthToken };
