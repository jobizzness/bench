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
].map((cmd) => `Bash(${cmd}:*)`);

/**
 * A worktree borrows the main checkout's node_modules by symlink rather than
 * installing its own, so every one of these writes through that link into the
 * developer's repo - silently upgrading packages its lockfile still pins, and
 * leaving two specialists to fight over one tree. Denied outright: adding a
 * dependency is the developer's call, and the specialist should say it needs
 * one rather than reach for it.
 */
const DEPENDENCY_COMMANDS = [
  "pnpm add", "pnpm install", "pnpm remove", "pnpm update", "pnpm link",
  "npm install", "npm i", "npm uninstall", "npm ci", "npm update",
  "yarn add", "yarn install", "yarn remove", "yarn upgrade",
  "bun add", "bun install", "bun remove", "bun update",
].map((cmd) => `Bash(${cmd}:*)`);

export function buildSettings(opts: { hookCommand: string }): object {
  return {
    permissions: {
      allow: TOOLCHAIN,
      // Publishing is not a build step. Putting a branch on a remote is the
      // developer's call, not part of verifying a change - and all the more so
      // for a specialist working directly in the developer's own checkout.
      deny: ["Bash(git push:*)", ...DEPENDENCY_COMMANDS],
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
