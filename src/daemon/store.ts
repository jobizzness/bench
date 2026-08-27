import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Spend } from "../shared/types.js";
import type { NudgeState } from "../shared/nudge.js";

/**
 * The index is on disk but unreadable. Thrown rather than swallowed: every
 * specialist is still there, and the one thing that could lose them for good
 * is writing over a file we could not parse.
 */
export class CorruptIndex extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`the specialist index at ${path} could not be read: ${detail}`);
    this.name = "CorruptIndex";
  }
}

/**
 * What has to survive the daemon. Threads and reports already live with the
 * project and the worktree is on disk; what was lost on every restart was
 * the roster - the fact that a specialist exists at all, and where.
 */
export interface SessionRecord {
  id: string;
  label: string;
  /** Absent on every record written before roles existed; those are
   * specialists, which is what they have always been. */
  role?: string;
  /** How full the conversation was when it last finished a turn. Kept so a
   * cold specialist can still say whether it is worth reviving. */
  context?: { used: number; window: number };
  /** Which models actually answered the last finished turn, on a specialist
   * running a router rather than a model. Kept for the same reason as
   * `context`: a cold specialist on an auto router should still be able to
   * say what it last ran on without being prompted first. */
  answeredBy?: string[];
  /** What it has cost so far. Kept on disk because it is cumulative: held in
   * memory only, a restart would report every specialist as free. */
  spend?: Spend;
  /** The worst context tone, and whether the spend threshold, this
   * specialist has already been told about. Kept on disk so a restart does
   * not repeat a nudge that was already given - the whole point of only
   * saying it once. */
  nudged?: NudgeState;
  project: string;
  worktree: string;
  /** Recorded rather than derived: the branch name is not recoverable from
   * the label, and guessing it is how the wrong branch gets deleted. */
  branch: string;
  reportsDir: string;
  model: string;
  port: number;
  createdAt: string;
  /**
   * Whether the CLI holds a conversation for this specialist yet. Absent
   * means no: a specialist created and never prompted has nothing to resume,
   * and asking the CLI to resume one anyway kills it on the spot.
   */
  resumable?: boolean;
  /**
   * Whether the specialist got a worktree of its own. When it did not,
   * `worktree` is the project checkout itself and `branch` is whatever the
   * developer had checked out - neither is Bench's to remove.
   *
   * Optional because every record written before the toggle existed was
   * isolated; absent means true.
   */
  isolated?: boolean;
}

const REQUIRED = ["id", "label", "project", "worktree", "reportsDir", "model"] as const;

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  return REQUIRED.every((key) => typeof (value as Record<string, unknown>)[key] === "string");
}

/**
 * A JSON array of specialists, rewritten whole on every change. The file is
 * small and written rarely - once per created specialist - so the simplest
 * thing that cannot half-update is the right one.
 */
export class SessionStore {
  constructor(private readonly home: string) {}

  private get path(): string {
    return join(this.home, "sessions.json");
  }

