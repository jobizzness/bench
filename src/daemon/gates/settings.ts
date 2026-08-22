/**
 * Built per session and passed to `claude --settings '<json>'`, so gates
 * never live in the repo being worked on and a project cannot remove them.
 * Hooks are additive, which is why loading project settings alongside these
 * is safe: a project can add hooks, never delete one of ours.
 */
/**
 * A specialist runs non-interactively, so a permission prompt has nobody to
 * answer it and is refused outright. `acceptEdits` covers writing code and
 * nothing else, which left specialists able to write a change and unable to
 * build it, test it or verify a single line of it - while the report they
 * are asked to write is built around a Verified list.
 *
 * These are the commands that turn a change into a verified one. Hooks are
 * evaluated regardless of permissions, so the attribution gate still denies
 * a commit this list would otherwise allow.
 */
const TOOLCHAIN = [
  "pnpm", "npm", "npx", "yarn", "bun",
  "node", "tsc", "vitest", "jest",
  "make", "cargo", "go", "python", "python3", "pytest", "uv", "ruff",
  "git",
  // A specialist doing UI work has to be able to look at it. jsdom cannot
  // tell you what a layout does, which has already cost one bug here.
  "google-chrome", "google-chrome-stable", "chromium",
].map((cmd) => `Bash(${cmd}:*)`);

export function buildSettings(opts: { hookCommand: string }): object {
  return {
    permissions: {
      allow: TOOLCHAIN,
      // Publishing is not a build step. A specialist works on a disposable
      // branch in its own worktree; putting that branch on a remote is the
      // developer's call, not part of verifying a change.
      deny: ["Bash(git push:*)"],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `${opts.hookCommand} commit-attribution` }],
        },
      ],
    },
  };
}
