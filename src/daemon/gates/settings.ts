/**
 * Built per session and passed to `claude --settings '<json>'`, so gates
 * never live in the repo being worked on and a project cannot remove them.
 * Hooks are additive, which is why loading project settings alongside these
 * is safe: a project can add hooks, never delete one of ours.
 */

/**
 * A specialist has full control of its shell.
 *
 * It ran behind an allowlist for a while, and every line of that list was
 * added because the list itself had blocked something the work needed: it
 * could write code and not build it, build it and not look at it, find a bug
 * and not file it, finish a branch and not push it. Each gap was discovered
 * the same way - by a specialist reporting that it could not do its job.
 *
 * The last of them made the case. `git push` was denied on the grounds that a
 * specialist proposes and the developer publishes, and it held nothing: `gh
 * pr create` shells out to git and never passes through this layer, so the
 * honest path was blocked while the one that worked went round it. What it
 * did do was strand three commits in a worktree and leave a specialist
 * reporting them as pushed.
 *
 * A specialist runs non-interactively, so a permission prompt has nobody to
 * answer it and is refused outright - a denial is final and unexplained. The
 * containment that matters is elsewhere and still holds: it works in its own
 * worktree on its own branch, it cannot merge its own pull request, and the
 * attribution hook below is evaluated regardless of permissions.
 */
const FULL_SHELL = ["Bash(*)"];

export function buildSettings(opts: { hookCommand: string }): object {
  return {
    permissions: {
      allow: FULL_SHELL,
      deny: [],
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

/**
 * The same gate for a Devin specialist, in Devin's own hooks format. Devin
 * reads hooks from the worktree rather than from a command-line flag, so
 * `DevinSession` writes this to `<worktree>/.devin/hooks.v1.json` - a file
 * whose whole content is the hooks object, no wrapper key (see the Devin
 * CLI's hooks docs). The matcher is a regex on `tool_name` and Devin's shell
 * tool is `exec`; the payload and the `hookSpecificOutput` decision shape are
 * the ones bench-hook already reads and writes.
 */
export function buildDevinHooks(opts: { hookCommand: string }): object {
  return {
    PreToolUse: [
      {
        matcher: "exec",
        hooks: [{ type: "command", command: `${opts.hookCommand} commit-attribution` }],
      },
    ],
  };
}
