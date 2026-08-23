import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Ref {
  number: number;
  title: string;
  url: string;
  kind: "issue" | "pull";
}

/** A line in the drawer: what it is, where it stands, when it last moved. */
export interface Item extends Ref {
  state: string;
  updatedAt: string;
  author: string;
  draft?: boolean;
}

/**
 * `#12` is not a fact about the world - it is a fact about one repository, and
 * a specialist working on teledoctor means teledoctor's twelfth issue. So the
 * slug is read from the project the session belongs to, never guessed.
 *
 * Both remote spellings, and the trailing .git that only sometimes appears.
 */
export function parseSlug(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+)$/.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/** How a reference is resolved. Injected so the tests never touch a network. */
export type Resolver = (slug: string, number: number) => Promise<Ref | null>;

/**
 * Asks the GitHub CLI rather than the API directly: it already holds the
 * developer's credentials, which is what makes this work on a private repo.
 * The issues endpoint answers for pull requests too - a pull request is an
 * issue there - so one call covers both, and `html_url` comes back pointing
 * at whichever it turned out to be.
 */
export const resolveWithGh: Resolver = async (slug, number) => {
  try {
    const { stdout } = await run("gh", [
      "api", `repos/${slug}/issues/${number}`,
      "--jq", "{title: .title, url: .html_url, pull: (.pull_request != null)}",
    ], { timeout: 5000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.title !== "string" || typeof parsed?.url !== "string") return null;
    return { number, title: parsed.title, url: parsed.url, kind: parsed.pull ? "pull" : "issue" };
  } catch {
    // No gh, no network, no such issue, private repo the developer cannot see:
    // all the same answer here. The thread still renders, without a title.
    return null;
  }
};

/**
 * Resolved references, remembered.
 *
 * A thread is re-rendered on every roster tick, and the numbers in it do not
 * change - so without a cache this would be a GitHub request per mention per
 * second. Titles do change, rarely, which is what the age check is for.
 */
/** The GitHub side of a project, as the drawer needs it. Injected whole so
 * the tests never shell out. */
export type Lister = (slug: string, limit: number) => Promise<Item[]>;

/* `isDraft` exists on a pull request and not on an issue, and `gh` rejects
 * the whole call for one unknown field rather than ignoring it - which is
 * how the issues half came back empty while looking like a repo with none. */
const FIELDS = "number,title,url,state,updatedAt,author";

/**
 * Recent issues and pull requests, newest movement first.
 *
 * Two calls rather than one search, because `gh issue list` and `gh pr list`
 * take the same flags and answer with the same shape - and a search query
 * would have to be spelled differently for each anyway. They run together;
 * the slower of the two is the wait.
 *
 * Sorted by when each last moved rather than when it was opened: a two-week
 * old issue commented on this morning is the one you are looking for.
 */
export const listWithGh: Lister = async (slug, limit) => {
  const one = async (kind: "issue" | "pr"): Promise<Item[]> => {
    try {
      const { stdout } = await run("gh", [
        kind, "list", "--repo", slug,
        "--state", "all", "--limit", String(limit),
        "--json", kind === "pr" ? `${FIELDS},isDraft` : FIELDS,
      ], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });

      return (JSON.parse(stdout) as Array<Record<string, any>>).map((raw) => ({
        number: Number(raw.number),
        title: String(raw.title ?? ""),
        url: String(raw.url ?? ""),
        kind: kind === "pr" ? "pull" : "issue",
        state: String(raw.state ?? "").toLowerCase(),
        updatedAt: String(raw.updatedAt ?? ""),
        author: String(raw.author?.login ?? ""),
        ...(kind === "pr" ? { draft: raw.isDraft === true } : {}),
      }));
    } catch {
      // No gh, no network, no permission: an empty half rather than an error.
      // Half a drawer is worth more than a message saying there is none.
      return [];
    }
  };

  const byMovement = (a: Item, b: Item) => b.updatedAt.localeCompare(a.updatedAt);
  const [issues, pulls] = await Promise.all([one("issue"), one("pr")]);
  issues.sort(byMovement);
  pulls.sort(byMovement);

  // Half each rather than the newest N overall. On a repository going through
  // a run of pull requests, a straight recency cut buries every issue - and
  // the drawer shows the two apart, so one empty half would look like a repo
  // with no issues at all. Whichever side is short gives its room to the
  // other.
  const half = Math.ceil(limit / 2);
  const forPulls = Math.min(pulls.length, Math.max(half, limit - issues.length));
  const forIssues = Math.min(issues.length, limit - forPulls);
  return [...pulls.slice(0, forPulls), ...issues.slice(0, forIssues)].sort(byMovement);
};

/** Where a project's slug comes from. Injected so the tests never shell out. */
export type SlugReader = (project: string) => Promise<string | null>;

export const slugFromGit: SlugReader = async (project) => {
  try {
    const { stdout } = await run("git", ["-C", project, "remote", "get-url", "origin"], {
      timeout: 5000,
    });
    return parseSlug(stdout);
  } catch {
    // A project with no origin has no issues to point at.
    return null;
  }
};

export class RefIndex {
  private slugs = new Map<string, string | null>();
  private refs = new Map<string, { ref: Ref | null; at: number }>();

  private lists = new Map<string, { items: Item[]; at: number }>();

  private readonly resolve: Resolver;
  private readonly list: Lister;
  private readonly readSlug: SlugReader;
  private readonly maxAgeMs: number;
  private readonly listMaxAgeMs: number;
  private readonly now: () => number;

  constructor(opts: {
    resolve?: Resolver;
    list?: Lister;
    readSlug?: SlugReader;
    maxAgeMs?: number;
    listMaxAgeMs?: number;
    now?: () => number;
  } = {}) {
    this.resolve = opts.resolve ?? resolveWithGh;
    this.list = opts.list ?? listWithGh;
    this.readSlug = opts.readSlug ?? slugFromGit;
    this.maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000;
    // Far shorter than a title's: the drawer is a "what has been happening"
    // view, and one that is ten minutes stale is answering the wrong question.
    this.listMaxAgeMs = opts.listMaxAgeMs ?? 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** Everything the drawer shows: recent issues and pull requests, or an
   * empty list for a project GitHub knows nothing about. */
  async recent(project: string, limit = 25): Promise<{ slug: string | null; items: Item[] }> {
    const slug = await this.slugFor(project);
    if (!slug) return { slug: null, items: [] };

    const cached = this.lists.get(slug);
    if (cached && this.now() - cached.at < this.listMaxAgeMs) {
      return { slug, items: cached.items };
    }

    const items = await this.list(slug, limit);
    this.lists.set(slug, { items, at: this.now() });
    return { slug, items };
  }

  private async slugFor(project: string): Promise<string | null> {
    const known = this.slugs.get(project);
    if (known !== undefined) return known;

    const slug = await this.readSlug(project);
    this.slugs.set(project, slug);
    return slug;
  }

  /** Only what resolved. A number with no answer is simply absent, and the
   * client renders it as the text it already was. */
  async lookup(project: string, numbers: number[]): Promise<Ref[]> {
    const slug = await this.slugFor(project);
    if (!slug) return [];

    const wanted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0);
    const found = await Promise.all(wanted.map(async (number) => {
      const key = `${slug}#${number}`;
      const cached = this.refs.get(key);
      if (cached && this.now() - cached.at < this.maxAgeMs) return cached.ref;

      const ref = await this.resolve(slug, number);
      // Failures are cached too, or every render retries a number that will
      // never resolve.
      this.refs.set(key, { ref, at: this.now() });
      return ref;
    }));

    return found.filter((ref): ref is Ref => ref !== null);
  }
}
