import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Ref {
  number: number;
  title: string;
  url: string;
  kind: "issue" | "pull";
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

  private readonly resolve: Resolver;
  private readonly readSlug: SlugReader;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(opts: {
    resolve?: Resolver;
    readSlug?: SlugReader;
    maxAgeMs?: number;
    now?: () => number;
  } = {}) {
    this.resolve = opts.resolve ?? resolveWithGh;
    this.readSlug = opts.readSlug ?? slugFromGit;
    this.maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? Date.now;
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