  async all(): Promise<SessionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      // No index yet. An empty bench is the truth on a first run.
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("the index is not a list");
      return parsed.filter(isRecord);
    } catch (error) {
      // This used to return an empty list, on the grounds that a corrupt
      // index must never stop the daemon starting. That was the wrong trade
      // and it cost a developer their whole roster: every specialist vanished
      // from the cockpit, and the next write would have overwritten the file
      // with one record and made it permanent.
      //
      // An index that cannot be read is not an index that says nothing. It
      // throws, and `put` and `remove` therefore refuse rather than write over
      // what they could not read.
      throw new CorruptIndex(this.path, String(error));
    }
  }

  /**
   * Changes run one at a time.
   *
   * Every one of them is a read, a small modification and a write of the
   * whole file, and two of those overlapping lose one of the two changes -
   * the second read happens before the first write, so it modifies a copy
   * that is already out of date. The daemon does exactly this at the end of
   * every turn: the context number and the resumable flag are written from
   * the same tick.
   */
  private pending: Promise<unknown> = Promise.resolve();
  /** Counts writes, so no two temp files in this process share a name. */
  private writes = 0;

  private change<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work, work);
    // The chain has to survive a failure, or one bad write stops every write
    // after it for the life of the daemon.
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  async put(record: SessionRecord): Promise<void> {
    return this.change(async () => {
      const rest = (await this.all()).filter((r) => r.id !== record.id);
      await this.write([...rest, record]);
    });
  }

  /**
   * Drop the conversation the CLI was holding, so the next prompt starts
   * fresh rather than resuming it.
   *
   * Clearing the context is the one thing the developer can do about a
   * conversation near its window, and the record has to mean "there is
   * nothing to resume" from the moment it is written: a restart in between
   * must not quietly bring the old conversation back.
   */
  async forgetConversation(id: string): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.resumable = false;
      delete record.context;
      await this.write(all);
    });
  }

  /**
   * Recorded when a turn ends rather than when one starts. A turn that never
   * finished may have left no conversation behind, and the record has to mean
   * "there is something to resume", not "we tried".
   */
  async markResumable(id: string): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record || record.resumable) return;
      record.resumable = true;
      await this.write(all);
    });
  }

  /**
   * How full the conversation was at the end of a turn. Written every turn
   * rather than at close, because the case it exists for is a cold specialist
   * on a cockpit that has just started: whether it is worth reviving is not a
   * question you should have to prompt it to answer.
   */
  async rememberContext(id: string, context: { used: number; window: number }): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.context = context;
      await this.write(all);
    });
  }

  /** Which models answered a router's last turn. Written alongside context,
   * for the same cold-specialist reason. */
  async rememberAnsweredBy(id: string, answeredBy: string[]): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.answeredBy = answeredBy;
      await this.write(all);
    });
  }

  /** What this specialist has already been told about its own context and
   * spend, so a restart does not say it again. */
  async rememberNudged(id: string, nudged: NudgeState): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.nudged = nudged;
      await this.write(all);
    });
  }

  /** What the specialist has cost, after a turn has been added to it. Kept
   * for the same reason as the context above: a cold roster should be able to
   * say what a specialist has run up without prompting it. */
  async rememberSpend(id: string, spend: Spend): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.spend = spend;
      await this.write(all);
    });
  }

  /**
   * What it runs on, changed after it was made.
   *
   * Written rather than held in memory because the model is what a revived
   * specialist is spawned with: a change that did not survive a restart would
   * quietly put the specialist back on the model you moved it off.
   */
  async remodel(id: string, model: string): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.model = model;
      await this.write(all);
    });
  }

  /** What it is called, which is not what its branch is called. */
  async rename(id: string, label: string): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.label = label;
      await this.write(all);
    });
  }

  /** What kind of agent it is, which survives the daemon that was told. */
  async reroute(id: string, role: string): Promise<void> {
    return this.change(async () => {
      const all = await this.all();
      const record = all.find((r) => r.id === id);
      if (!record) return;
      record.role = role;
      await this.write(all);
    });
  }

  async remove(id: string): Promise<void> {
    return this.change(async () => {
      await this.write((await this.all()).filter((r) => r.id !== id));
    });
  }

  /**
   * Written to one side and renamed into place.
   *
   * `writeFile` truncates and then writes, so two daemons sharing a home can
   * interleave inside that gap: one file ended up as a short array followed
   * by the tail of a longer one, which parsed as nothing and emptied a whole
   * cockpit. A rename is atomic - a reader sees the old file or the new one,
   * and two writers cannot produce a third thing that is neither.
   */
  private async write(records: SessionRecord[]): Promise<void> {
    await mkdir(this.home, { recursive: true });
    // Named for this process and this write. Naming it for the process alone
    // moved the collision rather than fixing it: two writes from one daemon
    // opened the same temp file, interleaved inside it, and the winner then
    // renamed that mess into place - atomically, which is the one thing that
    // made it worse. The loser found nothing left to rename and took the
    // daemon down with it.
    const temp = `${this.path}.${process.pid}.${++this.writes}.tmp`;
    await writeFile(temp, JSON.stringify(records, null, 2) + "\n");
    try {
      await rename(temp, this.path);
    } catch (error) {
      // Nothing landed, so nothing should be left lying beside the index.
      await rm(temp, { force: true });
      throw error;
    }
  }
}
