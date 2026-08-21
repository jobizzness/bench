/**
 * Built per session and passed to `claude --settings '<json>'`, so gates
 * never live in the repo being worked on and a project cannot remove them.
 * Hooks are additive, which is why loading project settings alongside these
 * is safe: a project can add hooks, never delete one of ours.
 */
export function buildSettings(opts: { hookCommand: string }): object {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `${opts.hookCommand} commit-attribution` }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: `${opts.hookCommand} report-required` }],
        },
      ],
    },
  };
}
