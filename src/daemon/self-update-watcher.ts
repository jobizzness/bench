import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { updateAction, type SelfUpdateStatus } from "../shared/self-update.js";

/** How a git command is run. Injected so the tests never shell out to a real
 * repository - the same reasoning as `key-sync.ts`'s `check`/`usageOf`. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>;

export const execGit: GitRunner = async (args, cwd) => {
  const { stdout } = await promisify(execFile)("git", args, { cwd, timeout: 20_000 });
  return { stdout };
};

const RESTING: SelfUpdateStatus = { action: { kind: "none" }, fetchError: null };

/**
 * Whether Bench's own checkout is behind its remote, dirty, or has moved
 * past the commit the daemon booted from - modelled on `KeySync`: a class
 * holding its own interval, with `setIntervalImpl` injected so tests do not
 * wait five minutes.
 *
 * `headSha` and `dirty` are read with plain, local git calls and are always
 * trustworthy; `behind` and `fastForward` depend on `git fetch` reaching
 * origin and are left at their last good values (see `RESTING`) when it
 * cannot - `fetchError` is what says so, so the cockpit never mistakes "the
 * network is down" for "you are level with origin".
 */
export class SelfUpdateWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private status: SelfUpdateStatus = RESTING;
  private lastPushed = "";

  private readonly root: string;
  private readonly bootSha: string;
  private readonly branch: string;
  private readonly onChange: () => void;
  private readonly git: GitRunner;
  private readonly intervalMs: number;
  private readonly log: (line: string) => void;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;

  constructor(deps: {
    root: string;
    bootSha: string;
    branch: string;
    /** Called once, synchronously, every time `current()` would return
     * something new - the daemon's cue to push the roster again. */
    onChange: () => void;
    git?: GitRunner;
    intervalMs?: number;
    log?: (line: string) => void;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
  }) {
    this.root = deps.root;
    this.bootSha = deps.bootSha;
    this.branch = deps.branch;
    this.onChange = deps.onChange;
    this.git = deps.git ?? execGit;
    this.intervalMs = deps.intervalMs ?? 5 * 60_000;
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.setIntervalImpl = deps.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  }

  current(): SelfUpdateStatus {
    return this.status;
  }

  start(): void {
    this.stop();
    void this.tick();
    this.timer = this.setIntervalImpl(() => { void this.tick(); }, this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  /** One pass. Overlapping calls - the interval landing while a tick is
   * still waiting on git - share the in-flight one, the same rule
   * `KeySync.tick` follows. */
  tick(): Promise<void> {
    this.inFlight ??= this.run()
      .catch((error) => this.log(`bench: self-update watcher: ${this.message(error)}`))
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const headSha = (await this.git(["rev-parse", "HEAD"], this.root)).stdout.trim();
    // `--untracked-files=no` - kept identical to the check `runSelfUpdate`
    // itself makes (see #149), so `dirty` here never disagrees with what the
    // route would actually do.
    const statusOut = (await this.git(["status", "--porcelain", "--untracked-files=no"], this.root)).stdout;
    const dirty = statusOut.trim() !== "";

    let behind = this.behindOf(this.status);
    let fastForward = this.fastForwardOf(this.status);
    let fetchError: string | null = null;
    try {
      await this.git(["fetch", "--quiet", "origin", this.branch], this.root);
      const count = (await this.git(["rev-list", "--count", `HEAD..origin/${this.branch}`], this.root)).stdout.trim();
      behind = Number(count) || 0;
      fastForward = await this.isAncestor(headSha, `origin/${this.branch}`);
    } catch (error) {
      fetchError = this.message(error);
    }

    this.report({
      action: updateAction({ behind, dirty, fastForward, bootSha: this.bootSha, headSha }),
      fetchError,
    });
  }

  private async isAncestor(commit: string, of: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", commit, of], this.root);
      return true;
    } catch {
      return false;
    }
  }

  /** The `behind`/`fastForward` a `blocked` or `update` action was last
   * computed from - kept only so a fetch failure holds its ground rather
   * than silently resetting to "level with origin". A `restart` or `none`
   * action carries neither, so those fall back to "level". */
  private behindOf(status: SelfUpdateStatus): number {
    return status.action.kind === "update" ? status.action.behind : 0;
  }

  private fastForwardOf(status: SelfUpdateStatus): boolean {
    return status.action.kind !== "blocked" || status.action.reason !== "diverged";
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private report(next: SelfUpdateStatus): void {
    const key = JSON.stringify(next);
    if (key === this.lastPushed) return;
    this.lastPushed = key;
    this.status = next;
    this.onChange();
  }
}
