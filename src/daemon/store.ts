import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What has to survive the daemon. Threads and reports already live with the
 * project and the worktree is on disk; what was lost on every restart was
 * the roster - the fact that a specialist exists at all, and where.
 */
export interface SessionRecord {
  id: string;
  label: string;
  project: string;
  worktree: string;
  /** Recorded rather than derived: the branch name is not recoverable from
   * the label, and guessing it is how the wrong branch gets deleted. */
  branch: string;
  reportsDir: string;
  model: string;
  port: number;
  createdAt: string;
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
      return [];
    }

    // A corrupt index must never stop the daemon starting. Losing the roster
    // is recoverable; refusing to boot is not.
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  async put(record: SessionRecord): Promise<void> {
    const rest = (await this.all()).filter((r) => r.id !== record.id);
    await this.write([...rest, record]);
  }

  async remove(id: string): Promise<void> {
    await this.write((await this.all()).filter((r) => r.id !== id));
  }

  private async write(records: SessionRecord[]): Promise<void> {
    await mkdir(this.home, { recursive: true });
    await writeFile(this.path, JSON.stringify(records, null, 2));
  }
}
